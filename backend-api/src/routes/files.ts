import { Router, type Response } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, createWriteStream, createReadStream } from 'node:fs';
import { readFile as readFileAsync, unlink as unlinkAsync, writeFile as writeFileAsync } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { db } from '../database/db.js';
import { changeRequests, fileAssets } from '../database/schema.js';
import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { canAccessFile } from '../services/fileAccessService.js';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { deletePath, ensureFolderDeep, getDownloadHref, getResourceInfo, getUploadHref, uploadBytes } from '../services/yandexDisk.js';
import { cacheRelPath } from '../services/fileCachePlan.js';
import { normalizeUploadImage } from '../services/imageNormalize.js';
import { verifyUploaded } from '../scripts/offloadLocalFilesToYandexPlan.js';
import { getEmployeeAuthById } from '../services/employeeAuthService.js';
import { logWarn } from '../utils/logger.js';

// Multipart parser (no 3rd party): we accept base64 payload for MVP.
// NOTE: For large files, Electron will stream later; for now keep it simple.

export const filesRouter = Router();
filesRouter.use(requireAuth);

// D-073: хранилище — Я.Диск. Кэша на боксе БОЛЬШЕ НЕТ (решение владельца 14.09): клиент берёт
// файл прямо с Я.Диска по ссылке из `/files/:id/url`, и бокс уходит из тракта байтов совсем —
// это и быстрее маленького VPS, и не копит на нём место (за один день фотографий кэш занимал
// 1.5 ГБ из 10). Загрузка кладёт байты на бокс лишь на время: подтвердил Я.Диск — файл снят.
// Не подтвердил — строка остаётся 'local', копия на боксе единственная, её доводит
// files:offload-to-yandex; загрузка не должна падать из-за облака.
//
// На боксе постоянно живут только ПРЕВЬЮ: они в девять раз легче снимка (117 КБ против ~1 МБ),
// делаются один раз и раздаются всем — гнать ради них полный снимок на каждый компьютер дороже.
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024; // hard safety cap
const MAX_PREVIEW_BYTES = 3 * 1024 * 1024; // base64 upload size cap for thumbnail payload (decoded bytes)

type UploadScope = { ownerType: string; ownerId: string; category: string };

function uploadsDir(): string {
  // default under backend-api/uploads (systemd WorkingDirectory points to backend-api)
  return process.env.MATRICA_UPLOADS_DIR?.trim() || 'uploads';
}

function previewRelPathForFile(args: { fileId: string; mime: string }): string {
  const id = String(args.fileId || '').trim();
  const mime = String(args.mime || '').trim().toLowerCase();
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  return join('previews', `${id}.${ext}`);
}

function nowMs() {
  return Date.now();
}

// Счётчик обращений (D-073 «замеры-слежка»): по распределению «через сколько дней после
// загрузки к файлу возвращаются» подбирается окно кэша. Не на пути ответа: сбой счётчика
// не должен стоить выдачи файла.
function countAccess(fileId: string) {
  db.update(fileAssets)
    .set({ accessCount: sql`${fileAssets.accessCount} + 1`, lastAccessedAt: nowMs() })
    .where(eq(fileAssets.id, fileId as any))
    .then(() => {})
    .catch((e) => logWarn('file access counter failed', { fileId, error: String(e) }));
}

async function writeBytes(abs: string, bytes: Buffer) {
  mkdirSync(dirname(abs), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(abs);
    ws.on('error', reject);
    ws.on('finish', () => resolve());
    ws.end(bytes);
  });
}

// Загрузить на Я.Диск и убедиться, что байты долетели: Яндекс считает sha256 на приёме,
// это единственный независимый свидетель. Неподтверждённая копия удаляется — иначе строка
// указывала бы на объект, которому нельзя верить.
async function uploadVerified(args: { diskPath: string; bytes: Buffer; mime: string | null; sha256: string }) {
  await uploadBytes({ diskPath: args.diskPath, bytes: args.bytes, mime: args.mime });
  const md5 = createHash('md5').update(args.bytes).digest('hex');
  const verdict = verifyUploaded({ size: args.bytes.length, sha256: args.sha256, md5 }, await getResourceInfo(args.diskPath));
  if (!verdict.ok) {
    await deletePath(args.diskPath).catch(() => {});
    throw new Error(`проверка после загрузки на Яндекс: ${verdict.reason}`);
  }
}

