// Гейт Ф3: наряды и складские документы на android-фасаде через НАСТОЯЩИЙ мост.
// Проверяется цеховой сценарий: наряд создаётся и правится ЛОКАЛЬНО (без сети),
// складской документ при отсутствии сети ложится в warehouse_command_outbox и
// уезжает при синке, а онлайн-действия сборки отказывают мягко, а не падают.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WarehouseDocumentType } from '@matricarmz/shared';

import { API, startBridgeHarness, type BridgeHarness } from './testing/bridgeHarness.js';

describe('android Ф3: наряды и склад', () => {
  let h: BridgeHarness;

  afterEach(async () => {
    await h.dispose();
  });

  describe('онлайн', () => {
    beforeEach(async () => {
      h = await startBridgeHarness();
    });

    it('наряд: create → update → get/list, всё локально в SQLite', async () => {
      const created = await h.matrica().workOrders.create();
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error);
      const id = created.id;
      expect(created.payload.kind).toBe('work_order');

      const updated = await h.matrica().workOrders.update({
        id,
        payload: {
          ...created.payload,
          workGroups: [{ groupId: 'g1', partId: null, partName: 'Блок цилиндров', lines: [] }],
        },
      });
      expect(updated.ok ? null : updated.error).toBeNull();
      expect(updated.ok).toBe(true);

      const got = await h.matrica().workOrders.get(id);
      expect(got.ok).toBe(true);
      expect(got.ok && got.payload.workGroups[0]?.partName).toBe('Блок цилиндров');

      const list = await h.matrica().workOrders.list({});
      expect(list.ok).toBe(true);
      expect(list.ok && list.rows.some((r) => r.id === id)).toBe(true);

      // Строка живёт в локальной реплике (operations), а не в ответе мока.
      const row = await h.adapter.get<{ c: number }>(`SELECT COUNT(*) AS c FROM operations WHERE id = ?`, [id]);
      expect(row?.c).toBe(1);
    });

    it('доменная валидация наряда работает на фасаде: услуга без serviceId отбивается', async () => {
      const created = await h.matrica().workOrders.create();
      if (!created.ok) throw new Error(created.error);
      const res = await h.matrica().workOrders.update({
        id: created.id,
        payload: {
          ...created.payload,
          freeWorks: [
            { lineNo: 1, serviceId: null, serviceName: 'Разборка', unit: 'шт', qty: 1, priceRub: 100, amountRub: 100 },
          ],
        },
      });
      expect(res.ok).toBe(false);
      expect(res.ok ? '' : res.error).toContain('выберите услугу из базы данных');
    });

    it('складской документ: при живом сервере уходит сразу, очередь пуста', async () => {
      const res = await h.matrica().warehouse.documentCreate({
        docType: WarehouseDocumentType.StockReceipt,
        docNo: 'СМОУК-1',
        docDate: 1_700_000_000_000,
        lines: [],
      });
      expect(res.ok).toBe(true);
      expect(res.ok && res.queued).toBe(false);

      const queued = await h.adapter.get<{ c: number }>(`SELECT COUNT(*) AS c FROM warehouse_command_outbox`);
      expect(queued?.c).toBe(0);
    });
  });

  describe('офлайн (цех без Wi-Fi)', () => {
    beforeEach(async () => {
      h = await startBridgeHarness({ offlineAfterLogin: true });
    });

    it('наряд правится без сети — локальная запись не зависит от сервера', async () => {
      const created = await h.matrica().workOrders.create();
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error);

      const updated = await h.matrica().workOrders.update({
        id: created.id,
        payload: created.payload,
      });
      expect(updated.ok).toBe(true);

      const row = await h.adapter.get<{ sync_status: string }>(`SELECT sync_status FROM operations WHERE id = ?`, [
        created.id,
      ]);
      // Локальная правка помечена pending — её унесёт push при появлении сети.
      expect(row?.sync_status).toBe('pending');
    });

    it('складской документ без сети ложится в warehouse_command_outbox', async () => {
      const res = await h.matrica().warehouse.documentCreate({
        docType: WarehouseDocumentType.StockReceipt,
        docNo: 'СМОУК-2',
        docDate: 1_700_000_000_000,
        lines: [],
      });
      expect(res.ok).toBe(true);
      expect(res.ok && res.queued).toBe(true);
      expect(res.ok && res.clientOperationId).toBeTruthy();

      const row = await h.adapter.get<{ command_type: string; status: string }>(
        `SELECT command_type, status FROM warehouse_command_outbox LIMIT 1`,
      );
      expect(row?.command_type).toBe('document_upsert');
    });
  });

  describe('онлайн-действия сборки', () => {
    beforeEach(async () => {
      // Сервер отвечает отказом на сборочные операции — проверяем, что мост
      // доносит ответ сервера, а не роняет вызов.
      h = await startBridgeHarness({
        routes: (url) =>
          url.includes('/work-orders/') && url.includes('/issue-assembly')
            ? Response.json({ ok: false, error: 'нет остатка' }, { status: 409 })
            : null,
      });
    });

    it('issueAssembly отдаёт ошибку сервера как результат, а не исключение', async () => {
      const res = await h.matrica().workOrders.issueAssembly({ operationId: 'wo-1' });
      expect(res.ok).toBe(false);
      expect(res.ok ? '' : res.error).not.toContain('недоступно на планшете');
    });
  });
});
