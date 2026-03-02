export type PaginatedPartsResult =
  | {
      ok: true;
      parts: unknown[];
    }
  | {
      ok: false;
      error: string;
    };

const PARTS_LIST_LIMIT = 5000;
const MAX_OFFSET_GUARD = 1_000_000;
const LIST_ALL_PARTS_CACHE_MS = 30_000;

type PartsListArgs = {
  q?: string;
  engineBrandId?: string;
};

type PartsCacheEntry = {
  expiresAt: number;
  promise?: Promise<PaginatedPartsResult>;
  result?: PaginatedPartsResult;
  errorCount: number;
};

const partsListCache = new Map<string, PartsCacheEntry>();

function normalizeListAllPartsArgs(args: PartsListArgs = {}) {
  return {
    q: typeof args.q === 'string' ? args.q.trim() : '',
    engineBrandId: typeof args.engineBrandId === 'string' ? args.engineBrandId.trim() : '',
  };
}

function makeListAllPartsCacheKey(args: ReturnType<typeof normalizeListAllPartsArgs>) {
  return JSON.stringify(args);
}

type PartsListArgsWithPaging = PartsListArgs & { limit: number; offset: number };

async function fetchPartsPage(args: PartsListArgsWithPaging): Promise<{
  ok: boolean;
  parts?: unknown[];
  error?: string;
}> {
  return window.matrica.parts.list(args);
}

export async function listAllParts(args: PartsListArgs = {}): Promise<PaginatedPartsResult> {
  const normalized = normalizeListAllPartsArgs(args);
  const cacheKey = makeListAllPartsCacheKey(normalized);
  const now = Date.now();
  const cached = partsListCache.get(cacheKey);

  if (cached) {
    if (cached.result && cached.expiresAt > now) return cached.result;
    if (cached.promise && cached.expiresAt > now) return cached.promise;
  }

  const allParts: unknown[] = [];
  let offset = 0;

  const load = async () => {
    while (true) {
      const r = await fetchPartsPage({
        ...normalized,
        limit: PARTS_LIST_LIMIT,
        offset,
      }).catch((e) => ({ ok: false as const, error: String(e), parts: [] as unknown[] }));

      if (!r.ok) return { ok: false, error: String(r.error ?? 'unknown') };

      const chunk = Array.isArray(r.parts) ? r.parts : [];
      allParts.push(...chunk);

      if (chunk.length < PARTS_LIST_LIMIT) break;
      offset += PARTS_LIST_LIMIT;

      if (offset >= MAX_OFFSET_GUARD) {
        return { ok: false, error: 'слишком много данных для полной выгрузки деталей' };
      }
    }

    return { ok: true, parts: allParts };
  };

  const promise = load();
  partsListCache.set(cacheKey, {
    promise,
    expiresAt: now + LIST_ALL_PARTS_CACHE_MS,
    errorCount: 0,
  });

  try {
    const result = await promise;
    const current = partsListCache.get(cacheKey);
    partsListCache.set(cacheKey, {
      result,
      expiresAt: now + LIST_ALL_PARTS_CACHE_MS,
      errorCount: result.ok ? 0 : ((current?.errorCount ?? 0) + 1),
    });
    return result;
  } catch (error) {
    const current = partsListCache.get(cacheKey);
    partsListCache.set(cacheKey, {
      expiresAt: now + Math.min(10_000, LIST_ALL_PARTS_CACHE_MS),
      errorCount: (current?.errorCount ?? 0) + 1,
      result: { ok: false, error: String(error ?? 'unknown') },
    });
    return { ok: false, error: String(error ?? 'unknown') };
  }
}

export function invalidateListAllPartsCache(args?: PartsListArgs) {
  if (!args) {
    partsListCache.clear();
    return;
  }

  const hasQ = typeof args.q === 'string';
  const hasEngineBrandId = typeof args.engineBrandId === 'string';

  if (!hasQ && !hasEngineBrandId) {
    partsListCache.clear();
    return;
  }

  const normalizedQ = hasQ ? args.q.trim() : undefined;
  const normalizedBrandId = hasEngineBrandId ? args.engineBrandId.trim() : undefined;

  for (const key of Array.from(partsListCache.keys())) {
    let parsed: ReturnType<typeof normalizeListAllPartsArgs> | null = null;
    try {
      const parsedCandidate = JSON.parse(key);
      if (typeof parsedCandidate === 'object' && parsedCandidate !== null) {
        parsed = {
          q: typeof parsedCandidate.q === 'string' ? parsedCandidate.q : '',
          engineBrandId: typeof parsedCandidate.engineBrandId === 'string' ? parsedCandidate.engineBrandId : '',
        };
      }
    } catch {
      // Keep safe behavior for unexpected cache keys.
    }

    if (!parsed) continue;
    if (hasQ && parsed.q !== normalizedQ) continue;
    if (hasEngineBrandId && parsed.engineBrandId !== normalizedBrandId) continue;
    partsListCache.delete(key);
  }
}
