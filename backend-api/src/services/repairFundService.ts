/**
 * Ремфонд Ф1 (план docs/plans/repair-fund-2026-06.md): приход годных к ремонту
 * деталей двигателя в ремонтный фонд из дефектовки, по кнопке на карточке.
 *
 * Идемпотентность по двигателю (защита от призраков — именно авто-наполнение
 * ремфонда замораживали из-за двойных приходов): храним «high-water-mark» уже
 * занесённого этим двигателем в фонд (операция `repair_fund_intake`), и проводим
 * только ПОЛОЖИТЕЛЬНЫЙ прирост сверх него. Повтор без изменений → ноль приходов;
 * снижение (деталь стала утилем) НЕ списывается автоматически — корректируется
 * «Ревизией ремфонда» (Ф0). Так фонд никогда не переприходуется.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import { WAREHOUSE_LOCATION_REPAIR_FUND } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { erpRegStockBalance, operations, warehouseLocations } from '../database/schema.js';
import { createWarehouseDocument, postWarehouseDocument } from './warehouseService.js';
import { resolvePartIdToNomenclatureMap } from './workOrderClosingService.js';

const REPAIR_FUND_INTAKE_TYPE = 'repair_fund_intake';

type Actor = { id: string; username: string };

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

type IntakeItem = { partId: string; partLabel: string; qty: number };

type IntakeRecordItem = { nomenclatureId: string; partLabel: string; qty: number };

function nowMs(): number {
  return Date.now();
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Читает high-water-mark уже занесённого этим двигателем в фонд (nomenclatureId → qty). */
async function loadEngineIntake(engineId: string): Promise<{ opId: string | null; items: Map<string, IntakeRecordItem> }> {
  const rows = await db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.operationType, REPAIR_FUND_INTAKE_TYPE),
        eq(operations.engineEntityId, engineId),
        isNull(operations.deletedAt),
      ),
    )
    .orderBy(desc(operations.updatedAt))
    .limit(1);
  const op = rows[0];
  const items = new Map<string, IntakeRecordItem>();
  if (!op) return { opId: null, items };
  const parsed = safeJsonParse(String(op.metaJson ?? ''));
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)) {
    for (const raw of (parsed as { items: unknown[] }).items) {
      if (!raw || typeof raw !== 'object') continue;
      const rec = raw as Record<string, unknown>;
      const nomenclatureId = String(rec.nomenclatureId ?? '').trim();
      const qty = Math.max(0, Math.trunc(Number(rec.qty) || 0));
      if (!nomenclatureId || qty <= 0) continue;
      items.set(nomenclatureId, { nomenclatureId, partLabel: String(rec.partLabel ?? ''), qty });
    }
  }
  return { opId: String(op.id), items };
}

/**
 * Ф3 плана forecast-remfond-aware-2026-07: read-only превью дельты заноса — те же шаги
 * резолва и сравнения с high-water-mark, что у intakeRepairFundFromEngine, но без проводки.
 * UI показывает бейдж «дефектовка не занесена в ремфонд», если pendingQty > 0.
 */
