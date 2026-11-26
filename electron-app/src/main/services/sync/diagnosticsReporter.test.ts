/**
 * Снимок диагностики клиента — что сервер о машине знает.
 *
 * Инцидент 25.11.2026 (Android-машина `android-f54d96db…`): 622 строки
 * `erp_engine_inventory_lines` висели в pending больше часа, а сервер их не
 * видел — в снимке клиента было только 5 таблиц, и строк списка деталей среди
 * них не было. Ни автолечение, ни сверка не могли понять, что машина застряла.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildDiagnosticsSnapshot } from './diagnosticsReporter.js';

const emptyRow = {
  count: 0,
  maxUpdatedAt: null,
  sumUpdatedAt: null,
  pendingCount: 0,
  errorCount: 0,
  stuckCount: 0,
  oldestPendingAt: null,
};

function makeDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [emptyRow]),
        })),
        limit: vi.fn(async () => [emptyRow]),
      })),
    })),
  } as never;
}

describe('снимок диагностики клиента', () => {
  it('в снимке есть таблица строк списка деталей — иначе класс не виден серверу', async () => {
    const snapshot = await buildDiagnosticsSnapshot(makeDb());
    const tables = snapshot.tables as Record<string, any>;
    expect(Object.keys(tables)).toContain('erp_engine_inventory_lines');
    expect(tables.erp_engine_inventory_lines).toMatchObject({
      pendingCount: expect.any(Number),
      stuckCount: expect.any(Number),
    });
  });

  it('остальные таблицы снимка на месте — правило не разъехалось', async () => {
    const snapshot = await buildDiagnosticsSnapshot(makeDb());
    const tables = snapshot.tables as Record<string, any>;
    for (const name of ['entity_types', 'entities', 'attribute_defs', 'attribute_values', 'operations']) {
      expect(Object.keys(tables)).toContain(name);
    }
  });

  it('журнал действий в снимке есть — иначе его очередь не видит ни сервер, ни автолечение', async () => {
    // Инцидент 26.11.2026 (PC20): три строки `audit_log` висели двое суток, тревога
    // дошла только потому, что оператор жал кнопку. Таблицы не было в снимке.
    const snapshot = await buildDiagnosticsSnapshot(makeDb());
    const tables = snapshot.tables as Record<string, any>;
    expect(Object.keys(tables)).toContain('audit_log');
    expect(tables.audit_log).toMatchObject({
      pendingCount: expect.any(Number),
      stuckCount: expect.any(Number),
    });
  });
});
