import { and, eq, inArray, isNull } from 'drizzle-orm';

import { workshopWarehouseId } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { directoryWorkshops, erpRegStockBalance } from '../database/schema.js';
import { resolveWarehouseLocationIdByCode } from './warehouseLocationsService.js';

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

export type StockBalanceByWorkshopMap = Record<string, { onHand: number }>;

/**
 * Batch остатков для конкретного цеха по списку nomenclatureIds. Возвращает
 * мап `{ [nomenclatureId]: { onHand } }`. Если для какой-то номенклатуры
 * записи нет — она просто отсутствует в результате (front считает её как 0).
 *
 * Используется в карточке Workshop-наряда для live-колонки «Остаток в цеху».
 * Один запрос, чтобы избежать N+1 при больших шаблонах.
 */
export async function getStockBalanceForWorkshop(args: {
  workshopId: string;
  nomenclatureIds: string[];
}): Promise<Result<{ workshopId: string; warehouseId: string; balances: StockBalanceByWorkshopMap }>> {
  try {
    const workshopId = String(args.workshopId || '').trim();
    if (!workshopId) return { ok: false, error: 'workshopId обязателен' };

    const workshopRows = await db
      .select({ code: directoryWorkshops.code, isActive: directoryWorkshops.isActive })
      .from(directoryWorkshops)
      .where(and(eq(directoryWorkshops.id, workshopId), isNull(directoryWorkshops.deletedAt)))
      .limit(1);
    const workshop = workshopRows[0];
    if (!workshop) return { ok: false, error: 'Цех не найден' };
    const code = String(workshop.code ?? '').trim();
    if (!code) return { ok: false, error: 'У цеха пустой код — невозможно построить warehouseId' };
    const warehouseId = workshopWarehouseId(code);
    // Phase 2.4 PR 2: переключаем WHERE на warehouse_location_id (uuid FK). После DROP COLUMN
    // в PR 3 поле warehouse_id уйдёт из схемы. workshopWarehouseId(code) даёт legacy-код,
    // резолвим через warehouse_locations.code → uuid (in-memory cache).
    const warehouseLocationId = await resolveWarehouseLocationIdByCode(warehouseId);
    if (!warehouseLocationId) return { ok: false, error: `Склад цеха «${warehouseId}» не найден в warehouse_locations` };

    const balances: StockBalanceByWorkshopMap = {};
    const ids = Array.from(new Set(args.nomenclatureIds.map((id) => String(id || '').trim()).filter(Boolean)));
    if (ids.length === 0) {
      return { ok: true, workshopId, warehouseId, balances };
    }

    const rows = await db
      .select({ nomenclatureId: erpRegStockBalance.nomenclatureId, qty: erpRegStockBalance.qty })
      .from(erpRegStockBalance)
      .where(
        and(
          eq(erpRegStockBalance.warehouseLocationId, warehouseLocationId),
          inArray(erpRegStockBalance.nomenclatureId, ids),
        ),
      );
    for (const row of rows) {
      const nomenclatureId = row.nomenclatureId ? String(row.nomenclatureId) : '';
      if (!nomenclatureId) continue;
      balances[nomenclatureId] = { onHand: Number(row.qty) || 0 };
    }
    return { ok: true, workshopId, warehouseId, balances };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
