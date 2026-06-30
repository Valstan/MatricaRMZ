// Pure helpers for parsing Yandex Disk public-resource API responses.
// Boot-path safe: no Electron imports, no I/O.
//
// Background (F2 in the updater refactor plan): the Yandex Disk download
// flow used to validate the installer against the **prod server's** sha256,
// which is the sha256 of the artifact from the GitHub release. Yandex.Disk
// hosts an independently uploaded build; since `electron-builder` outputs
// are not byte-deterministic (timestamps, signing), the two artifacts of
// the same version typically have different sha256. Result: integrity
// check would always fail for the Yandex-source flow.
//
// Yandex's public-resource API returns `size`, `md5`, and `sha256` for each
// file. These helpers extract those fields safely so the Yandex flow can
// validate the downloaded installer against its OWN sha256.

export type YandexResourceMeta = {
  size: number | null;
  sha256: string | null;
  md5: string | null;
};

function asNumber(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function asHexString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  // Yandex returns lowercase hex; SHA256 = 64 chars, MD5 = 32 chars.
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/**
 * Extract a single resource's meta from the JSON body returned by
 * `GET /v1/disk/public/resources?public_key=…&path=…` or one element of
 * `_embedded.items` from the same endpoint when path points to a folder.
 *
 * Tolerates missing or wrong-typed fields by returning nulls for them.
 */
export function extractYandexResourceMeta(json: unknown): YandexResourceMeta {
  if (!json || typeof json !== 'object') {
    return { size: null, sha256: null, md5: null };
  }
  const obj = json as Record<string, unknown>;
  return {
    size: asNumber(obj.size),
    sha256: asHexString(obj.sha256),
    md5: asHexString(obj.md5),
  };
}

/**
 * Extract `_embedded.items[]` entries with their meta, for folder listing.
 */
export function extractYandexFolderItems(
  json: unknown,
): Array<{ name: string; meta: YandexResourceMeta }> {
  if (!json || typeof json !== 'object') return [];
  const obj = json as Record<string, unknown>;
  const embedded = obj._embedded as Record<string, unknown> | undefined;
  const items = embedded?.items;
  if (!Array.isArray(items)) return [];
  return items
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const r = raw as Record<string, unknown>;
      const name = typeof r.name === 'string' ? r.name : '';
      if (!name) return null;
      return { name, meta: extractYandexResourceMeta(r) };
    })
    .filter((x): x is { name: string; meta: YandexResourceMeta } => x !== null);
}
