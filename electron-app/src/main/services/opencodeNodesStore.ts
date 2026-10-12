import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { app } from 'electron';
import { normalizeOpencodeNodes, OPENCODE_PROBE_TIMEOUT_MS, type OpencodeNode, type OpencodeNodeProbe } from '@matricarmz/shared';

import { fetchWithRetry } from './netFetch.js';

// Локальный реестр узлов opencode serve (мандат brain 2026-10-12
// opencode-silent-deploy). Живёт в userData как standalone JSON — вне git
// (адреса LAN в публичный репо не кладём) и вне синхронизируемой SQLite.
const FILE_NAME = 'opencode-nodes.json';

function storeFilePath(): string {
  return join(app.getPath('userData'), FILE_NAME);
}

export function opencodeNodesFilePath(): string {
  return storeFilePath();
}

export async function opencodeNodesList(): Promise<OpencodeNode[]> {
  try {
    const raw = await readFile(storeFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as { nodes?: unknown };
    return normalizeOpencodeNodes(parsed?.nodes);
  } catch {
    return [];
  }
}

export async function opencodeNodesSave(nodes: OpencodeNode[]): Promise<OpencodeNode[]> {
  const clean = normalizeOpencodeNodes(nodes);
  try {
    await writeFile(storeFilePath(), JSON.stringify({ nodes: clean }, null, 2), 'utf8');
  } catch {
    // best-effort: реестр — удобство суперадмина, не блокируем ответ
  }
  return clean;
}

/**
 * Одна HTTP-проба узла: live = любой HTTP-ответ (включая 404 — serve жив,
 * маршрута нет), dead = сеть/таймаут. Тело не читаем, только статус.
 */
export async function probeOpencodeNode(url: string): Promise<OpencodeNodeProbe> {
  const started = Date.now();
  try {
    const res = await fetchWithRetry(url, { method: 'GET' }, { attempts: 1, timeoutMs: OPENCODE_PROBE_TIMEOUT_MS, allowOffline: true });
    return { url, live: true, httpStatus: res.status, ms: Date.now() - started, error: null };
  } catch (e) {
    return { url, live: false, httpStatus: null, ms: Date.now() - started, error: String((e as Error)?.message ?? e) };
  }
}

export async function probeOpencodeNodes(): Promise<OpencodeNodeProbe[]> {
  const nodes = await opencodeNodesList();
  return Promise.all(nodes.map((n) => probeOpencodeNode(n.url)));
}
