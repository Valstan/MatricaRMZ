import { app } from 'electron';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { logMessage } from './logService.js';

// Chromium молча уходит на программный растеризатор (SwiftShader), когда драйвер
// в блэклисте или GPU-процесс не поднялся — внешне это «просто тормозит». Сводка
// ниже едет в локальный `matricarmz.log`, а на программном рендеринге ещё и warn'ом
// до серверных `client-*.log`, то есть слабые машины парка видны без обхода по цеху.

export type GpuVerdict = {
  accelerated: boolean;
  software: boolean;
  compositing: string;
  rasterization: string;
  webgl: string;
  device: string;
  driver: string;
  summary: string;
};

type GpuFeatureStatusLike = Record<string, unknown>;
type GpuDeviceLike = Record<string, unknown>;
type GpuInfoLike = { gpuDevice?: unknown };

const SOFTWARE_MARK = 'software';

function featureString(features: GpuFeatureStatusLike, key: string): string {
  const v = features[key];
  return typeof v === 'string' && v.trim() ? v.trim() : 'unknown';
}

function firstDevice(info: GpuInfoLike): GpuDeviceLike | null {
  const list = Array.isArray(info.gpuDevice) ? info.gpuDevice : [];
  const devices = list.filter((d): d is GpuDeviceLike => Boolean(d) && typeof d === 'object');
  return devices.find((d) => d.active === true) ?? devices[0] ?? null;
}

/**
 * Чистая сводка «рисует ли эта машина видеокартой» по данным Chromium.
 * Аппаратный путь — это `enabled` у композитинга без пометки `software` у фич:
 * SwiftShader помечен словом software, а честное «отключено» (`disabled_off`) — нет.
 */
export function summarizeGpu(featuresRaw: unknown, infoRaw: unknown): GpuVerdict {
  const features =
    featuresRaw && typeof featuresRaw === 'object' ? (featuresRaw as GpuFeatureStatusLike) : {};
  const info = infoRaw && typeof infoRaw === 'object' ? (infoRaw as GpuInfoLike) : null;
  const compositing = featureString(features, 'gpu_compositing');
  const rasterization = featureString(features, 'rasterization');
  const webgl = featureString(features, 'webgl');
  const software = [compositing, rasterization, webgl].some((s) => s.includes(SOFTWARE_MARK));
  const accelerated = !software && compositing === 'enabled';
  const device = info ? firstDevice(info) : null;
  const deviceString = typeof device?.deviceString === 'string' ? device.deviceString.trim() : '';
  const driverVendor = typeof device?.driverVendor === 'string' ? device.driverVendor.trim() : '';
  const driverVersion = typeof device?.driverVersion === 'string' ? device.driverVersion.trim() : '';
  const driver = [driverVendor, driverVersion].filter(Boolean).join(' ');
  const summary =
    `accelerated=${accelerated ? 'yes' : 'no'} compositing=${compositing}` +
    ` rasterization=${rasterization} webgl=${webgl}` +
    (deviceString ? ` device="${deviceString}"` : '') +
    (driver ? ` driver="${driver}"` : '');
  return {
    accelerated,
    software,
    compositing,
    rasterization,
    webgl,
    device: deviceString,
    driver,
    summary,
  };
}

export async function collectGpuVerdict(): Promise<GpuVerdict> {
  let features: unknown = null;
  let info: unknown = null;
  try {
    features = app.getGPUFeatureStatus();
  } catch {
    features = null;
  }
  try {
    info = await app.getGPUInfo('basic');
  } catch {
    info = null;
  }
  return summarizeGpu(features, info);
}

export type GpuDiagnosticsArgs = {
  db: BetterSQLite3Database;
  apiBaseUrl: string;
  log?: (message: string) => void;
};

// Один warn на состояние за процесс: стартовый снимок и падение GPU-процесса
// могут дать ту же сводку — второй раз она не нужна.
const warnedSummaries = new Set<string>();

export function reportGpuStatus(args: GpuDiagnosticsArgs): void {
  void collectGpuVerdict()
    .then((verdict) => {
      args.log?.(`gpu: ${verdict.summary}`);
      if (verdict.accelerated) return;
      if (warnedSummaries.has(verdict.summary)) return;
      warnedSummaries.add(verdict.summary);
      void logMessage(
        args.db,
        args.apiBaseUrl,
        'warn',
        `gpu: hardware acceleration unavailable - ${verdict.summary}`,
        { component: 'gpu' },
      ).catch(() => undefined);
    })
    .catch(() => undefined);
}

export function watchGpuProcessGone(args: GpuDiagnosticsArgs): void {
  app.on('child-process-gone', (_event, details) => {
    if (String(details?.type ?? '') !== 'GPU') return;
    const reason = String(details?.reason ?? 'unknown');
    if (reason === 'clean-exit') return;
    const line = `gpu process gone: reason=${reason} exitCode=${details?.exitCode ?? 'unknown'}`;
    args.log?.(line);
    void logMessage(args.db, args.apiBaseUrl, 'warn', line, { component: 'gpu' }).catch(
      () => undefined,
    );
    // После падения GPU-процесса Chromium может перейти на программный рендеринг:
    // свежий снимок скажет, куда он ушёл.
    reportGpuStatus(args);
  });
}

export function startGpuDiagnostics(args: GpuDiagnosticsArgs): void {
  // GPU-процесс поднимается не мгновенно, а ранний снимок соврал бы «unknown».
  setTimeout(() => reportGpuStatus(args), 5_000);
  watchGpuProcessGone(args);
}
