import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { app } from 'electron';

import {
  MATRICA_ROOT_CA_SUBJECT,
  MATRICA_ROOT_CA_THUMBPRINT,
  trustRootNoticeDecision,
  type TrustRootStatus,
  type TrustStoreState,
} from '@matricarmz/shared';

/**
 * Корень доверия Матрицы на стороне клиента: опрос машины, тихая установка в профиль
 * пользователя и повышенная установка в машинные хранилища (ADR-0003).
 *
 * Почему так разделено:
 *
 * - Служба Касперского работает от SYSTEM и читает ТОЛЬКО машинные хранилища
 *   сертификатов. Корень в профиле пользователя она не увидит — поэтому «доверие по подписи»
 *   закрывается только машинным хранилищем, и это шаг человека с правами администратора.
 * - Пользовательское хранилище программа закрывает САМА: это не требует прав админа
 *   и даёт Windows доверие к подписи у конкретного оператора (правильный издатель в UAC
 *   вместо «Неизвестный издатель»).
 * - Настройку Касперского (вкладка «Доверенное системное хранилище сертификатов») программно
 *   включить нельзя: Самозащита блокирует правку конфигурации извне. Этот шаг остаётся
 *   человеком, и программа честно говорит об этом, а не делает вид, что всё закрыто.
 */

const PROBE_SCRIPT = 'trust-root-probe.ps1';
const INSTALL_SCRIPT = 'install-root-on-machine.ps1';

/** Сколько ждём опроса машины. Опрос — чтение пяти хранилищ, он быстрый. */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Установка в машинное хранилище идёт МЕДЛЕННО: Windows проверяет доверие нового корня
 * (замерено 45–207 секунд на первом install). Это не зависание, поэтому окно ожидания
 * большое — обрывать установку на середине хуже, чем подождать.
 */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

export type TrustRootInstallScope = 'user' | 'machine';

export type TrustRootInstallResult = {
  ok: boolean;
  /** Человекочитаемая причина — её показываем оператору как есть. */
  error: string | null;
  /** Сколько заняло. */
  durationMs: number;
};

function resourceCandidates(name: string): string[] {
  const out: string[] = [];
  // Собранный клиент: файлы лежат прямо в resources (их кладёт electron-builder).
  const resources = process.resourcesPath;
  if (resources) out.push(join(resources, name));
  // Разработка: app.getAppPath() — каталог пакета electron-app, от него и считаем.
  // Через cwd нельзя: pnpm запускает dev из electron-app, а скрипты лежат в scripts/signing
  // уровнем выше (а каталог сборки — build/trust рядом с пакетом).
  const appPath = app.getAppPath();
  if (appPath) {
    out.push(join(appPath, 'build', 'trust', name));
    out.push(join(appPath, '..', 'build', 'trust', name));
    out.push(join(appPath, '..', 'scripts', 'signing', name));
  }
  const cwd = process.cwd();
  out.push(join(cwd, 'electron-app', 'build', 'trust', name));
  out.push(join(cwd, 'build', 'trust', name));
  out.push(join(cwd, 'scripts', 'signing', name));
  return out;
}

function findAsset(name: string): string | null {
  return resourceCandidates(name).find((p) => existsSync(p)) ?? null;
}

type PowerShellResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

function runPowerShell(scriptPath: string, scriptArgs: string[], timeoutMs: number): Promise<PowerShellResult> {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...scriptArgs],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || String(e), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** JSON от пробы берём из последней строки, которая на него похожа: PowerShell может дописать свой вывод. */
function parseProbeJson(stdout: string): Record<string, unknown> | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{') && l.endsWith('}'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      // пробуем следующую строку
    }
  }
  return null;
}

function unknownStatus(probeError: string): TrustRootStatus {
  return {
    platform: process.platform === 'win32' ? 'win32' : 'other',
    rootSubject: MATRICA_ROOT_CA_SUBJECT,
    rootThumbprint: MATRICA_ROOT_CA_THUMBPRINT,
    stores: [],
    machineTrusted: false,
    userTrusted: false,
    executableSigned: false,
    signatureChainToMatrica: false,
    signatureTrusted: false,
    signerSubject: null,
    probeError,
  };
}

function statusFromProbe(json: Record<string, unknown>): TrustRootStatus {
  const rawStores = Array.isArray(json.stores) ? json.stores : [];
  const stores: TrustStoreState[] = rawStores.map((raw) => {
    const s = raw as { location?: string; name?: string; present?: boolean };
    return {
      location: s.location === 'LocalMachine' ? 'LocalMachine' : 'CurrentUser',
      name: s.name === 'Trust' ? 'Trust' : s.name === 'TrustedPublisher' ? 'TrustedPublisher' : 'Root',
      present: Boolean(s.present),
    };
  });
  return {
    platform: 'win32',
    rootSubject: typeof json.rootSubject === 'string' ? json.rootSubject : MATRICA_ROOT_CA_SUBJECT,
    rootThumbprint: typeof json.thumbprint === 'string' ? json.thumbprint : MATRICA_ROOT_CA_THUMBPRINT,
    stores,
    machineTrusted: Boolean(json.machineTrusted),
    userTrusted: Boolean(json.userTrusted),
    executableSigned: Boolean(json.executableSigned),
    signatureChainToMatrica: Boolean(json.signatureChainToMatrica),
    signatureTrusted: Boolean(json.signatureTrusted),
    signerSubject: typeof json.signerSubject === 'string' ? json.signerSubject : null,
    probeError: null,
  };
}

