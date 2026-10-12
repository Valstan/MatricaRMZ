// Реестр узлов opencode serve (мандат brain 2026-10-12 opencode-silent-deploy).
// Pure-домен: типы узла и результата пробы + нормализация списка из локального
// userData-реестра (`opencode-nodes.json`, в git не кладётся). Файловый слой —
// в electron-app (main/services/opencodeNodesStore.ts).

export type OpencodeNode = {
  name: string;
  url: string;
};

export type OpencodeNodeProbe = {
  url: string;
  live: boolean;
  httpStatus: number | null;
  ms: number;
  error: string | null;
};

/** Состояние встроенного харнесса (читает раздел «OpenCode-узлы», только суперадмин). */
export type OpencodeHarnessStatus = {
  installed: boolean;
  installedVersion: string;
  latestKnown: string;
  updateAvailable: boolean;
  running: boolean;
  serveVersion: string;
  firewallRulePresent: boolean;
  exePath: string;
  lastCheckAt: number | null;
  lastError: string | null;
};

/** Фиксированный порт `opencode serve` (решение владельца 12.10). */
export const OPENCODE_DEFAULT_PORT = 3080;

/** Таймаут одной HTTP-пробы узла (LAN — долго ждать нечего). */
export const OPENCODE_PROBE_TIMEOUT_MS = 5000;

const MAX_NODES = 50;
const MAX_NAME_LEN = 80;
const MAX_URL_LEN = 500;

/**
 * Нормализовать сырой список узлов: trim, схема http по умолчанию, порт 3080
 * при отсутствии явного, дедуп по url, битые записи отбрасываются.
 */
export function normalizeOpencodeNodes(input: unknown): OpencodeNode[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: OpencodeNode[] = [];
  for (const raw of input) {
    if (out.length >= MAX_NODES) break;
    const rec = raw as { name?: unknown; url?: unknown } | null;
    if (!rec || typeof rec !== 'object') continue;
    let url = String(rec.url ?? '').trim();
    if (!url || url.length > MAX_URL_LEN) continue;
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) url = `http://${url}`;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    if (!parsed.port) parsed.port = String(OPENCODE_DEFAULT_PORT);
    const normUrl = parsed.toString();
    const key = normUrl.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let name = String(rec.name ?? '').trim().slice(0, MAX_NAME_LEN);
    if (!name) name = parsed.hostname;
    out.push({ name, url: normUrl });
  }
  return out;
}