export async function previewRepairFundIntakeFromEngine(args: {
  engineId: string;
  items: IntakeItem[];
}): Promise<Result<{ pendingQty: number; pendingPositions: number; skippedNoNom: number }>> {
  try {
    const engineId = String(args.engineId ?? '').trim();
    if (!engineId) return { ok: false, error: 'Не задан двигатель' };
    const partIds = [...new Set(args.items.map((i) => String(i.partId ?? '').trim()).filter(Boolean))];
    const nomMap = partIds.length ? await resolvePartIdToNomenclatureMap(partIds) : new Map<string, string>();
    const target = new Map<string, number>();
    let skippedNoNom = 0;
    for (const item of args.items) {
      const partId = String(item.partId ?? '').trim();
      const qty = Math.max(0, Math.trunc(Number(item.qty) || 0));
      if (!partId || qty <= 0) continue;
      const nomenclatureId = nomMap.get(partId);
      if (!nomenclatureId) {
        skippedNoNom += 1;
        continue;
      }
      target.set(nomenclatureId, (target.get(nomenclatureId) ?? 0) + qty);
    }
    const prior = await loadEngineIntake(engineId);
    let pendingQty = 0;
    let pendingPositions = 0;
    for (const [nomenclatureId, qty] of target) {
      const add = qty - (prior.items.get(nomenclatureId)?.qty ?? 0);
      if (add > 0) {
        pendingQty += add;
        pendingPositions += 1;
      }
    }
    return { ok: true, pendingQty, pendingPositions, skippedNoNom };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Заносит годные к ремонту детали двигателя в ремонтный фонд (только прирост).
 * `items` — уже посчитанный на клиенте список (partId, partLabel, repairable qty),
 * см. `buildRepairFundIntakeFromInventory`.
 */
export async function intakeRepairFundFromEngine(args: {
  engineId: string;
  items: IntakeItem[];
  actor: Actor;
}): Promise<
  Result<{
    posted: number;
    addedQty: number;
    nomenclatureCount: number;
    unchanged: boolean;
    documentId: string | null;
    skippedNoNom?: number;
  }>
> {
  try {
    const engineId = String(args.engineId ?? '').trim();
    if (!engineId) return { ok: false, error: 'Не задан двигатель' };

    // 1) Резолвим partId → nomenclatureId (как при закрытии ремонтного наряда).
    const partIds = [...new Set(args.items.map((i) => String(i.partId ?? '').trim()).filter(Boolean))];
    const nomMap = partIds.length ? await resolvePartIdToNomenclatureMap(partIds) : new Map<string, string>();

    // 2) Целевой набор {nomenclatureId → {qty, label}} (агрегируем по номенклатуре).
    const target = new Map<string, { qty: number; label: string }>();
    let skippedNoNom = 0;
    for (const item of args.items) {
      const partId = String(item.partId ?? '').trim();
      const qty = Math.max(0, Math.trunc(Number(item.qty) || 0));
      if (!partId || qty <= 0) continue;
      const nomenclatureId = nomMap.get(partId);
      if (!nomenclatureId) {
        skippedNoNom += 1;
        continue;
      }
      const cur = target.get(nomenclatureId);
      if (cur) cur.qty += qty;
      else target.set(nomenclatureId, { qty, label: String(item.partLabel ?? '') });
    }

    // 3) High-water-mark прошлого заноса и положительная дельта.
    const prior = await loadEngineIntake(engineId);
    const deltaLines: Array<{ nomenclatureId: string; qty: number; label: string }> = [];
    const nextItems = new Map<string, IntakeRecordItem>(prior.items);
    for (const [nomenclatureId, t] of target) {
      const already = prior.items.get(nomenclatureId)?.qty ?? 0;
      const add = t.qty - already;
      if (add > 0) {
        deltaLines.push({ nomenclatureId, qty: add, label: t.label });
        nextItems.set(nomenclatureId, { nomenclatureId, partLabel: t.label, qty: t.qty });
      }
    }

    if (deltaLines.length === 0) {
      return { ok: true, posted: 0, addedQty: 0, nomenclatureCount: target.size, unchanged: true, documentId: null };
    }

    // 4) Проводим прирост приходом inventory_opening в локацию repair_fund.
    const ts = nowMs();
    const docNo = `RFI-${engineId.slice(0, 8)}-${String(ts).slice(-8)}`;
    const created = await createWarehouseDocument({
      docType: 'inventory_opening',
      status: 'planned',
      docNo,
      docDate: ts,
      payloadJson: JSON.stringify({
        warehouseId: WAREHOUSE_LOCATION_REPAIR_FUND,
        expectedDate: ts,
        sourceType: 'inventory_opening',
        reason: 'Занос дефектовки в ремонтный фонд',
        engineId,
      }),
      lines: deltaLines.map((l) => ({ qty: l.qty, nomenclatureId: l.nomenclatureId })),
      actor: args.actor,
    });
    if (!created.ok) return { ok: false, error: `Не удалось создать документ прихода: ${created.error}` };
    const posted = await postWarehouseDocument({ documentId: created.id, actor: args.actor });
    if (!posted.ok) return { ok: false, error: `Не удалось провести приход: ${posted.error}` };

    // 5) Перезаписываем запись заноса двигателя (soft-delete прежней + новая).
    const intakePayload = {
      kind: REPAIR_FUND_INTAKE_TYPE,
      engineEntityId: engineId,
      documentId: created.id,
      items: [...nextItems.values()],
    };
    if (prior.opId) {
      await db.update(operations).set({ deletedAt: ts, updatedAt: ts }).where(eq(operations.id, prior.opId));
    }
    await db.insert(operations).values({
      id: randomUUID(),
      engineEntityId: engineId,
      operationType: REPAIR_FUND_INTAKE_TYPE,
      status: 'event',
      note: `Ремфонд: занос дефектовки (${deltaLines.length} поз.)`,
      performedAt: ts,
      performedBy: args.actor.username || 'system',
      metaJson: JSON.stringify(intakePayload),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });

    const addedQty = deltaLines.reduce((s, l) => s + l.qty, 0);
    return {
      ok: true,
      posted: deltaLines.length,
      addedQty,
      nomenclatureCount: target.size,
      unchanged: false,
      documentId: created.id,
      ...(skippedNoNom > 0 ? { skippedNoNom } : {}),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Ремфонд Ф2: списание отремонтированных деталей из ремонтного фонда при закрытии
 * ремонтного наряда (деталь признана годной к сборке → покидает фонд). qty — из
 * строк наряда (сколько отремонтировано). Списываем `min(qty, остаток фонда)` —
 * проводка склада блокирует уход в минус, поэтому clamp обязателен; деталей, которых
 * в фонде нет (не заносили дефектовкой), списание просто не трогает. Best-effort:
 * вызывается в try/catch на закрытии наряда — сбой расхода не валит закрытие.
 */
export async function releaseRepairFundForWorkOrder(args: {
  workLines: Array<{ partId?: string | null; qty?: number | null }>;
  actor: Actor;
}): Promise<Result<{ released: number; releasedQty: number }>> {
  try {
    const byPart = new Map<string, number>();
    for (const wl of args.workLines) {
      const partId = String(wl?.partId ?? '').trim();
      const qty = Math.max(0, Math.trunc(Number(wl?.qty) || 0));
      if (!partId || qty <= 0) continue;
      byPart.set(partId, (byPart.get(partId) ?? 0) + qty);
    }
    if (byPart.size === 0) return { ok: true, released: 0, releasedQty: 0 };

    const nomMap = await resolvePartIdToNomenclatureMap([...byPart.keys()]);
    const wantByNom = new Map<string, number>();
    for (const [partId, qty] of byPart) {
      const nomId = nomMap.get(partId);
      if (!nomId) continue;
      wantByNom.set(nomId, (wantByNom.get(nomId) ?? 0) + qty);
    }
    if (wantByNom.size === 0) return { ok: true, released: 0, releasedQty: 0 };

    const locRows = await db
      .select({ id: warehouseLocations.id })
      .from(warehouseLocations)
      .where(eq(warehouseLocations.code, WAREHOUSE_LOCATION_REPAIR_FUND))
      .limit(1);
    const locId = locRows[0]?.id ? String(locRows[0].id) : null;
    if (!locId) return { ok: true, released: 0, releasedQty: 0 };

    const nomIds = [...wantByNom.keys()];
    const balRows = await db
      .select({ nomenclatureId: erpRegStockBalance.nomenclatureId, qty: erpRegStockBalance.qty })
      .from(erpRegStockBalance)
      .where(and(eq(erpRegStockBalance.warehouseLocationId, locId), inArray(erpRegStockBalance.nomenclatureId, nomIds)));
    const balByNom = new Map<string, number>();
    for (const r of balRows) balByNom.set(String(r.nomenclatureId), Math.max(0, Number(r.qty) || 0));

    const lines: Array<{ nomenclatureId: string; qty: number }> = [];
    for (const [nomId, want] of wantByNom) {
      const release = Math.min(want, balByNom.get(nomId) ?? 0);
      if (release > 0) lines.push({ nomenclatureId: nomId, qty: release });
    }
    if (lines.length === 0) return { ok: true, released: 0, releasedQty: 0 };

    const ts = nowMs();
    const docNo = `RFR-${String(ts).slice(-10)}`;
    const created = await createWarehouseDocument({
      docType: 'stock_writeoff',
      status: 'draft',
      docNo,
      docDate: ts,
      payloadJson: JSON.stringify({
        warehouseId: WAREHOUSE_LOCATION_REPAIR_FUND,
        reason: 'Списание из ремфонда: деталь отремонтирована',
      }),
      lines: lines.map((l) => ({ qty: l.qty, nomenclatureId: l.nomenclatureId, warehouseId: WAREHOUSE_LOCATION_REPAIR_FUND })),
      actor: args.actor,
    });
    if (!created.ok) return { ok: false, error: created.error };
    const posted = await postWarehouseDocument({ documentId: created.id, actor: args.actor });
    if (!posted.ok) return { ok: false, error: posted.error };

    return { ok: true, released: lines.length, releasedQty: lines.reduce((s, l) => s + l.qty, 0) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