function safeFilename(name: string): string {
  // minimal sanitization (keep extension, remove path separators)
  const base = name.replaceAll('\\', '/').split('/').pop() || 'file';
  return base.replaceAll(/[^a-zA-Z0-9а-яА-Я._ -]+/g, '_').slice(0, 180) || 'file';
}

function safePathSegment(raw: string, fallback: string): string {
  const s = String(raw || '').trim().replaceAll('\\', '/').split('/').filter(Boolean).join('_');
  const cleaned = s.replaceAll(/[^a-zA-Z0-9а-яА-Я._-]+/g, '_').replaceAll(/_+/g, '_').slice(0, 120);
  return cleaned || fallback;
}

function yandexDiskPathForFile(args: { baseYandexPath: string; fileId: string; fileName: string; scope?: UploadScope | null }): string {
  const base = args.baseYandexPath.replace(/\/+$/, '') || '/';
  if (!args.scope) {
    return `${base}/${args.fileId}_${args.fileName}`;
  }
  // Special scope for chat temporary files: keep them under a single folder `${base}/chat-files`.
  // This is used by the Chat module to enforce retention cleanup by folder.
  if (args.scope.ownerType === 'chat' && args.scope.category === 'chat-files') {
    return `${base}/chat-files/${args.fileId}_${args.fileName}`;
  }
  const ownerType = safePathSegment(args.scope.ownerType, 'owner');
  const ownerId = safePathSegment(args.scope.ownerId, 'id');
  const category = safePathSegment(args.scope.category, 'files');
  return `${base}/${ownerType}/${ownerId}/${category}/${args.fileId}_${args.fileName}`;
}

filesRouter.get('/:id/meta', requirePermission(PermissionCode.FilesView), async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'id не указан' });

    const rows = await db.select().from(fileAssets).where(and(eq(fileAssets.id, id as any), isNull(fileAssets.deletedAt))).limit(1);
    const row = rows[0] as any;
    if (!row) return res.status(404).json({ ok: false, error: 'файл не найден' });
    if (!(await canAccessFile((req as AuthenticatedRequest).user, row))) return res.status(403).json({ ok: false, error: 'доступ запрещён' });

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

