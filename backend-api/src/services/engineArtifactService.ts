import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { getUpdatesDir } from './updateTorrentService.js';

/**
 * Раздача локального движка Ииваныча с нашего сервера.
 *
 * Движок — чужой продукт (opencode CLI), версии выходят независимо. Поэтому
 * мы раздаём **рекомендованную** версию: манифест в `<updatesDir>/engine/`
 * кладёт владелец (или скрипт), клиент берёт именно её и никогда не «любую
 * свежую» — иначе чужой релиз с изменённым API положит Ииваныча у всего парка.
 *
 * Файлы: `manifest.json` (описание) и архив движка рядом с ним.
 */

export type EngineArtifactManifest = {
  version: string;
  fileName: string;
  /** sha512 в hex. */
  sha512: string;
  size: number;
  /** Минимальная версия клиента, которой этот движок годится. */
  minClientVersion: string | null;
  updatedAt: string | null;
};

export function engineDir(): string | null {
  const dir = getUpdatesDir();
  if (!dir) return null;
  return join(dir, 'engine');
}

export function engineManifestPath(): string | null {
  const dir = engineDir();
  return dir ? join(dir, 'manifest.json') : null;
}

export function engineArtifactPath(fileName: string): string | null {
  const dir = engineDir();
  return dir ? join(dir, fileName) : null;
}

export async function readEngineManifest(): Promise<EngineArtifactManifest | null> {
  const { readFile } = await import('node:fs/promises');
  const path = engineManifestPath();
  if (!path) return null;
  const raw = await readFile(path, 'utf8').catch(() => '');
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<EngineArtifactManifest>;
    const version = String(parsed?.version ?? '').trim();
    const fileName = String(parsed?.fileName ?? '').trim();
    const sha512 = String(parsed?.sha512 ?? '').trim().toLowerCase();
    if (!version || !fileName || !/^[0-9a-f]{128}$/.test(sha512)) return null;
    return {
      version,
      fileName,
      sha512,
      size: Number(parsed?.size ?? 0) || 0,
      minClientVersion: parsed?.minClientVersion ? String(parsed.minClientVersion) : null,
      updatedAt: parsed?.updatedAt ? String(parsed.updatedAt) : null,
    };
  } catch {
    return null;
  }
}

export type EngineManifestResponse = {
  ok: true;
  version: string;
  fileName: string;
  url: string;
  sha512: string;
  size: number;
  minClientVersion: string | null;
  updatedAt: string | null;
};

export async function getEngineManifest(baseUrl: string): Promise<EngineManifestResponse | null> {
  const manifest = await readEngineManifest();
  const path = manifest ? engineArtifactPath(manifest.fileName) : null;
  if (!manifest || !path) return null;
  const statRes = await stat(path).catch(() => null);
  if (!statRes?.isFile()) return null;
  return {
    ok: true,
    version: manifest.version,
    fileName: manifest.fileName,
    url: `${baseUrl}/updates/engine/file/${manifest.fileName}`,
    sha512: manifest.sha512,
    size: statRes.size,
    minClientVersion: manifest.minClientVersion,
    updatedAt: manifest.updatedAt,
  };
}

/** Отдаём архив движка с поддержкой Range — как installer клиента. */
export async function streamEngineArtifact(
  fileName: string,
  rangeHeader: string | undefined,
  onHeaders: (headers: Record<string, string>) => void,
): Promise<{ status: number; stream?: ReturnType<typeof createReadStream> }> {
  const manifest = await readEngineManifest();
  const path = manifest ? engineArtifactPath(manifest.fileName) : null;
  if (!manifest || !path || manifest.fileName !== fileName) return { status: 404 };
  const statRes = await stat(path).catch(() => null);
  if (!statRes?.isFile()) return { status: 404 };
  const size = statRes.size;
  onHeaders({
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="${fileName}"`,
  });
  const range = parseRangeHeader(rangeHeader, size);
  if (range) {
    onHeaders({
      'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
    });
    return { status: 206, stream: createReadStream(path, { start: range.start, end: range.end }) };
  }
  onHeaders({ 'Content-Length': String(size) });
  return { status: 200, stream: createReadStream(path) };
}

export function parseRangeHeader(rangeHeader: string | undefined, size: number): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const m = rangeHeader.match(/bytes=(\d+)-(\d+)?/i);
  if (!m) return null;
  const start = Number(m[1] ?? 0);
  const end = m[2] != null && m[2] !== '' ? Number(m[2]) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}
