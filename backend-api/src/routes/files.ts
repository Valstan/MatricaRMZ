import { Router } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, createWriteStream, createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { db } from '../database/db.js';
import { fileAssets } from '../database/schema.js';
import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { eq } from 'drizzle-orm';

// Multipart parser (no 3rd party): we accept base64 payload for MVP.
// NOTE: For large files, Electron will stream later; for now keep it simple.

export const filesRouter = Router();
filesRouter.use(requireAuth);

const MAX_LOCAL_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024; // hard safety cap

function uploadsDir(): string {
  // default under backend-api/uploads (systemd WorkingDirectory points to backend-api)
  return process.env.MATRICA_UPLOADS_DIR?.trim() || 'uploads';
}

function nowMs() {
  return Date.now();
}

function safeFilename(name: string): string {
  // minimal sanitization (keep extension, remove path separators)
  const base = name.replaceAll('\\', '/').split('/').pop() || 'file';
  return base.replaceAll(/[^a-zA-Z0-9а-яА-Я._ -]+/g, '_').slice(0, 180) || 'file';
}

async function yandexEnsureFolder(token: string, folderPath: string) {
  const p = folderPath.replaceAll('\\', '/');
  if (!p.startsWith('/')) throw new Error(`Invalid yandex folderPath (must start with '/'): ${folderPath}`);

  const url = new URL('https://cloud-api.yandex.net/v1/disk/resources');
  url.searchParams.set('path', p);

  // Probe (GET). If it fails, try to create (PUT). PUT may return 409 if already exists.
  const probe = await fetch(url.toString(), { method: 'GET', headers: { Authorization: `OAuth ${token}` } });
  if (probe.ok) return;

  const mk = await fetch(url.toString(), { method: 'PUT', headers: { Authorization: `OAuth ${token}` } });
  if (!mk.ok && mk.status !== 409) {
    throw new Error(`yandex mkdir HTTP ${mk.status}: ${(await mk.text().catch(() => '')) || 'no body'}`);
  }
}

async function yandexUpload(_args: { diskPath: string; bytes: Buffer; mime: string | null }) {
  const token = (process.env.YANDEX_DISK_TOKEN ?? '').trim();
  if (!token) throw new Error('YANDEX_DISK_TOKEN is not configured');

  // Ensure parent folder exists, otherwise Yandex returns 409 on resources/upload.
  const parent = dirname(_args.diskPath.replaceAll('\\', '/')) || '/';
  await yandexEnsureFolder(token, parent);

  // 1) get upload href
  const q = new URL('https://cloud-api.yandex.net/v1/disk/resources/upload');
  q.searchParams.set('path', _args.diskPath);
  q.searchParams.set('overwrite', 'true');
  const r1 = await fetch(q.toString(), { headers: { Authorization: `OAuth ${token}` } });
  if (!r1.ok) throw new Error(`yandex upload href HTTP ${r1.status}: ${(await r1.text().catch(() => '')) || 'no body'}`);
  const j = (await r1.json().catch(() => null)) as any;
  const href = String(j?.href ?? '');
  if (!href) throw new Error('yandex upload href missing');

  // 2) PUT bytes
  const init: RequestInit = {
    method: 'PUT',
    // Buffer не входит в BodyInit по типам TS здесь, поэтому используем Uint8Array.
    body: new Uint8Array(_args.bytes),
  };
  if (_args.mime) init.headers = { 'Content-Type': _args.mime };

  const r2 = await fetch(href, init);
  if (!r2.ok) throw new Error(`yandex upload PUT HTTP ${r2.status}: ${(await r2.text().catch(() => '')) || 'no body'}`);
}

async function yandexDownloadUrl(diskPath: string): Promise<string> {
  const token = (process.env.YANDEX_DISK_TOKEN ?? '').trim();
  if (!token) throw new Error('YANDEX_DISK_TOKEN is not configured');
  const q = new URL('https://cloud-api.yandex.net/v1/disk/resources/download');
  q.searchParams.set('path', diskPath);
  const r = await fetch(q.toString(), { headers: { Authorization: `OAuth ${token}` } });
  if (!r.ok) throw new Error(`yandex download href HTTP ${r.status}: ${(await r.text().catch(() => '')) || 'no body'}`);
  const j = (await r.json().catch(() => null)) as any;
  const href = String(j?.href ?? '');
  if (!href) throw new Error('yandex download href missing');
  return href;
}