filesRouter.get('/:id/preview', requirePermission(PermissionCode.FilesView), async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'id не указан' });

    const rows = await db.select().from(fileAssets).where(and(eq(fileAssets.id, id as any), isNull(fileAssets.deletedAt))).limit(1);
    const row = rows[0] as any;
    if (!row) return res.status(404).json({ ok: false, error: 'файл не найден' });
    if (!(await canAccessFile((req as AuthenticatedRequest).user, row))) return res.status(403).json({ ok: false, error: 'доступ запрещён' });

    const rel = row.previewLocalRelPath ? String(row.previewLocalRelPath) : '';
    if (!rel) return res.json({ ok: true, preview: null });

    const abs = join(uploadsDir(), rel);
    try {
      const bytes = await readFileAsync(abs);
      const mime = row.previewMime ? String(row.previewMime) : 'image/png';
      return res.json({
        ok: true,
        preview: { mime, size: bytes.length, dataBase64: bytes.toString('base64') },
      });
    } catch {
      // If file is missing/unreadable - treat as no preview (best-effort).
      return res.json({ ok: true, preview: null });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

filesRouter.post('/:id/preview', requirePermission(PermissionCode.FilesUpload), async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'id не указан' });

    const schema = z.object({
      mime: z.string().min(1).max(200),
      dataBase64: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const mime = String(parsed.data.mime || '').trim().toLowerCase();
    if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp') {
      return res.status(400).json({ ok: false, error: `unsupported preview mime: ${mime}` });
    }

    const bytes = Buffer.from(parsed.data.dataBase64, 'base64');
    if (!bytes.length) return res.status(400).json({ ok: false, error: 'пустой предварительный просмотр' });
    if (bytes.length > MAX_PREVIEW_BYTES) return res.status(400).json({ ok: false, error: `preview too large (>${MAX_PREVIEW_BYTES} bytes)` });

    const rows = await db.select().from(fileAssets).where(and(eq(fileAssets.id, id as any), isNull(fileAssets.deletedAt))).limit(1);
    const row = rows[0] as any;
    if (!row) return res.status(404).json({ ok: false, error: 'файл не найден' });
    if (!(await canAccessFile((req as AuthenticatedRequest).user, row))) return res.status(403).json({ ok: false, error: 'доступ запрещён' });

    const rel = previewRelPathForFile({ fileId: id, mime });
    const abs = join(uploadsDir(), rel);
    mkdirSync(dirname(abs), { recursive: true });
    await writeFileAsync(abs, bytes);

    await db
      .update(fileAssets)
      .set({
        previewMime: mime,
        previewSize: bytes.length,
        previewLocalRelPath: rel,
      })
      .where(eq(fileAssets.id, id as any));

    return res.json({ ok: true, preview: { mime, size: bytes.length } });
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
      scope: z
        .object({
          ownerType: z.string().min(1).max(64),
          ownerId: z.string().min(1).max(200),
          category: z.string().min(1).max(64),
        })
        .optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const size = parsed.data.size;
    if (size > MAX_UPLOAD_BYTES) return res.status(400).json({ ok: false, error: `file too large (>${MAX_UPLOAD_BYTES} bytes)` });

    // de-dup
    const existing = await db.select().from(fileAssets).where(and(eq(fileAssets.sha256, parsed.data.sha256), isNull(fileAssets.deletedAt))).limit(1);
    if (existing[0]) {
      const row = existing[0] as any;
      // Как и в /upload: байты совпали — запись чужая, поэтому сразу говорим, откроется ли
      // она у загрузившего. Молчаливое «ok» здесь оборачивается 403 при первом открытии.
      const canOpen = await canAccessFile((req as AuthenticatedRequest).user, {
        id: String(row.id),
        createdByUserId: row.createdByUserId ?? null,
      });
      // If it already exists as yandex asset, allow re-upload by returning a fresh uploadUrl
      // (important if a previous init happened but the client didn't finish PUT).
      if (row.storageKind === 'yandex' && row.yandexDiskPath) {
        const diskPath = String(row.yandexDiskPath);
        // A fresh href only when the object is absent or half-written (size differs): an
        // existing verified copy — e.g. one moved there by files:offload-to-yandex — must
        // not be overwritable by whoever knows its sha256.
        const remote = await getResourceInfo(diskPath).catch(() => null);
        const href =
          remote && remote.size !== null && remote.size === Number(row.size)
            ? null
            : await getUploadHref({ diskPath, overwrite: true, ensureParent: true });

        return res.json({
          ok: true,
          deduped: true,
          canOpen,
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
        deduped: true,
        canOpen,
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
      return res.status(500).json({ ok: false, error: 'YANDEX_DISK_BASE_PATH не настроен' });
    }

    const actor = (req as AuthenticatedRequest).user;
    const id = randomUUID();
    const createdAt = nowMs();
    const name = safeFilename(parsed.data.name);
    const mime = parsed.data.mime ? String(parsed.data.mime) : null;
    const diskPath = yandexDiskPathForFile({
      baseYandexPath,
      fileId: id,
      fileName: name,
      scope: (parsed.data.scope ?? null) as any,
    });

    // Get pre-signed upload URL (href). Client will PUT directly to it.
    // Ensure base folder exists on Yandex.Disk (mkdir is idempotent).
    await ensureFolderDeep(baseYandexPath.replace(/\/+$/, '') || '/');
    const href = await getUploadHref({ diskPath, overwrite: true, ensureParent: true });

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
    if (!id) return res.status(400).json({ ok: false, error: 'id не указан' });

    const rows = await db.select().from(fileAssets).where(and(eq(fileAssets.id, id as any), isNull(fileAssets.deletedAt))).limit(1);
    const row = rows[0] as any;
    if (!row) return res.status(404).json({ ok: false, error: 'файл не найден' });
    if (!(await canAccessFile((req as AuthenticatedRequest).user, row))) return res.status(403).json({ ok: false, error: 'доступ запрещён' });

    // Отдаём ссылку на Я.Диск — клиент качает напрямую, и бокс уходит из тракта байтов совсем.
    // Права проверены выше, ссылка живёт считанные минуты; ровно так же работает ЗАГРУЗКА
    // крупных файлов (`/yandex/init`), только в обратную сторону.
    //
    // `localRelPath` остался в условии не как след кэша (его больше нет — решение владельца
    // 14.09), а как защита: если копия на боксе всё-таки есть, она и есть источник истины —
    // так у строк 'local', которые Я.Диск не принял.
    if (row.storageKind === 'yandex' && !row.localRelPath) {
      const diskPath = String(row.yandexDiskPath || '');
      if (!diskPath) return res.status(500).json({ ok: false, error: 'путь yandex_disk_path не указан' });
      const href = await getDownloadHref(diskPath);
      countAccess(id);
      return res.json({ ok: true, url: href });
    }

    return res.json({ ok: true, url: null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Upload endpoint: accepts JSON { name, mime?, dataBase64 }.
// Байты ложатся в кэш на боксе и сразу уезжают на Я.Диск (D-073). Строка становится
// 'yandex' только после подтверждения копии; если облако не ответило — 'local', и её
// доведёт files:offload-to-yandex. Оператор в обоих случаях получает ok.
filesRouter.post('/upload', requirePermission(PermissionCode.FilesUpload), async (req, res) => {
  try {
    const schema = z.object({
      name: z.string().min(1).max(400),
      mime: z.string().max(200).optional().nullable(),
      dataBase64: z.string().min(1),
      scope: z
        .object({
          ownerType: z.string().min(1).max(64),
          ownerId: z.string().min(1).max(200),
          category: z.string().min(1).max(64),
        })
        .optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const raw = Buffer.from(parsed.data.dataBase64, 'base64');
    if (!raw.length) return res.status(400).json({ ok: false, error: 'файл пуст' });
    if (raw.length > MAX_UPLOAD_BYTES) return res.status(400).json({ ok: false, error: `размер файла слишком большой (> ${MAX_UPLOAD_BYTES} байт)` });

    // Снимок приводим к печатному потолку ДО хеша: и дедуп, и сверка копии на Я.Диске
    // считаются по тем байтам, которые действительно лягут в хранилище. Не фотография —
    // вернётся как есть.
    const normalized = await normalizeUploadImage(raw, { name: parsed.data.name });
    const bytes = normalized.bytes;

    const sha256 = createHash('sha256').update(bytes).digest('hex');

    // de-dup by sha256 (so links are stable and cacheable)
    const existing = await db.select().from(fileAssets).where(and(eq(fileAssets.sha256, sha256), isNull(fileAssets.deletedAt))).limit(1);
    if (existing[0]) {
      const row = existing[0] as any;
      // Байты совпали — отдаём ЧУЖУЮ запись, владельцем остаётся первый загрузивший.
      // Поэтому вместе с файлом говорим, сможет ли загрузивший его вообще открыть: иначе
      // клиент честно рапортует «загружено», а первое же открытие даёт 403, и объяснить
      // это оператору нечем.
      return res.json({
        ok: true,
        deduped: true,
        canOpen: await canAccessFile((req as AuthenticatedRequest).user, {
          id: String(row.id),
          createdByUserId: row.createdByUserId ?? null,
        }),
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

    // Пишем на бокс временно — как страховку на случай, если Я.Диск не примет копию. Примет —
    // снимаем сразу: с прямой отдачей (D-073 → `/files/:id/url`) клиент качает с
    // Я.Диска сам, и копия на боксе никому не нужна, а место занимает.
    const rel = cacheRelPath(id, name);
    await writeBytes(join(uploadsDir(), rel), bytes);

    let diskPath: string | null = null;
    if (!baseYandexPath) {
      logWarn('file upload: YANDEX_DISK_BASE_PATH не настроен — файл остаётся на боксе', { fileId: id });
    } else {
      const candidate = yandexDiskPathForFile({ baseYandexPath, fileId: id, fileName: name, scope: (parsed.data.scope ?? null) as any });
      try {
        await uploadVerified({ diskPath: candidate, bytes, mime, sha256 });
        diskPath = candidate;
      } catch (e) {
        logWarn('file upload: Яндекс не принял копию — файл остаётся на боксе до files:offload-to-yandex', { fileId: id, error: String(e) });
      }
    }

    // Снимаем страховочную копию ТОЛЬКО когда Я.Диск подтвердил свою (`uploadVerified` сверил
    // размер и дайджест). Не подтвердил — копия на боксе остаётся единственной, и строка
    // помечается 'local', её доводит files:offload-to-yandex.
    if (diskPath) await unlinkAsync(join(uploadsDir(), rel)).catch(() => {});

    await db.insert(fileAssets).values({
      id,
      createdAt,
      createdByUserId: actor.id,
      name,
      mime,
      size,
      sha256,
      storageKind: diskPath ? 'yandex' : 'local',
      localRelPath: diskPath ? null : rel,
      yandexDiskPath: diskPath,
      localCachedAt: null,
    });

    return res.json({ ok: true, file: { id, name, size, mime, sha256, createdAt } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

function attachmentHeaders(row: any, res: Response, mimeFallback?: string | null) {
  res.setHeader('Content-Type', row.mime || mimeFallback || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(String(row.name || 'file'))}"`);
}

// Промах кэша: забрать с Я.Диска, отдать, и — если байты совпали со строкой — положить копию
// в кэш (прогрев). Прогрев best-effort: клиент получает файл в любом случае.
async function sendYandexFile(row: any, res: Response) {
  const diskPath = String(row.yandexDiskPath || '');
  if (!diskPath) return res.status(500).json({ ok: false, error: 'путь yandex_disk_path не указан' });
  const href = await getDownloadHref(diskPath);
  const r = await fetch(href);
  if (!r.ok) return res.status(502).json({ ok: false, error: `ошибка загрузки из Yandex: HTTP ${r.status}` });
  const buf = Buffer.from(await r.arrayBuffer());
  attachmentHeaders(row, res, r.headers.get('content-type'));
  res.end(buf);

  // Копию на бокс НЕ кладём: кэша больше нет. Раньше здесь был прогрев, и он же наполнял
  // диск — за один «фотографический» день 1.5 ГБ (14.09). Сверка скачанного с sha256 строки
  // тоже ушла вместе с прогревом: она защищала кэш от порчи, а клиенту байты уже отданы.
}

filesRouter.get('/:id', requirePermission(PermissionCode.FilesView), async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'id не указан' });

    const rows = await db.select().from(fileAssets).where(and(eq(fileAssets.id, id as any), isNull(fileAssets.deletedAt))).limit(1);
    const row = rows[0] as any;
    if (!row) return res.status(404).json({ ok: false, error: 'файл не найден' });
    if (!(await canAccessFile((req as AuthenticatedRequest).user, row))) return res.status(403).json({ ok: false, error: 'доступ запрещён' });

    if (row.storageKind !== 'local' && row.storageKind !== 'yandex') {
      return res.status(500).json({ ok: false, error: `неизвестный тип хранения: ${String(row.storageKind)}` });
    }
    countAccess(id);

    // Есть локальная копия (единственная у 'local', кэш у 'yandex') — отдаём с диска.
    const rel = String(row.localRelPath || '');
    if (rel) {
      const abs = join(uploadsDir(), rel);
      const stream = createReadStream(abs);
      // Headers only once the file is actually open: on an open error the response below
      // must be plain JSON, not a JSON body labelled as an attachment.
      stream.once('open', () => attachmentHeaders(row, res));
      stream.on('error', (err) => {
        // Копию могли снять между SELECT и open (эвикция кэша / files:offload-to-yandex) —
        // перечитать строку и отдать с Яндекса; всё остальное — 404.
        void (async () => {
          if (res.headersSent) return res.end();
          const fresh = (await db.select().from(fileAssets).where(and(eq(fileAssets.id, id as any), isNull(fileAssets.deletedAt))).limit(1))[0] as any;
          if (fresh?.yandexDiskPath) return sendYandexFile(fresh, res);
          return res.status(404).json({ ok: false, error: `файл не найден на диске (${String((err as any)?.code ?? err)})` });
        })().catch((e) => {
          if (!res.headersSent) res.status(500).json({ ok: false, error: String(e) });
          else res.end();
        });
      });
      return stream.pipe(res);
    }

    if (row.yandexDiskPath) return sendYandexFile(row, res);
    return res.status(500).json({ ok: false, error: 'у файла нет ни локальной копии, ни пути на Яндексе' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

filesRouter.delete('/:id', requirePermission(PermissionCode.FilesDelete), async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'id не указан' });

    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'пользователь не найден' });

    const rows = await db.select().from(fileAssets).where(and(eq(fileAssets.id, id as any), isNull(fileAssets.deletedAt))).limit(1);
    const row = rows[0] as any;
    if (!row) return res.status(404).json({ ok: false, error: 'файл не найден' });

    const actorRole = String(actor.role || '').toLowerCase();
    const actorIsAdmin = actorRole === 'admin' || actorRole === 'superadmin';
    const ownerUserId = row.createdByUserId ? String(row.createdByUserId) : null;
    if (!actorIsAdmin && ownerUserId && ownerUserId !== actor.id) {
      const ts = nowMs();
      const ownerUser = ownerUserId ? await getEmployeeAuthById(ownerUserId) : null;
      const ownerUsername = ownerUser ? ownerUser.fullName || ownerUser.login || ownerUser.id : null;

      await db.insert(changeRequests).values({
        id: randomUUID(),
        status: 'pending',
        tableName: 'file_assets',
        rowId: id as any,
        rootEntityId: null,
        beforeJson: JSON.stringify({ id, deleted_at: null }),
        afterJson: JSON.stringify({ id, deleted_at: ts }),
        recordOwnerUserId: ownerUserId as any,
        recordOwnerUsername: ownerUsername,
        changeAuthorUserId: actor.id as any,
        changeAuthorUsername: actor.username,
        note: 'files.delete',
        createdAt: ts,
        decidedAt: null,
        decidedByUserId: null,
        decidedByUsername: null,
      });

      return res.json({ ok: true, queued: true });
    }

    // Soft-delete first, under a guard, and take the physical locations from the row as it
    // was at that instant: a concurrent files:offload-to-yandex may have just moved the bytes.
    const gone = await db
      .update(fileAssets)
      .set({ deletedAt: nowMs() })
      .where(and(eq(fileAssets.id, id as any), isNull(fileAssets.deletedAt)))
      .returning({
        storageKind: fileAssets.storageKind,
        localRelPath: fileAssets.localRelPath,
        yandexDiskPath: fileAssets.yandexDiskPath,
        previewLocalRelPath: fileAssets.previewLocalRelPath,
      });
    const cur = gone[0];
    if (!cur) return res.status(404).json({ ok: false, error: 'файл не найден' });

    // Физические копии — best-effort: строка уже помечена удалённой. Локальная копия есть
    // и у 'local' (единственная), и у 'yandex' (кэш) — снимаем обе.
    const previewRel = String(cur.previewLocalRelPath || '');
    if (previewRel) await unlinkAsync(join(uploadsDir(), previewRel)).catch(() => {});
    const rel = String(cur.localRelPath || '');
    if (rel) await unlinkAsync(join(uploadsDir(), rel)).catch(() => {});
    if (cur.storageKind === 'yandex') {
      const diskPath = String(cur.yandexDiskPath || '');
      if (diskPath) await deletePath(diskPath).catch(() => {});
    }


    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});


