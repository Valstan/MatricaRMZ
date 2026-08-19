import { Router } from 'express';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { createSnapshotDecryptStream, readSnapshotKeyFromEnv } from '../services/snapshotCrypto.js';
import { ensureFolderDeep, getDownloadHref, listFolderAll } from '../services/yandexDisk.js';
import { logError, logInfo } from '../utils/logger.js';
const REPORT_TZ = 'Europe/Moscow';

export const backupsRouter = Router();

// ── Расшифровывающая отдача снимка ───────────────────────────────────────────
// Снимок на Яндекс.Диске зашифрован, а расшифровать его умеет только сервер. Клиент качает
// файл голым `net.fetch` без auth-заголовков (так было и с прямой яндексовой ссылкой),
// поэтому маршрут регистрируется ДО `requireAuth` и защищён коротким подписанным токеном.
// Ссылку выдаёт `/nightly/:date/url` — она же под обычной аутентификацией и правами.

const DOWNLOAD_TTL_MS = 5 * 60 * 1000;

function downloadSignature(date: string, exp: number): string {
  const secret = process.env.MATRICA_JWT_SECRET ?? '';
  if (secret.trim().length < 32) throw new Error('MATRICA_JWT_SECRET is not configured (must be 32+ chars)');
  return createHmac('sha256', secret).update(`backup-snapshot:${date}:${exp}`).digest('base64url');
}

function issueDownloadToken(date: string): string {
  const exp = Date.now() + DOWNLOAD_TTL_MS;
  return `${exp}.${downloadSignature(date, exp)}`;
}

function verifyDownloadToken(date: string, token: string): boolean {
  const [expRaw, sig] = String(token).split('.');
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || !sig) return false;
  if (Date.now() > exp) return false;
  const expected = Buffer.from(downloadSignature(date, exp), 'utf8');
  const got = Buffer.from(sig, 'utf8');
  return expected.length === got.length && timingSafeEqual(expected, got);
}

backupsRouter.get('/nightly/:date/download', async (req, res) => {
  const schema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
  const parsed = schema.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad date' });
  const date = parsed.data.date;

  try {
    if (!verifyDownloadToken(date, String(req.query.t ?? ''))) {
      return res.status(403).json({ ok: false, error: 'Ссылка недействительна или устарела' });
    }

    const key = readSnapshotKeyFromEnv();
    const href = await getDownloadHref(`${backupsFolder()}/${date}.sqlite.enc`);
    const upstream = await fetch(href);
    if (!upstream.ok || !upstream.body) {
      logError('backups snapshot upstream failed', { date, status: upstream.status });
      return res.status(502).json({ ok: false, error: `Яндекс.Диск ответил ${upstream.status}` });
    }

    res.setHeader('Content-Type', 'application/x-sqlite3');
    res.setHeader('Content-Disposition', `attachment; filename="${date}.sqlite"`);
    // Длину не объявляем: после расшифровки она другая, а врать про Content-Length хуже,
    // чем не указать его вовсе.
    logInfo('backups snapshot download', { date }, { critical: true });
    await pipeline(Readable.fromWeb(upstream.body as any), createSnapshotDecryptStream(key), res);
  } catch (e) {
    logError('backups snapshot download failed', { date, error: String(e) });
    // Целостность кадра проверяется по ходу отдачи, поэтому заголовки могут быть уже
    // отправлены. Тогда рвём соединение: клиент получит незавершённую загрузку и ошибку,
    // а не молча битую базу.
    if (res.headersSent) res.destroy();
    else res.status(500).json({ ok: false, error: String(e) });
  }
});

backupsRouter.use(requireAuth);

function baseYandexPath(): string {
  const p = (process.env.YANDEX_DISK_BASE_PATH ?? '').trim();
  if (!p) throw new Error('Переменная YANDEX_DISK_BASE_PATH не настроена');
  return p.replace(/\/+$/, '') || '/';
}

function backupsFolder(): string {
  return `${baseYandexPath()}/base_reserv`;
}

// Легаси-снимки (открытые `.sqlite`) остаются в выдаче: они ещё лежат на Диске и доживают
// свой срок ротации, а «просмотр бэкапа» за прошлые даты не должен пропасть на 10 дней.
function parseDateFromName(name: string): { date: string; encrypted: boolean } | null {
  const m = String(name).match(/^(\d{4}-\d{2}-\d{2})\.sqlite(\.enc)?$/);
  return m?.[1] ? { date: m[1], encrypted: Boolean(m[2]) } : null;
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
        const parsed = parseDateFromName(it.name);
        if (!parsed) return null;
        return {
          date: parsed.date,
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
    const date = parsed.data.date;

    const folder = backupsFolder();
    const items = await listFolderAll({ folderPath: folder, sort: '-modified', pageSize: 200, max: 5000 });
    const found = items
      .filter((it) => it.type === 'file')
      .map((it) => parseDateFromName(it.name))
      .filter((x): x is { date: string; encrypted: boolean } => Boolean(x) && x!.date === date);
    if (found.length === 0) return res.status(404).json({ ok: false, error: `Снимок за ${date} не найден` });

    // Клиенту всё равно, что он качает: он берёт выданный URL и пишет байты в файл. Поэтому
    // шифрованный снимок отдаётся через свой расшифровывающий маршрут, а легаси-открытый —
    // по-прежнему прямой ссылкой на Яндекс. Парк обновлять не требуется.
    const encrypted = found.some((x) => x.encrypted);
    if (encrypted) {
      const base = `${req.protocol}://${req.get('host') ?? '127.0.0.1'}`;
      const url = `${base}/backups/nightly/${date}/download?t=${encodeURIComponent(issueDownloadToken(date))}`;
      logInfo('backups nightly url', { date, encrypted: true }, { critical: true });
      return res.json({ ok: true, url });
    }

    const url = await getDownloadHref(`${folder}/${date}.sqlite`);
    logInfo('backups nightly url', { date, encrypted: false }, { critical: true });
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