filesRouter.get('/:id/meta', requirePermission(PermissionCode.FilesView), async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });

    const rows = await db.select().from(fileAssets).where(eq(fileAssets.id, id as any)).limit(1);
    const row = rows[0] as any;
    if (!row) return res.status(404).json({ ok: false, error: 'file not found' });

    return res.json({
      ok: true,
      file: {
        id: row.id,
        name: row.name,
        size: Number(row.size),
        mime: row.mime ?? null,
        sha256: row.sha256,
        createdAt: Number(row.createdAt),
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Large files: client uploads directly to Yandex.Disk using returned pre-signed URL (href).
filesRouter.post('/yandex/init', requirePermission(PermissionCode.FilesUpload), async (req, res) => {
  try {
    const schema = z.object({
      name: z.string().min(1).max(400),
      mime: z.string().max(200).optional().nullable(),
      size: z.number().int().positive(),
      sha256: z.string().min(16).max(128),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const size = parsed.data.size;
    if (size > MAX_UPLOAD_BYTES) return res.status(400).json({ ok: false, error: `file too large (>${MAX_UPLOAD_BYTES} bytes)` });

    // de-dup
    const existing = await db.select().from(fileAssets).where(eq(fileAssets.sha256, parsed.data.sha256)).limit(1);
    if (existing[0]) {
      const row = existing[0] as any;
      // If it already exists as yandex asset, allow re-upload by returning a fresh uploadUrl
      // (important if a previous init happened but the client didn't finish PUT).
      if (row.storageKind === 'yandex' && row.yandexDiskPath) {
        const token = (process.env.YANDEX_DISK_TOKEN ?? '').trim();
        if (!token) return res.status(500).json({ ok: false, error: 'YANDEX_DISK_TOKEN is not configured' });

        const diskPath = String(row.yandexDiskPath);
        const parent = dirname(diskPath.replaceAll('\\', '/')) || '/';
        await yandexEnsureFolder(token, parent);

        const q = new URL('https://cloud-api.yandex.net/v1/disk/resources/upload');
        q.searchParams.set('path', diskPath);
        q.searchParams.set('overwrite', 'true');
        const r1 = await fetch(q.toString(), { headers: { Authorization: `OAuth ${token}` } });
        if (!r1.ok) return res.status(502).json({ ok: false, error: `yandex upload href HTTP ${r1.status}` });
        const j = (await r1.json().catch(() => null)) as any;
        const href = String(j?.href ?? '');
        if (!href) return res.status(502).json({ ok: false, error: 'yandex upload href missing' });

        return res.json({
          ok: true,
          file: {
            id: row.id,
            name: row.name,
            size: Number(row.size),
            mime: row.mime ?? null,
            sha256: row.sha256,
            createdAt: Number(row.createdAt),
          },
          uploadUrl: href,
        });
      }

      return res.json({
        ok: true,
        file: {
          id: row.id,
          name: row.name,
          size: Number(row.size),
          mime: row.mime ?? null,
          sha256: row.sha256,
          createdAt: Number(row.createdAt),
        },
        uploadUrl: null,
      });
    }

    const baseYandexPath = (process.env.YANDEX_DISK_BASE_PATH ?? '').trim(); // e.g. /MatricaRMZ/releases
    if (!baseYandexPath) {
      return res.status(500).json({ ok: false, error: 'YANDEX_DISK_BASE_PATH is not configured' });
    }

    const actor = (req as AuthenticatedRequest).user;
    const id = randomUUID();
    const createdAt = nowMs();
    const name = safeFilename(parsed.data.name);
    const mime = parsed.data.mime ? String(parsed.data.mime) : null;
    const diskPath = `${baseYandexPath.replace(/\/+$/, '')}/${id}_${name}`;

    // Get pre-signed upload URL (href). Client will PUT directly to it.
    const token = (process.env.YANDEX_DISK_TOKEN ?? '').trim();
    if (!token) return res.status(500).json({ ok: false, error: 'YANDEX_DISK_TOKEN is not configured' });

    // Ensure base folder exists on Yandex.Disk (mkdir is idempotent).
    await yandexEnsureFolder(token, baseYandexPath.replace(/\/+$/, '') || '/');

    const q = new URL('https://cloud-api.yandex.net/v1/disk/resources/upload');
    q.searchParams.set('path', diskPath);
    q.searchParams.set('overwrite', 'true');
    const r1 = await fetch(q.toString(), { headers: { Authorization: `OAuth ${token}` } });
    if (!r1.ok) return res.status(502).json({ ok: false, error: `yandex upload href HTTP ${r1.status}` });
    const j = (await r1.json().catch(() => null)) as any;
    const href = String(j?.href ?? '');
    if (!href) return res.status(502).json({ ok: false, error: 'yandex upload href missing' });

    await db.insert(fileAssets).values({
      id,
      createdAt,
      createdByUserId: actor.id,
      name,
      mime,
      size,
      sha256: parsed.data.sha256,
      storageKind: 'yandex',
      localRelPath: null,
      yandexDiskPath: diskPath,
    });

    return res.json({ ok: true, file: { id, name, size, mime, sha256: parsed.data.sha256, createdAt }, uploadUrl: href });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

filesRouter.get('/:id/url', requirePermission(PermissionCode.FilesView), async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });

    const rows = await db.select().from(fileAssets).where(eq(fileAssets.id, id as any)).limit(1);
    const row = rows[0] as any;
    if (!row) return res.status(404).json({ ok: false, error: 'file not found' });

    if (row.storageKind === 'yandex') {
      const diskPath = String(row.yandexDiskPath || '');
      if (!diskPath) return res.status(500).json({ ok: false, error: 'yandex_disk_path missing' });
      const href = await yandexDownloadUrl(diskPath);
      return res.json({ ok: true, url: href });
    }

    // For local files, client can just GET /files/:id (stream). Return relative path for convenience.
    return res.json({ ok: true, url: null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Upload endpoint: accepts JSON { name, mime?, dataBase64 }.
// Server decides storage:
// - <=10MB: store locally
// - >10MB: store to Yandex.Disk
filesRouter.post('/upload', requirePermission(PermissionCode.FilesUpload), async (req, res) => {
  try {
    const schema = z.object({
      name: z.string().min(1).max(400),
      mime: z.string().max(200).optional().nullable(),
      dataBase64: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const bytes = Buffer.from(parsed.data.dataBase64, 'base64');
    if (!bytes.length) return res.status(400).json({ ok: false, error: 'empty file' });
    if (bytes.length > MAX_UPLOAD_BYTES) return res.status(400).json({ ok: false, error: `file too large (>${MAX_UPLOAD_BYTES} bytes)` });

    const sha256 = createHash('sha256').update(bytes).digest('hex');

    // de-dup by sha256 (so links are stable and cacheable)
    const existing = await db.select().from(fileAssets).where(eq(fileAssets.sha256, sha256)).limit(1);
    if (existing[0]) {
      const row = existing[0] as any;
      return res.json({
        ok: true,
        file: {
          id: row.id,
          name: row.name,
          size: Number(row.size),
          mime: row.mime ?? null,
          sha256: row.sha256,
          createdAt: Number(row.createdAt),
        },
      });
    }

    const id = randomUUID();
    const createdAt = nowMs();
    const actor = (req as AuthenticatedRequest).user;
    const name = safeFilename(parsed.data.name);
    const mime = parsed.data.mime ? String(parsed.data.mime) : null;
    const size = bytes.length;

    const baseYandexPath = (process.env.YANDEX_DISK_BASE_PATH ?? '').trim(); // e.g. /MatricaRMZ/releases

    if (size <= MAX_LOCAL_BYTES) {
      const rel = join('local', id.slice(0, 2), `${id}_${name}`);
      const abs = join(uploadsDir(), rel);
      mkdirSync(dirname(abs), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(abs);
        ws.on('error', reject);
        ws.on('finish', () => resolve());
        ws.end(bytes);
      });

      await db.insert(fileAssets).values({
        id,
        createdAt,
        createdByUserId: actor.id,
        name,
        mime,
        size,
        sha256,
        storageKind: 'local',
        localRelPath: rel,
        yandexDiskPath: null,
      });

      return res.json({ ok: true, file: { id, name, size, mime, sha256, createdAt } });
    }

    // Yandex.Disk
    if (!baseYandexPath) {
      return res.status(500).json({ ok: false, error: 'YANDEX_DISK_BASE_PATH is not configured (required for large files)' });
    }
    const diskPath = `${baseYandexPath.replace(/\/+$/, '')}/${id}_${name}`;
    await yandexUpload({ diskPath, bytes, mime });

    await db.insert(fileAssets).values({
      id,
      createdAt,
      createdByUserId: actor.id,
      name,
      mime,
      size,
      sha256,
      storageKind: 'yandex',
      localRelPath: null,
      yandexDiskPath: diskPath,
    });

    return res.json({ ok: true, file: { id, name, size, mime, sha256, createdAt } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

filesRouter.get('/:id', requirePermission(PermissionCode.FilesView), async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });

    const rows = await db.select().from(fileAssets).where(eq(fileAssets.id, id as any)).limit(1);
    const row = rows[0] as any;
    if (!row) return res.status(404).json({ ok: false, error: 'file not found' });

    if (row.storageKind === 'local') {
      const rel = String(row.localRelPath || '');
      if (!rel) return res.status(500).json({ ok: false, error: 'local_rel_path missing' });
      const abs = join(uploadsDir(), rel);
      // set headers
      res.setHeader('Content-Type', row.mime || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(String(row.name || 'file'))}"`);
      return createReadStream(abs).pipe(res);
    }

    if (row.storageKind === 'yandex') {
      const diskPath = String(row.yandexDiskPath || '');
      if (!diskPath) return res.status(500).json({ ok: false, error: 'yandex_disk_path missing' });
      const href = await yandexDownloadUrl(diskPath);
      const r = await fetch(href);
      if (!r.ok) return res.status(502).json({ ok: false, error: `yandex download HTTP ${r.status}` });
      res.setHeader('Content-Type', row.mime || r.headers.get('content-type') || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(String(row.name || 'file'))}"`);
      const buf = Buffer.from(await r.arrayBuffer());
      return res.end(buf);
    }

    return res.status(500).json({ ok: false, error: `unknown storageKind: ${String(row.storageKind)}` });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

async function yandexDeleteFile(diskPath: string): Promise<void> {
  const token = (process.env.YANDEX_DISK_TOKEN ?? '').trim();
  if (!token) throw new Error('YANDEX_DISK_TOKEN is not configured');
  const q = new URL('https://cloud-api.yandex.net/v1/disk/resources');
  q.searchParams.set('path', diskPath);
  const r = await fetch(q.toString(), { method: 'DELETE', headers: { Authorization: `OAuth ${token}` } });
  if (!r.ok && r.status !== 404) {
    throw new Error(`yandex delete HTTP ${r.status}: ${(await r.text().catch(() => '')) || 'no body'}`);
  }
}

filesRouter.delete('/:id', requirePermission(PermissionCode.FilesDelete), async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });

    const rows = await db.select().from(fileAssets).where(eq(fileAssets.id, id as any)).limit(1);
    const row = rows[0] as any;
    if (!row) return res.status(404).json({ ok: false, error: 'file not found' });

    // Удаляем физический файл
    if (row.storageKind === 'local') {
      const rel = String(row.localRelPath || '');
      if (rel) {
        const abs = join(uploadsDir(), rel);
        try {
          const { unlink } = await import('node:fs/promises');
          await unlink(abs).catch(() => {
            // Игнорируем ошибки если файл уже удален
          });
        } catch {
          // Игнорируем ошибки удаления файла
        }
      }
    } else if (row.storageKind === 'yandex') {
      const diskPath = String(row.yandexDiskPath || '');
      if (diskPath) {
        await yandexDeleteFile(diskPath).catch(() => {
          // Игнорируем ошибки удаления файла на Yandex.Disk
        });
      }
    }

    // Удаляем запись из БД (soft delete)
    await db.update(fileAssets).set({ deletedAt: nowMs() }).where(eq(fileAssets.id, id as any));

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});


