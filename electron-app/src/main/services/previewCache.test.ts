import { describe, expect, it } from 'vitest';

import { PreviewCache } from './previewCache.js';

// Кэш превью в main: повторное открытие списка не должно ходить на сервер за теми же картинками.
describe('PreviewCache', () => {
  it('отдаёт положенное и помнит «превью нет»', () => {
    const c = new PreviewCache();
    c.set('a', 'data:image/png;base64,AAAA');
    c.set('b', null);
    expect(c.get('a')?.dataUrl).toBe('data:image/png;base64,AAAA');
    expect(c.get('b')).toEqual({ dataUrl: null });
    expect(c.get('zzz')).toBeUndefined();
  });

  it('вытесняет самое давнее по обращению при переполнении по числу записей', () => {
    const c = new PreviewCache(2, 1_000_000);
    c.set('a', 'x');
    c.set('b', 'y');
    c.get('a');
    c.set('c', 'z');
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')?.dataUrl).toBe('x');
    expect(c.get('c')?.dataUrl).toBe('z');
  });

  it('держит сумму байт в лимите и не берёт запись крупнее лимита', () => {
    const c = new PreviewCache(100, 10);
    c.set('a', '12345');
    c.set('b', '12345');
    expect(c.totalBytes).toBe(10);
    c.set('c', '123');
    expect(c.get('a')).toBeUndefined();
    expect(c.totalBytes).toBe(8);
    c.set('big', '12345678901');
    expect(c.get('big')).toBeUndefined();
  });

  it('удаление и перезапись не ломают счётчик байт', () => {
    const c = new PreviewCache();
    c.set('a', '1234');
    c.set('a', '12');
    expect(c.totalBytes).toBe(2);
    c.delete('a');
    expect(c.totalBytes).toBe(0);
    expect(c.size).toBe(0);
    c.delete('a');
    expect(c.totalBytes).toBe(0);
  });
});
