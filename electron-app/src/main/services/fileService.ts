import { BrowserWindow, nativeImage, net, shell } from 'electron';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, promises as fsp } from 'node:fs';
import { basename, join } from 'node:path';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import JSZip from 'jszip';

import type { FileRef } from '@matricarmz/shared';
import { getSession } from './authService.js';
import { SettingsKey, settingsGetString, settingsSetString } from './settingsStore.js';
import { httpAuthed } from './httpClient.js';
import { logMessage } from './logService.js';

const MAX_LOCAL_BYTES = 10 * 1024 * 1024;
const PREVIEW_PNG_MAX_SIDE = 256;
const PREVIEW_PDF_RENDER_MS = 900;
const PREVIEW_TEXT_MAX_BYTES = 220 * 1024;
const PREVIEW_TEXT_MAX_LINES = 32;
const PREVIEW_TEXT_MAX_CHARS = 2400;

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

function extLower(p: string): string {
  const b = basename(p).toLowerCase();
  const idx = b.lastIndexOf('.');
  return idx >= 0 ? b.slice(idx + 1) : '';
}

function escapeHtml(s: string) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function isTextPreviewExt(ext: string): boolean {
  const e = String(ext || '').toLowerCase();
  // CNC / G-code
  if (['nc', 'cnc', 'tap', 'gcode', 'ngc', 'mpf', 'spf', 'h', 'hxx'].includes(e)) return true;
  // Common engineering/programming/text formats
  if (
    [
      'txt',
      'csv',
      'tsv',
      'json',
      'xml',
      'yaml',
      'yml',
      'ini',
      'cfg',
      'conf',
      'log',
      'md',
      'py',
      'js',
      'ts',
      'tsx',
      'jsx',
      'c',
      'cpp',
      'cc',
      'h',
      'hpp',
      'java',
      'go',
      'rs',
      'sql',
      'sh',
      'bat',
      'ps1',
      // DXF is text-based; we only preview small ones
      'dxf',
    ].includes(e)
  )
    return true;
  return false;
}

