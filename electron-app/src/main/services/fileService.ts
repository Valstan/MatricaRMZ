import { net, shell } from 'electron';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, promises as fsp } from 'node:fs';
import { basename, join } from 'node:path';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { FileRef } from '@matricarmz/shared';
import { getSession } from './authService.js';
import { SettingsKey, settingsGetString, settingsSetString } from './settingsStore.js';
import { httpAuthed } from './httpClient.js';

const MAX_LOCAL_BYTES = 10 * 1024 * 1024;

export type UploadScope = { ownerType: string; ownerId: string; category: string };

function safeFilename(name: string): string {
  const base = name.replaceAll('\\', '/').split('/').pop() || 'file';
  return base.replaceAll(/[^a-zA-Z0-9а-яА-Я._ -]+/g, '_').slice(0, 180) || 'file';
}

function formatHttpError(r: { status: number; json?: any; text?: string }): string {
  const jsonErr = r?.json && typeof r.json === 'object' ? (r.json.error ?? r.json.message ?? null) : null;
  const msg =
    typeof jsonErr === 'string'
      ? jsonErr
      : jsonErr != null
        ? JSON.stringify(jsonErr)
        : typeof r.text === 'string' && r.text.trim()
          ? r.text.trim()
          : '';
  return `HTTP ${r.status}${msg ? `: ${msg}` : ''}`;
}

async function ensureSessionAccessToken(db: BetterSQLite3Database): Promise<string | null> {
  const session = await getSession(db).catch(() => null);
  if (!session?.accessToken) return null;

  // lightweight: rely on 401/403 retry in fetchAuthedJson; keep as is
  return session.accessToken;
}

async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(filePath);
    rs.on('error', reject);
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('end', () => resolve());
  });
  return hash.digest('hex');
}

