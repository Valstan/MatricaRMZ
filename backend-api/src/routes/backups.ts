import { Router } from 'express';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { ensureFolderDeep, getDownloadHref, listFolderAll } from '../services/yandexDisk.js';
import { logError, logInfo } from '../utils/logger.js';
const REPORT_TZ = 'Europe/Moscow';

export const backupsRouter = Router();
backupsRouter.use(requireAuth);

function baseYandexPath(): string {
  const p = (process.env.YANDEX_DISK_BASE_PATH ?? '').trim();
  if (!p) throw new Error('Переменная YANDEX_DISK_BASE_PATH не настроена');
  return p.replace(/\/+$/, '') || '/';
}

function backupsFolder(): string {
  return `${baseYandexPath()}/base_reserv`;
}

function parseDateFromName(name: string): string | null {
  const m = String(name).match(/^(\d{4}-\d{2}-\d{2})\.sqlite$/);
  return m?.[1] ?? null;
}

function dateKey(date: string): number {
  return Number(date.replaceAll('-', ''));
}

let runInFlight: { startedAt: number } | null = null;

backupsRouter.get('/nightly', requirePermission(PermissionCode.BackupsView), async (_req, res) => {
  try {
    const folder = backupsFolder();
    await ensureFolderDeep(folder).catch(() => {});

    const items = await listFolderAll({ folderPath: folder, sort: '-modified', pageSize: 200, max: 5000 });
    const backups = items
      .filter((it) => it.type === 'file')
      .map((it) => {
        const date = parseDateFromName(it.name);
        if (!date) return null;
        return {
          date,
          name: it.name,
          size: it.size ?? null,
          modified: it.modified ?? null,
        };
      })
      .filter(Boolean) as Array<{ date: string; name: string; size: number | null; modified: string | null }>;

    backups.sort((a, b) => dateKey(b.date) - dateKey(a.date));

    logInfo('backups nightly list', { count: backups.length }, { critical: true });
    return res.json({ ok: true, folder, backups });
  } catch (e) {
    logError('backups nightly list failed', { error: String(e) });
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

backupsRouter.get('/nightly/:date/url', requirePermission(PermissionCode.BackupsView), async (req, res) => {
  try {
    const schema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
    const parsed = schema.safeParse(req.params);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const folder = backupsFolder();
    const diskPath = `${folder}/${parsed.data.date}.sqlite`;
    const url = await getDownloadHref(diskPath);
    logInfo('backups nightly url', { date: parsed.data.date }, { critical: true });
    return res.json({ ok: true, url });
  } catch (e) {
    logError('backups nightly url failed', { error: String(e) });
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

backupsRouter.post('/nightly/run', requirePermission(PermissionCode.BackupsRun), async (_req, res) => {
  try {
    if (runInFlight) {
      const startedAt = new Date(runInFlight.startedAt).toLocaleString('ru-RU', { timeZone: REPORT_TZ });
      return res.status(409).json({ ok: false, error: `Резервное копирование уже выполняется с ${startedAt}` });
    }

    // We prefer running the built script as a separate process, so it doesn't block the API process
    // and keeps native deps (better-sqlite3) isolated.
    const here = dirname(fileURLToPath(import.meta.url)); // dist/routes or src/routes
    const prodCandidate = join(here, '..', 'scripts', 'nightlyBackup.js');
    const devCandidate = join(here, '..', 'scripts', 'nightlyBackup.ts');
    const scriptPath = existsSync(prodCandidate) ? prodCandidate : existsSync(devCandidate) ? devCandidate : null;
    if (!scriptPath) return res.status(500).json({ ok: false, error: 'Скрипт nightlyBackup не найден (сначала соберите backend-api)' });

    const useTsx = scriptPath.endsWith('.ts');
    const startedAt = Date.now();
    runInFlight = { startedAt };
    logInfo('backups nightly run start', { startedAt }, { critical: true });

    const child = useTsx
      ? spawn('pnpm', ['-C', join(here, '..', '..'), 'backup:nightly'], {
          stdio: ['ignore', 'ignore', 'ignore'],
          env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? 'production' },
        })
      : spawn(process.execPath, [scriptPath], {
          stdio: ['ignore', 'ignore', 'ignore'],
          env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? 'production' },
        });

    child.on('exit', () => {
      runInFlight = null;
    });
    child.on('error', () => {
      runInFlight = null;
    });

    return res.json({ ok: true, startedAt });
  } catch (e) {
    runInFlight = null;
    logError('backups nightly run failed', { error: String(e) });
    return res.status(500).json({ ok: false, error: String(e) });
  }
});


