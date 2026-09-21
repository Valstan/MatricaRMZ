import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { engineInventoryLineId, sha1Bytes } from './engineInventoryLineId.js';

// Один id строки на сервер и клиент (E2.3). Чистый SHA-1 обязан совпадать с node:crypto бит в
// бит — иначе клиент и сервер породят два набора строк для одного листа.

function nodeV5(operationId: string, lineKey: string): string {
  const ns = Buffer.from('7e0a5e2c3b7f4d389a5b2c1f0b6d8e41', 'hex');
  const h = createHash('sha1').update(ns).update(`${operationId}\u0000${lineKey}`, 'utf8').digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

describe('sha1Bytes — совпадает с node:crypto', () => {
  it('пустая строка, "abc", длинное и кириллица (границы блока 55/56/64 байт)', () => {
    for (const s of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'Картер 240-1002015 · Поршень']) {
      const bytes = [...Buffer.from(s, 'utf8')];
      const ours = Buffer.from(sha1Bytes(bytes)).toString('hex');
      expect(ours, JSON.stringify(s.slice(0, 20))).toBe(createHash('sha1').update(s, 'utf8').digest('hex'));
    }
  });
});

describe('engineInventoryLineId', () => {
  it('равен серверному uuid v5 от (лист, ключ) — включая кириллицу и суффикс дубля', () => {
    const cases: Array<[string, string]> = [
      ['op-1', 'id:part-1'],
      ['5d2c3e1a-1111-4222-8333-444455556666', 'sig:картер|240-1002|240-1002015'],
      ['op-1', 'sig:прокладка ручная||#1'],
    ];
    for (const [op, key] of cases) {
      expect(engineInventoryLineId(op, key), key).toBe(nodeV5(op, key));
    }
  });

  it('детерминирован, различает лист и ключ, версия 5 / вариант RFC', () => {
    const a = engineInventoryLineId('op', 'id:p1');
    expect(a).toBe(engineInventoryLineId('op', 'id:p1'));
    expect(a).not.toBe(engineInventoryLineId('op', 'id:p2'));
    expect(a).not.toBe(engineInventoryLineId('op2', 'id:p1'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
