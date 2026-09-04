import { describe, expect, it, vi } from 'vitest';

import { cacheExpiresAt, cacheRelPath, evictOne, isCacheExpired, parseCacheTtlDays, type CacheRow, type EvictDeps } from './fileCachePlan.js';

const DAY = 24 * 60 * 60 * 1000;

describe('parseCacheTtlDays', () => {
  it('по умолчанию 3 дня, пустая строка — тоже умолчание', () => {
    expect(parseCacheTtlDays(undefined)).toBe(3);
    expect(parseCacheTtlDays('  ')).toBe(3);
    expect(parseCacheTtlDays('7')).toBe(7);
  });
  it('ноль, отрицательное и суффиксы — ошибка конфигурации, а не молчаливое умолчание', () => {
    expect(() => parseCacheTtlDays('0')).toThrow(/≥ 1/);
    expect(() => parseCacheTtlDays('3d')).toThrow(/MATRICA_LOCAL_CACHE_TTL_DAYS/);
    expect(() => parseCacheTtlDays('-1')).toThrow();
  });
});

describe('cacheRelPath', () => {
  it('повторяет прежнюю локальную раскладку local/<2 hex>/<uuid>_<name>', () => {
    const rel = cacheRelPath('ab12cdef-0000-4000-8000-000000000000', 'фото.jpg').replaceAll('\\', '/');
    expect(rel).toBe('local/ab/ab12cdef-0000-4000-8000-000000000000_фото.jpg');
  });
});

describe('isCacheExpired', () => {
  const ttl = 3 * DAY;
  it('точка отсчёта — самое позднее из created / cached / accessed', () => {
    const t0 = 1_000_000;
    expect(cacheExpiresAt({ createdAt: t0, localCachedAt: null, lastAccessedAt: null }, ttl)).toBe(t0 + ttl);
    expect(cacheExpiresAt({ createdAt: t0, localCachedAt: t0 + DAY, lastAccessedAt: null }, ttl)).toBe(t0 + DAY + ttl);
    expect(cacheExpiresAt({ createdAt: t0, localCachedAt: t0 + DAY, lastAccessedAt: t0 + 2 * DAY }, ttl)).toBe(t0 + 2 * DAY + ttl);
  });
  it('строка без local_cached_at (положена до миграции) живёт TTL от created_at, а не протухает сразу', () => {
    const t0 = 1_000_000;
    expect(isCacheExpired({ createdAt: t0, localCachedAt: null, lastAccessedAt: null }, ttl, t0 + ttl - 1)).toBe(false);
    expect(isCacheExpired({ createdAt: t0, localCachedAt: null, lastAccessedAt: null }, ttl, t0 + ttl)).toBe(true);
  });
  it('обращение продлевает жизнь копии', () => {
    const t0 = 1_000_000;
    const touched = { createdAt: t0, localCachedAt: t0, lastAccessedAt: t0 + 2 * DAY };
    expect(isCacheExpired(touched, ttl, t0 + 4 * DAY)).toBe(false);
    expect(isCacheExpired(touched, ttl, t0 + 5 * DAY)).toBe(true);
  });
});

function row(over: Partial<CacheRow> = {}): CacheRow {
  return {
    id: 'ab12cdef-0000-4000-8000-000000000000',
    size: 3,
    sha256: 'AAA',
    createdAt: 1,
    localCachedAt: 1,
    lastAccessedAt: null,
    localRelPath: 'local/ab/x',
    yandexDiskPath: '/base/offloaded/ab/x',
    ...over,
  };
}

function deps(over: Partial<EvictDeps> = {}) {
  const d: EvictDeps = {
    exists: vi.fn(() => true),
    hash: vi.fn(async () => ({ sha256: 'aaa', md5: 'm' })),
    info: vi.fn(async () => ({ type: 'file', size: 3, sha256: 'aaa', md5: 'm' })),
    detach: vi.fn(async () => 1),
    unlink: vi.fn(),
    ...over,
  };
  return d;
}

describe('evictOne', () => {
  it('счастливый путь: подтвердил на Яндексе → снял путь → unlink, ровно в этом порядке', async () => {
    const order: string[] = [];
    const d = deps({
      info: vi.fn(async () => {
        order.push('info');
        return { type: 'file', size: 3, sha256: 'aaa', md5: 'm' };
      }),
      detach: vi.fn(async () => {
        order.push('detach');
        return 1;
      }),
      unlink: vi.fn(() => {
        order.push('unlink');
      }),
    });
    expect(await evictOne(row(), 'up', d)).toEqual({ status: 'evicted', bytes: 3 });
    expect(order).toEqual(['info', 'detach', 'unlink']);
  });

  it('без пути на Яндексе копия на боксе единственная — не трогать', async () => {
    const d = deps();
    const r = await evictOne(row({ yandexDiskPath: null }), 'up', d);
    expect(r.status).toBe('kept');
    expect(d.unlink).not.toHaveBeenCalled();
    expect(d.detach).not.toHaveBeenCalled();
  });

  it('файла нет на диске — строка отвязывается, чтобы GET не пытался снова, unlink не зовётся', async () => {
    const d = deps({ exists: vi.fn(() => false) });
    expect(await evictOne(row(), 'up', d)).toEqual({ status: 'gone' });
    expect(d.detach).toHaveBeenCalledWith(row().id, 'local/ab/x');
    expect(d.unlink).not.toHaveBeenCalled();
  });

  it('локальные байты не совпадают со строкой — оставить: неизвестно, что именно мы сверяем', async () => {
    const d = deps({ hash: vi.fn(async () => ({ sha256: 'bbb', md5: 'm' })) });
    const r = await evictOne(row(), 'up', d);
    expect(r).toMatchObject({ status: 'kept', reason: expect.stringContaining('sha256') });
    expect(d.info).not.toHaveBeenCalled();
    expect(d.unlink).not.toHaveBeenCalled();
  });

  it('Яндекс не подтвердил копию (размер разошёлся) — оставить, строку не трогать', async () => {
    const d = deps({ info: vi.fn(async () => ({ type: 'file', size: 2, sha256: 'aaa', md5: 'm' })) });
    const r = await evictOne(row(), 'up', d);
    expect(r).toMatchObject({ status: 'kept', reason: expect.stringContaining('размер') });
    expect(d.detach).not.toHaveBeenCalled();
    expect(d.unlink).not.toHaveBeenCalled();
  });

  it('Яндекс без дайджестов — отказ, а не пропуск', async () => {
    const d = deps({ info: vi.fn(async () => ({ type: 'file', size: 3, sha256: null, md5: null })) });
    expect((await evictOne(row(), 'up', d)).status).toBe('kept');
    expect(d.unlink).not.toHaveBeenCalled();
  });

  it('строка изменилась между проверкой и снятием пути (0 строк) — файл остаётся', async () => {
    const d = deps({ detach: vi.fn(async () => 0) });
    const r = await evictOne(row(), 'up', d);
    expect(r).toMatchObject({ status: 'kept', reason: expect.stringContaining('изменилась') });
    expect(d.unlink).not.toHaveBeenCalled();
  });
});