async function renderHtmlToPng(args: { html: string; width: number; height: number; waitMs?: number }): Promise<Buffer | null> {
  const win = new BrowserWindow({
    width: Math.max(320, Math.min(1200, Math.floor(args.width))),
    height: Math.max(240, Math.min(1200, Math.floor(args.height))),
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  try {
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(args.html)}`;
    await win.loadURL(url);
    await new Promise((r) => setTimeout(r, args.waitMs ?? 180));
    const image = await win.webContents.capturePage();
    const resized = image.resize({ width: PREVIEW_PNG_MAX_SIDE, height: PREVIEW_PNG_MAX_SIDE, quality: 'good' });
    const png = resized.toPNG();
    return png.length ? Buffer.from(png) : null;
  } catch {
    return null;
  } finally {
    win.destroy();
  }
}

async function tryGeneratePreviewPngBytes(filePath: string): Promise<Buffer | null> {
  try {
    const ext = extLower(filePath);

    // Images (best-effort: nativeImage can decode common formats)
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'ico'].includes(ext)) {
      const img = nativeImage.createFromPath(filePath);
      if (img.isEmpty()) return null;
      const resized = img.resize({ width: PREVIEW_PNG_MAX_SIDE, height: PREVIEW_PNG_MAX_SIDE, quality: 'good' });
      const png = resized.toPNG();
      return png.length ? Buffer.from(png) : null;
    }

    // SVG: render directly to bitmap.
    if (ext === 'svg') {
      const raw = await fsp.readFile(filePath, 'utf8').catch(() => '');
      const svg = String(raw || '').trim();
      if (!svg) return null;
      const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      const img = nativeImage.createFromDataURL(dataUrl);
      if (!img || img.isEmpty()) {
        // Fallback: HTML render
        const html = `<!doctype html><html><head><meta charset="utf-8"/></head><body style="margin:0;display:flex;align-items:center;justify-content:center;background:#fff;"><div style="width:90vw;height:90vh;">${svg}</div></body></html>`;
        return await renderHtmlToPng({ html, width: PREVIEW_PNG_MAX_SIDE * 3, height: PREVIEW_PNG_MAX_SIDE * 3, waitMs: 220 });
      }
      const resized = img.resize({ width: PREVIEW_PNG_MAX_SIDE, height: PREVIEW_PNG_MAX_SIDE, quality: 'good' });
      const png = resized.toPNG();
      return png.length ? Buffer.from(png) : null;
    }

    // PDF: render first page in hidden window and capture.
    if (ext === 'pdf' || ext === 'ai') {
      const win = new BrowserWindow({
        width: PREVIEW_PNG_MAX_SIDE * 3,
        height: PREVIEW_PNG_MAX_SIDE * 3,
        show: false,
        webPreferences: {
          sandbox: false,
          nodeIntegration: false,
          contextIsolation: true,
        },
      });
      try {
        // Fragment params help the built-in PDF viewer focus on the first page.
        await win.loadURL(`file://${encodeURI(filePath)}#page=1&toolbar=0&navpanes=0&scrollbar=0`);
        await new Promise((r) => setTimeout(r, PREVIEW_PDF_RENDER_MS));
        const image = await win.webContents.capturePage();
        const resized = image.resize({ width: PREVIEW_PNG_MAX_SIDE, height: PREVIEW_PNG_MAX_SIDE, quality: 'good' });
        const png = resized.toPNG();
        return png.length ? Buffer.from(png) : null;
      } finally {
        win.destroy();
      }
    }

    // Office (docx/xlsx/pptx): extract embedded thumbnail if present.
    if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') {
      const buf = await fsp.readFile(filePath);
      const zip = await JSZip.loadAsync(buf);
      const thumbEntry =
        zip.file('docProps/thumbnail.png') ?? zip.file('docProps/thumbnail.jpeg') ?? zip.file('docProps/thumbnail.jpg') ?? null;
      if (!thumbEntry) return null;
      const thumbBytes = Buffer.from(await thumbEntry.async('nodebuffer'));
      const img = nativeImage.createFromBuffer(thumbBytes);
      if (img.isEmpty()) return null;
      const resized = img.resize({ width: PREVIEW_PNG_MAX_SIDE, height: PREVIEW_PNG_MAX_SIDE, quality: 'good' });
      const png = resized.toPNG();
      return png.length ? Buffer.from(png) : null;
    }

    // Text-like files (including CNC programs): render a snippet as an image.
    if (isTextPreviewExt(ext)) {
      const st = await fsp.stat(filePath).catch(() => null);
      const size = st?.isFile() ? Number(st.size) : 0;
      if (!size || size > PREVIEW_TEXT_MAX_BYTES) return null;
      const raw = await fsp.readFile(filePath, 'utf8').catch(() => '');
      const text = String(raw || '').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
      if (!text.trim()) return null;
      const lines = text.split('\n').slice(0, PREVIEW_TEXT_MAX_LINES);
      let snippet = lines.join('\n');
      if (snippet.length > PREVIEW_TEXT_MAX_CHARS) snippet = `${snippet.slice(0, PREVIEW_TEXT_MAX_CHARS)}\n…`;
      const badge = ext ? `.${ext}` : 'text';
      const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <style>
    body { margin: 0; background: #ffffff; }
    .wrap { padding: 14px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
    .head { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
    .tag { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; font-size: 12px; font-weight: 700; padding: 4px 8px; border-radius: 999px; background: #eef2ff; color: #3730a3; border: 1px solid rgba(15,23,42,0.10); }
    pre { margin:0; padding: 10px 12px; border-radius: 12px; background: #0b1220; color: #e5e7eb; font-size: 11px; line-height: 1.35; border: 1px solid rgba(15,23,42,0.18); white-space: pre-wrap; word-break: break-word; }
  </style>
  </head>
<body>
  <div class="wrap">
    <div class="head">
      <div class="tag">${escapeHtml(badge)}</div>
      <div style="font-family:system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; font-size:11px; color:#64748b;">preview</div>
    </div>
    <pre>${escapeHtml(snippet)}</pre>
  </div>
</body>
</html>`;
      return await renderHtmlToPng({ html, width: PREVIEW_PNG_MAX_SIDE * 3, height: PREVIEW_PNG_MAX_SIDE * 3, waitMs: 200 });
    }

    return null;
  } catch {
    return null;
  }
}

async function uploadPreview(db: BetterSQLite3Database, apiBaseUrl: string, args: { fileId: string; pngBytes: Buffer }): Promise<void> {
  const fileId = String(args.fileId || '').trim();
  if (!fileId) return;
  if (!args.pngBytes?.length) return;

  await httpAuthed(
    db,
    apiBaseUrl,
    `/files/${encodeURIComponent(fileId)}/preview`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mime: 'image/png', dataBase64: args.pngBytes.toString('base64') }),
    },
    { timeoutMs: 30_000 },
  ).catch(() => {});
}

export async function filesUpload(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { path: string; fileName?: string; scope?: UploadScope },
): Promise<{ ok: true; file: FileRef } | { ok: false; error: string }> {
  try {
    const filePath = String(args.path || '').trim();
    if (!filePath) return { ok: false, error: 'path is empty' };
    const st = await fsp.stat(filePath);
    if (!st.isFile()) return { ok: false, error: 'not a file' };

    const requestedName = String(args.fileName || '').trim();
    const name = safeFilename(requestedName || basename(filePath));
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
      if (!initRes.ok) {
        void logMessage(db, apiBaseUrl, 'warn', `file upload init failed: ${formatHttpError(initRes)}`, { component: 'files', action: 'upload:init' });
        return { ok: false, error: `init ${formatHttpError(initRes)}` };
      }
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
          void logMessage(db, apiBaseUrl, 'warn', `file upload yandex PUT failed: HTTP ${r.status}`, {
            component: 'files',
            action: 'upload:yandex',
            status: r.status,
          });
          return { ok: false, error: `yandex PUT HTTP ${r.status}: ${errorText}`.trim() };
        }
      }

      // Best-effort thumbnail upload (do not fail main upload flow).
      void (async () => {
        const png = await tryGeneratePreviewPngBytes(filePath);
        if (png) await uploadPreview(db, apiBaseUrl, { fileId: file.id, pngBytes: png });
      })();

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
    if (!r.ok) {
      void logMessage(db, apiBaseUrl, 'warn', `file upload failed: ${formatHttpError(r)}`, { component: 'files', action: 'upload' });
      return { ok: false, error: `upload ${formatHttpError(r)}` };
    }
    if (!r.json?.ok || !r.json?.file) return { ok: false, error: 'bad upload response' };
    const file = r.json.file as FileRef;

    // Best-effort thumbnail upload (do not fail main upload flow).
    void (async () => {
      const png = await tryGeneratePreviewPngBytes(filePath);
      if (png) await uploadPreview(db, apiBaseUrl, { fileId: file.id, pngBytes: png });
    })();

    return { ok: true, file };
  } catch (e) {
    void logMessage(db, apiBaseUrl, 'error', `file upload error: ${String(e)}`, { component: 'files', action: 'upload' });
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
    if (!metaRes.ok) {
      void logMessage(db, apiBaseUrl, 'warn', `file download meta failed: ${formatHttpError(metaRes)}`, { component: 'files', action: 'download:meta' });
      return { ok: false, error: `meta ${formatHttpError(metaRes)}` };
    }
    if (!metaRes.json?.ok || !metaRes.json?.file) return { ok: false, error: 'bad meta response' };
    const meta = metaRes.json.file as FileRef;

    const target = await localPathForFile(args.downloadDir, meta);
    if (existsSync(target)) return { ok: true, localPath: target };

    // If Yandex: get direct URL and stream download.
    const urlRes = await httpAuthed(db, apiBaseUrl, `/files/${encodeURIComponent(fileId)}/url`, { method: 'GET' });
    if (!urlRes.ok) {
      void logMessage(db, apiBaseUrl, 'warn', `file download url failed: ${formatHttpError(urlRes)}`, { component: 'files', action: 'download:url' });
      return { ok: false, error: `url ${formatHttpError(urlRes)}` };
    }
    const directUrl = urlRes.json?.url as string | null | undefined;

    if (directUrl) {
      // Use net.fetch() for external URL (required in Electron)
      const r = await net.fetch(directUrl);
      if (!r.ok) {
        void logMessage(db, apiBaseUrl, 'warn', `file download failed: HTTP ${r.status}`, { component: 'files', action: 'download', status: r.status });
        return { ok: false, error: `download HTTP ${r.status}` };
      }
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
    if (!r2.ok) {
      void logMessage(db, apiBaseUrl, 'warn', `file download failed: HTTP ${r2.status}`, { component: 'files', action: 'download', status: r2.status });
      return { ok: false, error: `download HTTP ${r2.status}` };
    }
    const ab2 = await r2.arrayBuffer();
    await fsp.writeFile(target, Buffer.from(ab2));
    return { ok: true, localPath: target };
  } catch (e) {
    void logMessage(db, apiBaseUrl, 'error', `file download error: ${String(e)}`, { component: 'files', action: 'download' });
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
): Promise<{ ok: true; queued?: boolean } | { ok: false; error: string }> {
  try {
    const fileId = String(args.fileId || '').trim();
    if (!fileId) return { ok: false, error: 'fileId is empty' };

    const r = await httpAuthed(db, apiBaseUrl, `/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    if (!r.ok) return { ok: false, error: `delete ${formatHttpError(r)}` };
    if (!r.json?.ok) return { ok: false, error: 'bad delete response' };
    return r.json as any;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function filesPreviewGet(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { fileId: string },
): Promise<{ ok: true; dataUrl: string | null } | { ok: false; error: string }> {
  try {
    const fileId = String(args.fileId || '').trim();
    if (!fileId) return { ok: false, error: 'fileId is empty' };

    const r = await httpAuthed(db, apiBaseUrl, `/files/${encodeURIComponent(fileId)}/preview`, { method: 'GET' }, { timeoutMs: 30_000 });
    if (!r.ok) {
      void logMessage(db, apiBaseUrl, 'warn', `file preview failed: ${formatHttpError(r)}`, { component: 'files', action: 'preview' });
      return { ok: false, error: `preview ${formatHttpError(r)}` };
    }
    if (!r.json?.ok) return { ok: false, error: 'bad preview response' };

    const p = (r.json as any).preview as { mime: string; dataBase64: string } | null | undefined;
    if (!p || !p.dataBase64) return { ok: true, dataUrl: null };
    const mime = String((p as any).mime || 'image/png');
    const dataBase64 = String((p as any).dataBase64 || '');
    if (!dataBase64) return { ok: true, dataUrl: null };
    return { ok: true, dataUrl: `data:${mime};base64,${dataBase64}` };
  } catch (e) {
    void logMessage(db, apiBaseUrl, 'error', `file preview error: ${String(e)}`, { component: 'files', action: 'preview' });
    return { ok: false, error: String(e) };
  }
}


