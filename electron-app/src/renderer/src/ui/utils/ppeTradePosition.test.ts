import { describe, expect, it } from 'vitest';

import { buildTradeByNom, resolveTradePosition } from './ppeTradePosition.js';

describe('торговые данные позиции набора (промты КАРМАНА #20/#25)', () => {
  it('торговое наименование позиции побеждает справочное имя номенклатуры', () => {
    const map = buildTradeByNom([
      { nomenclatureId: 'base-1', tradeName: 'Костюм МОТОР', certificate: 'ЕАЭС N RU Д-CN.РА08.В.38076/23' },
    ]);
    const trade = resolveTradePosition(map, 'base-1');
    expect(trade?.name).toBe('Костюм МОТОР');
    expect(trade?.certificate).toBe('ЕАЭС N RU Д-CN.РА08.В.38076/23');
  });

  it('размерный вариант берёт торговые данные своей базы', () => {
    const map = buildTradeByNom(
      [{ nomenclatureId: 'base-2', tradeName: 'Сапоги ТОФФ АЛЬП', certificate: 'CERT-2' }],
      new Map([['size-43', 'base-2']]),
    );
    expect(resolveTradePosition(map, 'size-43')?.name).toBe('Сапоги ТОФФ АЛЬП');
    expect(resolveTradePosition(map, 'size-43')?.certificate).toBe('CERT-2');
  });

  it('без торговых данных остаётся null — печатаем справочное', () => {
    const map = buildTradeByNom([{ nomenclatureId: 'base-3' }]);
    expect(resolveTradePosition(map, 'base-3')).toEqual({ name: null, certificate: null });
    expect(resolveTradePosition(map, 'unknown')).toBeNull();
  });

  it('сертификат позиции отличается от сертификата другой профессии — свои у каждой', () => {
    const map = buildTradeByNom([
      { nomenclatureId: 'base-4', tradeName: 'Перчатки х.б. … ЛАЙТ/BERD', certificate: 'CERT-A' },
      { nomenclatureId: 'base-5', tradeName: 'Перчатки х.б. … ЛАЙТ/BERD', certificate: 'CERT-B' },
    ]);
    expect(resolveTradePosition(map, 'base-4')?.certificate).toBe('CERT-A');
    expect(resolveTradePosition(map, 'base-5')?.certificate).toBe('CERT-B');
  });
});
