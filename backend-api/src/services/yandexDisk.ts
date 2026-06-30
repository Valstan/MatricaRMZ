import { createReadStream } from 'node:fs';
import { dirname } from 'node:path';

export type YandexDiskListItem = {
  name: string;
  path: string; // usually "disk:/..." from API
  type: 'file' | 'dir' | string;
  size?: number;
  modified?: string;
};

function tokenFromEnv(): string {
  const token = (process.env.YANDEX_DISK_TOKEN ?? '').trim();
  if (!token) throw new Error('YANDEX_DISK_TOKEN is not configured');
  return token;
}

export function normalizeDiskPath(raw: string): string {
  const p = String(raw ?? '').trim().replaceAll('\\', '/');
  if (!p) throw new Error('empty yandex path');
  if (!p.startsWith('/')) throw new Error(`Invalid yandex path (must start with '/'): ${raw}`);
  // keep root as '/'
  return p === '/' ? '/' : p.replace(/\/+$/, '');
}

async function yandexEnsureFolder(token: string, folderPath: string) {
  const p = normalizeDiskPath(folderPath);
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

export async function ensureFolderDeep(folderPath: string) {
  const token = tokenFromEnv();
  const p = normalizeDiskPath(folderPath);
  if (p === '/') return;
  const parts = p.split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur += `/${part}`;
    // mkdir is idempotent via yandexEnsureFolder (GET then PUT)
    await yandexEnsureFolder(token, cur);
  }
}

export async function getUploadHref(args: { diskPath: string; overwrite?: boolean; ensureParent?: boolean }): Promise<string> {
  const token = tokenFromEnv();
  const diskPath = normalizeDiskPath(args.diskPath);

  if (args.ensureParent ?? true) {
    const parent = dirname(diskPath.replaceAll('\\', '/')) || '/';
    await ensureFolderDeep(parent);
  }

  const q = new URL('https://cloud-api.yandex.net/v1/disk/resources/upload');
  q.searchParams.set('path', diskPath);
  q.searchParams.set('overwrite', (args.overwrite ?? true) ? 'true' : 'false');
  const r1 = await fetch(q.toString(), { headers: { Authorization: `OAuth ${token}` } });
  if (!r1.ok) throw new Error(`yandex upload href HTTP ${r1.status}: ${(await r1.text().catch(() => '')) || 'no body'}`);
  const j = (await r1.json().catch(() => null)) as any;
  const href = String(j?.href ?? '');
  if (!href) throw new Error('yandex upload href missing');
  return href;
}

export async function uploadBytes(args: { diskPath: string; bytes: Buffer; mime?: string | null }) {
  const href = await getUploadHref({ diskPath: args.diskPath, overwrite: true, ensureParent: true });
  const init: RequestInit = {
    method: 'PUT',
    // Buffer не входит в BodyInit по типам TS здесь, поэтому используем Uint8Array.
    body: new Uint8Array(args.bytes),
  };
  if (args.mime) init.headers = { 'Content-Type': args.mime };
  const r2 = await fetch(href, init);
  if (!r2.ok) throw new Error(`yandex upload PUT HTTP ${r2.status}: ${(await r2.text().catch(() => '')) || 'no body'}`);
}

export async function uploadFileStream(args: { diskPath: string; localFilePath: string; mime?: string | null }) {
  const href = await getUploadHref({ diskPath: args.diskPath, overwrite: true, ensureParent: true });
  const rs = createReadStream(args.localFilePath);
  // Node fetch requires duplex for streaming request bodies, but TS RequestInit type doesn't include it.
  const init: any = {
    method: 'PUT',
    duplex: 'half',
    body: rs,
  };
  if (args.mime) init.headers = { 'Content-Type': args.mime };
  const r = await fetch(href, init as any);
  if (!r.ok) throw new Error(`yandex upload PUT HTTP ${r.status}: ${(await r.text().catch(() => '')) || 'no body'}`);
}

export async function getDownloadHref(diskPath: string): Promise<string> {
  const token = tokenFromEnv();
  const p = normalizeDiskPath(diskPath);
  const q = new URL('https://cloud-api.yandex.net/v1/disk/resources/download');
  q.searchParams.set('path', p);
  const r = await fetch(q.toString(), { headers: { Authorization: `OAuth ${token}` } });
  if (!r.ok) throw new Error(`yandex download href HTTP ${r.status}: ${(await r.text().catch(() => '')) || 'no body'}`);
  const j = (await r.json().catch(() => null)) as any;
  const href = String(j?.href ?? '');
  if (!href) throw new Error('yandex download href missing');
  return href;
}

export async function deletePath(diskPath: string): Promise<void> {
  const token = tokenFromEnv();
  const p = normalizeDiskPath(diskPath);
  const q = new URL('https://cloud-api.yandex.net/v1/disk/resources');
  q.searchParams.set('path', p);
  const r = await fetch(q.toString(), { method: 'DELETE', headers: { Authorization: `OAuth ${token}` } });
  if (!r.ok && r.status !== 404) {
    throw new Error(`yandex delete HTTP ${r.status}: ${(await r.text().catch(() => '')) || 'no body'}`);
  }
}

export async function listFolder(args: { folderPath: string; limit?: number; offset?: number; sort?: string }): Promise<YandexDiskListItem[]> {
  const token = tokenFromEnv();
  const p = normalizeDiskPath(args.folderPath);
  const url = new URL('https://cloud-api.yandex.net/v1/disk/resources');
  url.searchParams.set('path', p);
  url.searchParams.set('limit', String(args.limit ?? 200));
  url.searchParams.set('offset', String(args.offset ?? 0));
  if (args.sort) url.searchParams.set('sort', args.sort);

  const r = await fetch(url.toString(), { method: 'GET', headers: { Authorization: `OAuth ${token}` } });
  if (!r.ok) throw new Error(`yandex list HTTP ${r.status}: ${(await r.text().catch(() => '')) || 'no body'}`);
  const j = (await r.json().catch(() => null)) as any;
  const items = (j?._embedded?.items ?? []) as any[];
  return items
    .map((it) => {
      const out: YandexDiskListItem = {
        name: String(it?.name ?? ''),
        path: String(it?.path ?? ''),
        type: String(it?.type ?? ''),
      };
      if (it?.size != null) out.size = Number(it.size);
      if (typeof it?.modified === 'string') out.modified = it.modified;
      return out;
    })
    .filter((it) => it.name && it.path);
}

export async function listFolderAll(args: { folderPath: string; sort?: string; pageSize?: number; max?: number }): Promise<YandexDiskListItem[]> {
  const pageSize = Math.max(1, Math.min(500, args.pageSize ?? 200));
  const max = Math.max(1, args.max ?? 5000);
  const out: YandexDiskListItem[] = [];
  let offset = 0;
  while (out.length < max) {
    const req: { folderPath: string; limit: number; offset: number; sort?: string } = { folderPath: args.folderPath, limit: pageSize, offset };
    if (args.sort) req.sort = args.sort;
    const batch = await listFolder(req);
    if (batch.length === 0) break;
    out.push(...batch);
    offset += batch.length;
    if (batch.length < pageSize) break;
  }
  return out.slice(0, max);
}