export async function filesUpload(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { path: string; scope?: UploadScope },
): Promise<{ ok: true; file: FileRef } | { ok: false; error: string }> {
  try {
    const filePath = String(args.path || '').trim();
    if (!filePath) return { ok: false, error: 'path is empty' };
    const st = await fsp.stat(filePath);
    if (!st.isFile()) return { ok: false, error: 'not a file' };

    const name = safeFilename(basename(filePath));
    const size = Number(st.size);
    const sha256 = await sha256OfFile(filePath);

    // Large file: init Yandex upload (backend returns pre-signed uploadUrl), then PUT directly to Yandex.
    if (size > MAX_LOCAL_BYTES) {
      const scope = args.scope;
      const initRes = await httpAuthed(
        db,
        apiBaseUrl,
        '/files/yandex/init',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            size,
            sha256,
            mime: null,
            ...(scope ? { scope } : {}),
          }),
        },
        { timeoutMs: 120_000 },
      );
      if (!initRes.ok) return { ok: false, error: `init ${formatHttpError(initRes)}` };
      const json = initRes.json as any;
      if (!json?.ok || !json?.file) return { ok: false, error: 'bad init response' };
      const uploadUrl = json.uploadUrl as string | null;
      const file: FileRef = json.file as FileRef;

      if (uploadUrl) {
        // Read file into buffer and use net.fetch() for external URL (required in Electron)
        const fileBuffer = await fsp.readFile(filePath);
        const r = await net.fetch(uploadUrl, { method: 'PUT', body: fileBuffer });
        if (!r.ok) {
          const errorText = await r.text().catch(() => '');
          return { ok: false, error: `yandex PUT HTTP ${r.status}: ${errorText}`.trim() };
        }
      }

      return { ok: true, file };
    }

    // Small file: upload to backend (base64)
    const scope = args.scope;
    const buf = await fsp.readFile(filePath);
    const r = await httpAuthed(
      db,
      apiBaseUrl,
      '/files/upload',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          mime: null,
          dataBase64: buf.toString('base64'),
          ...(scope ? { scope } : {}),
        }),
      },
      { timeoutMs: 120_000 },
    );
    if (!r.ok) return { ok: false, error: `upload ${formatHttpError(r)}` };
    if (!r.json?.ok || !r.json?.file) return { ok: false, error: 'bad upload response' };
    return { ok: true, file: r.json.file as FileRef };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function filesDownloadDirGet(
  db: BetterSQLite3Database,
  args: { defaultDir: string },
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  try {
    const stored = await settingsGetString(db, SettingsKey.FilesDownloadDir);
    const base = stored && stored.trim() ? stored.trim() : args.defaultDir;
    const p = join(base, 'MatricaRMZ_Files');
    mkdirSync(p, { recursive: true });
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function filesDownloadDirSet(db: BetterSQLite3Database, path: string) {
  const p = String(path || '').trim();
  if (!p) return { ok: false as const, error: 'path is empty' };
  mkdirSync(p, { recursive: true });
  await settingsSetString(db, SettingsKey.FilesDownloadDir, p);
  return { ok: true as const, path: p };
}

async function localPathForFile(downloadDir: string, meta: FileRef): Promise<string> {
  const name = safeFilename(meta.name || 'file');
  const prefix = meta.sha256 ? meta.sha256.slice(0, 2) : 'xx';
  const dir = join(downloadDir, prefix);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${meta.sha256 || meta.id}_${name}`);
}

export async function filesDownload(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { fileId: string; downloadDir: string },
): Promise<{ ok: true; localPath: string } | { ok: false; error: string }> {
  try {
    const fileId = String(args.fileId || '').trim();
    if (!fileId) return { ok: false, error: 'fileId is empty' };

    const metaRes = await httpAuthed(db, apiBaseUrl, `/files/${encodeURIComponent(fileId)}/meta`, { method: 'GET' });
    if (!metaRes.ok) return { ok: false, error: `meta ${formatHttpError(metaRes)}` };
    if (!metaRes.json?.ok || !metaRes.json?.file) return { ok: false, error: 'bad meta response' };
    const meta = metaRes.json.file as FileRef;

    const target = await localPathForFile(args.downloadDir, meta);
    if (existsSync(target)) return { ok: true, localPath: target };

    // If Yandex: get direct URL and stream download.
    const urlRes = await httpAuthed(db, apiBaseUrl, `/files/${encodeURIComponent(fileId)}/url`, { method: 'GET' });
    if (!urlRes.ok) return { ok: false, error: `url ${formatHttpError(urlRes)}` };
    const directUrl = urlRes.json?.url as string | null | undefined;

    if (directUrl) {
      // Use net.fetch() for external URL (required in Electron)
      const r = await net.fetch(directUrl);
      if (!r.ok) return { ok: false, error: `download HTTP ${r.status}` };
      const ab = await r.arrayBuffer();
      await fsp.writeFile(target, Buffer.from(ab));
      return { ok: true, localPath: target };
    }

    // Local: download through backend with auth (small files, OK to buffer)
    const sessionToken = await ensureSessionAccessToken(db);
    if (!sessionToken) return { ok: false, error: 'auth required' };
    const r2 = await net.fetch(`${apiBaseUrl}/files/${encodeURIComponent(fileId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    if (!r2.ok) return { ok: false, error: `download HTTP ${r2.status}` };
    const ab2 = await r2.arrayBuffer();
    await fsp.writeFile(target, Buffer.from(ab2));
    return { ok: true, localPath: target };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function filesOpen(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { fileId: string; downloadDir: string },
): Promise<{ ok: true; localPath: string } | { ok: false; error: string }> {
  const dl = await filesDownload(db, apiBaseUrl, { fileId: args.fileId, downloadDir: args.downloadDir });
  if (!dl.ok) return dl;
  await shell.openPath(dl.localPath);
  return dl;
}

export async function filesDelete(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { fileId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const fileId = String(args.fileId || '').trim();
    if (!fileId) return { ok: false, error: 'fileId is empty' };

    const r = await httpAuthed(db, apiBaseUrl, `/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    if (!r.ok) return { ok: false, error: `delete ${formatHttpError(r)}` };
    if (!r.json?.ok) return { ok: false, error: 'bad delete response' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}


