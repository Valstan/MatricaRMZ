import { describe, expect, it } from 'vitest';

import {
  extractYandexFolderItems,
  extractYandexResourceMeta,
} from './yandexResourceMeta.js';

describe('extractYandexResourceMeta', () => {
  it('parses size + sha256 + md5 from a typical single-resource response', () => {
    const meta = extractYandexResourceMeta({
      name: 'MatricaRMZ-Setup-1.32.0.exe',
      size: 89505975,
      sha256: 'C32417977B47425152B66DA0C3E042BD5F02B295E16C568ABC3FD38C77068486',
      md5: 'abc123def4567890abc123def4567890',
    });
    expect(meta.size).toBe(89505975);
    expect(meta.sha256).toBe('c32417977b47425152b66da0c3e042bd5f02b295e16c568abc3fd38c77068486');
    expect(meta.md5).toBe('abc123def4567890abc123def4567890');
  });

  it('returns nulls for missing fields', () => {
    expect(extractYandexResourceMeta({})).toEqual({ size: null, sha256: null, md5: null });
  });

  it('rejects non-hex strings as sha256', () => {
    const meta = extractYandexResourceMeta({ sha256: 'not-hex-at-all!' });
    expect(meta.sha256).toBeNull();
  });

  it('rejects negative or zero size', () => {
    expect(extractYandexResourceMeta({ size: 0 }).size).toBeNull();
    expect(extractYandexResourceMeta({ size: -1 }).size).toBeNull();
  });

  it('rejects size that cannot be parsed as a number', () => {
    expect(extractYandexResourceMeta({ size: 'big' }).size).toBeNull();
  });

  it('returns all nulls for null/undefined/non-object input', () => {
    expect(extractYandexResourceMeta(null)).toEqual({ size: null, sha256: null, md5: null });
    expect(extractYandexResourceMeta(undefined)).toEqual({ size: null, sha256: null, md5: null });
    expect(extractYandexResourceMeta('garbage')).toEqual({ size: null, sha256: null, md5: null });
  });
});

describe('extractYandexFolderItems', () => {
  it('parses _embedded.items with meta for each entry', () => {
    const items = extractYandexFolderItems({
      _embedded: {
        items: [
          {
            name: 'MatricaRMZ-Setup-1.32.0.exe',
            size: 89505975,
            sha256: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
          },
          {
            name: 'MatricaRMZ-Setup-1.31.2.exe',
            size: 89505975,
            sha256: 'c32417977b47425152b66da0c3e042bd5f02b295e16c568abc3fd38c77068486',
          },
        ],
      },
    });
    expect(items).toHaveLength(2);
    expect(items[0]?.name).toBe('MatricaRMZ-Setup-1.32.0.exe');
    expect(items[0]?.meta.sha256).toBe('aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888');
    expect(items[1]?.meta.size).toBe(89505975);
  });

  it('skips entries without a name', () => {
    const items = extractYandexFolderItems({
      _embedded: { items: [{ size: 100 }, { name: 'real.exe', size: 100 }] },
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.name).toBe('real.exe');
  });

  it('returns empty when _embedded is missing or malformed', () => {
    expect(extractYandexFolderItems({})).toEqual([]);
    expect(extractYandexFolderItems({ _embedded: 'wrong type' })).toEqual([]);
    expect(extractYandexFolderItems({ _embedded: { items: 'wrong type' } })).toEqual([]);
    expect(extractYandexFolderItems(null)).toEqual([]);
  });
});
