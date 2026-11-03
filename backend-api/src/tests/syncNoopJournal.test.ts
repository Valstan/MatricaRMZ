/**
 * Журнал синхронизации — лог ИЗМЕНЕНИЙ. Пока он писал каждый пришедший пуш
 * подряд, клиент с зависшим pending раздувал журнал на ровном месте
 * (прод-инцидент 03.11.2026: 3.6 млн записей attribute_values за сутки от
 * одной машины, 89% журнала).
 *
 * Тест закрывает правило: содержимое не изменилось → в журнал строка не идёт,
 * а подтверждение клиенту уходит как обычно.
 */
import { describe, expect, it } from 'vitest';

import { isUnchangedAttributeValueRow } from '../services/sync/syncWriteService.js';

const stored = {
  valueJson: '"Кладовщик"',
  updatedAt: 1793686658884,
  deletedAt: null,
};

describe('журнал синхронизации: неизменившаяся строка — не изменение', () => {
  it('тот же id, значение, время и признак удаления — строка не изменилась', () => {
    expect(
      isUnchangedAttributeValueRow(stored, {
        id: '35b997f5-700e-4bd3-bce5-1c6f11976a5c',
        value_json: '"Кладовщик"',
        updated_at: 1793686658884,
        deleted_at: null,
      }),
    ).toBe(true);
  });

  it('изменилось значение — это изменение', () => {
    expect(
      isUnchangedAttributeValueRow(stored, {
        id: 'x',
        value_json: '"Инженер"',
        updated_at: 1793686658884,
        deleted_at: null,
      }),
    ).toBe(false);
  });

  it('изменилось время правки — это изменение', () => {
    expect(
      isUnchangedAttributeValueRow(stored, {
        id: 'x',
        value_json: '"Кладовщик"',
        updated_at: 1793686658885,
        deleted_at: null,
      }),
    ).toBe(false);
  });

  it('строка удалена (deleted_at) — это изменение', () => {
    expect(
      isUnchangedAttributeValueRow(stored, {
        id: 'x',
        value_json: '"Кладовщик"',
        updated_at: 1793686658884,
        deleted_at: 1793686658884,
      }),
    ).toBe(false);
  });

  it('строки на сервере ещё нет — это изменение', () => {
    expect(
      isUnchangedAttributeValueRow(null, {
        id: 'x',
        value_json: '"Кладовщик"',
        updated_at: 1793686658884,
        deleted_at: null,
      }),
    ).toBe(false);
  });

  it('строка "null" и пустое значение — одно и то же', () => {
    // Прод-случай: клиент присылал value_json="null", сервер хранил NULL.
    expect(
      isUnchangedAttributeValueRow(
        { valueJson: null, updatedAt: 1, deletedAt: null },
        { id: 'x', value_json: 'null', updated_at: 1, deleted_at: null },
      ),
    ).toBe(true);
  });
});
