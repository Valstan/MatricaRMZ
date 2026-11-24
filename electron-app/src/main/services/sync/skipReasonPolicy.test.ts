import { describe, expect, it } from 'vitest';

import { lwwRejectedByTable, skippedRowAction } from './skipReasonPolicy.js';

/**
 * Отказ сервера «строка отвергнута как устаревшая» (план #114, шаг 28).
 *
 * До правки отказ был молчаливым: строка навсегда оставалась `pending` и уходила
 * в каждый push снова и снова (класс «строка создана локально, а на сервер не
 * уехала»). Теперь клиент по такому ответу снимает `pending`: серверная копия
 * новее, её привезёт pull.
 */
describe('отказ по устареванию снимает pending, а не крутит очередь', () => {
  it('причина lww_rejected опознаётся как свой отказ', () => {
    expect(skippedRowAction({ table: 'operations', row_id: 'op1', reason: 'lww_rejected' })).toBe('lww_rejected');
  });

  it('постоянный отказ остаётся постоянным (карантин и баннер оператору)', () => {
    expect(
      skippedRowAction({ table: 'operations', row_id: 'op1', reason: 'forbidden:repair_history_entry', permanent: true }),
    ).toBe('permanent');
  });

  it('нехватка зависимости остаётся временной (строка ждёт pull)', () => {
    expect(skippedRowAction({ table: 'operations', row_id: 'op1', reason: 'missing_dependency' })).toBe('dependency');
  });

  it('замок двигателя остаётся временным', () => {
    expect(skippedRowAction({ table: 'operations', row_id: 'op1', reason: 'reserved:tester:1700000000000' })).toBe('reserved');
  });

  it('строки, с которых снимается pending, собираются по таблицам', () => {
    const cleared = lwwRejectedByTable([
      { table: 'operations', row_id: 'op1', reason: 'lww_rejected' },
      { table: 'operations', row_id: 'op2', reason: 'lww_rejected' },
      { table: 'entities', row_id: 'e1', reason: 'lww_rejected' },
      { table: 'operations', row_id: 'op3', reason: 'forbidden:repair_history_entry', permanent: true },
      { table: 'operations', row_id: '', reason: 'lww_rejected' },
    ]);
    expect(cleared.get('operations')).toEqual(['op1', 'op2']);
    expect(cleared.get('entities')).toEqual(['e1']);
  });

  it('пустой ответ сервера не роняет разбор', () => {
    expect(lwwRejectedByTable([]).size).toBe(0);
  });
});