let cached: { status: TrustRootStatus; at: number } | null = null;
let inFlight: Promise<TrustRootStatus> | null = null;

/** Кэш короткий: состояние машины меняется медленно, но «поставили корень» должно быть видно сразу. */
const CACHE_TTL_MS = 30_000;

/**
 * Опросить машину: где лежит корень и подписан ли текущий EXE.
 *
 * Никогда не бросает: на машине без PowerShell или с зависшим опросом возвращается статус
 * с `probeError` — «состояние неизвестно», а не «корня нет». Разница принципиальна: иначе
 * программа ругалась бы на исправной машине.
 */
export async function getTrustRootStatus(options: { force?: boolean } = {}): Promise<TrustRootStatus> {
  if (process.platform !== 'win32') return unknownStatus('');
  const now = Date.now();
  if (!options.force && cached && now - cached.at < CACHE_TTL_MS) return cached.status;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const script = findAsset(PROBE_SCRIPT);
    if (!script) {
      const searched = resourceCandidates(PROBE_SCRIPT).join('; ');
      const status = unknownStatus(`в сборке клиента нет скрипта проверки корня (искали: ${searched})`);
      cached = { status, at: Date.now() };
      return status;
    }
    const res = await runPowerShell(script, ['-ExePath', process.execPath], PROBE_TIMEOUT_MS);
    if (res.timedOut) {
      const status = unknownStatus('проверка не ответила за 30 секунд');
      cached = { status, at: Date.now() };
      return status;
    }
    const json = parseProbeJson(res.stdout);
    if (!json) {
      const detail = (res.stderr || res.stdout || '').trim().split(/\r?\n/).slice(-1)[0] ?? '';
      const status = unknownStatus(detail ? `проверка не дала результата: ${detail}` : 'проверка не дала результата');
      cached = { status, at: Date.now() };
      return status;
    }
    const status = statusFromProbe(json);
    cached = { status, at: Date.now() };
    return status;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/**
 * Поставить корень в хранилище ПОЛЬЗОВАТЕЛЯ — без прав администратора, молча.
 *
 * Скрипт тот же, что и у администратора (install-root-on-machine.ps1 -Scope CurrentUser):
 * свой детектор и свой установщик в проекте не заводим — одна правда и один рецепт.
 */
export async function installTrustRootToUserStore(): Promise<TrustRootInstallResult> {
  return runInstall('user');
}

/**
 * Поставить корень в МАШИННЫЕ хранилища. Требует администратора: скрипт сам поднимает
 * права через UAC и показывает окно с оставшимися шагами. Это единственный путь, которым
 * служба Касперского увидит наш корень.
 */
export async function installTrustRootToMachineStore(): Promise<TrustRootInstallResult> {
  return runInstall('machine');
}

async function runInstall(scope: TrustRootInstallScope): Promise<TrustRootInstallResult> {
  const started = Date.now();
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Установка сертификата возможна только на Windows.', durationMs: 0 };
  }
  const script = findAsset(INSTALL_SCRIPT);
  if (!script) {
    return {
      ok: false,
      error: 'В сборке клиента нет скрипта установки корня — сообщите разработчику.',
      durationMs: 0,
    };
  }
  const args = scope === 'user' ? ['-Scope', 'CurrentUser', '-Quiet'] : ['-Scope', 'Machine'];
  const res = await runPowerShell(script, args, INSTALL_TIMEOUT_MS);
  const durationMs = Date.now() - started;
  if (res.timedOut) {
    return { ok: false, error: 'Установка не закончилась за 10 минут — прервите и повторите.', durationMs };
  }
  if (res.code !== 0) {
    const tail = (res.stdout || res.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
    return {
      ok: false,
      error: tail ? tail : `скрипт установки вернул код ${res.code}`,
      durationMs,
    };
  }
  // После установки состояние изменилось — кэш сбрасываем, чтобы UI показал новое.
  cached = null;
  return { ok: true, error: null, durationMs };
}

/**
 * Когда подсказку про доверие показывали в последний раз.
 *
 * Файл — рядом с other-состоянием клиента (`%APPDATA%\MatricaRMZ`), а не в базе: пересборка
 * локальной БД его не сносит, и «показывали вчера» переживает обновление программы.
 */
function noticePath(): string {
  return join(app.getPath('appData'), 'MatricaRMZ', 'trust-root-notice.json');
}

export function readTrustRootNoticeShownAt(): number {
  try {
    const raw = readFileSync(noticePath(), 'utf8');
    const parsed = JSON.parse(raw) as { shownAtMs?: unknown };
    const at = Number(parsed?.shownAtMs);
    return Number.isFinite(at) && at > 0 ? at : 0;
  } catch {
    return 0;
  }
}

export function writeTrustRootNoticeShownAt(atMs: number): void {
  try {
    const target = noticePath();
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ shownAtMs: atMs }, null, 2), 'utf8');
  } catch {
    // Best-effort: без файла подсказка просто покажется лишний раз.
  }
}

/**
 * Что показать оператору при старте: показывать ли подсказку про доверие и почему.
 */
export async function getTrustRootNotice(): Promise<{ show: boolean; reason: string; status: TrustRootStatus }> {
  const status = await getTrustRootStatus();
  const decision = trustRootNoticeDecision(status, readTrustRootNoticeShownAt(), Date.now());
  return { show: decision.show, reason: decision.reason, status };
}
