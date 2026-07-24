import { randomUUID } from 'node:crypto';

import { and, eq, isNull, inArray } from 'drizzle-orm';

import {
  AssemblyReturnMode,
  buildPartStatusEventNote,
  PART_STATUS_EVENT_TYPE,
  SyncTableName,
  WAREHOUSE_LOCATION_REPAIR_FUND,
  WORK_ORDER_PAYLOAD_VERSION,
  WorkOrderKind,
  isWorkshopWarehouseId,
  normalizeWorkOrderPayloadV3Fields,
  pruneEmptyWorkshopLines,
  workshopWarehouseId,
  type PartStatusEventPayload,
  type WorkOrderConsumedLine,
  type WorkOrderPayload,
  type WorkOrderProducedLine,
  type WorkOrderWorkLine,
} from '@matricarmz/shared';

import { db } from '../database/db.js';
import { directoryWorkshops, erpDocumentHeaders, erpNomenclature, operations } from '../database/schema.js';
import { EnginePhase, setEnginePhase } from './enginePhaseService.js';
import {
  cancelWarehouseDocument,
  createWarehouseDocument,
  planWarehouseDocument,
  postWarehouseDocument,
  releaseAssemblyDraftReservation,
  reserveAssemblyDraftReservation,
} from './warehouseService.js';
import { recordSyncChanges } from './sync/syncChangeService.js';

type Actor = { id: string; username: string; role?: string };
type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

const WORK_ORDERS_OPERATION_TYPE = 'work_order';

function nowMs() {
  return Date.now();
}

function safeJsonParse(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function resolveWorkshopWarehouseId(workshopId: string): Promise<string | null> {
  const rows = await db
    .select({ code: directoryWorkshops.code, isActive: directoryWorkshops.isActive })
    .from(directoryWorkshops)
    .where(and(eq(directoryWorkshops.id, workshopId), isNull(directoryWorkshops.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (!row.isActive) return null;
  const code = String(row.code ?? '').trim();
  if (!code) return null;
  return workshopWarehouseId(code);
}

function buildDocNo(prefix: string, workOrderNumber: number, operationId: string): string {
  const suffix = operationId.replaceAll('-', '').slice(0, 8);
  return `${prefix}-WO${workOrderNumber}-${suffix}`;
}

/** Собирает массив строк работ из любого поля v2/v3-payload. */
function collectWorkLines(rawPayload: Record<string, unknown>): WorkOrderWorkLine[] {
  const result: WorkOrderWorkLine[] = [];
  const free = rawPayload.freeWorks;
  if (Array.isArray(free)) {
    for (const line of free) if (line && typeof line === 'object') result.push(line as WorkOrderWorkLine);
  }
  const groups = rawPayload.workGroups;
  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      const lines = (group as { lines?: unknown }).lines;
      if (!Array.isArray(lines)) continue;
      for (const line of lines) if (line && typeof line === 'object') result.push(line as WorkOrderWorkLine);
    }
  }
  if (result.length === 0 && Array.isArray(rawPayload.works)) {
    for (const line of rawPayload.works) if (line && typeof line === 'object') result.push(line as WorkOrderWorkLine);
  }
  return result;
}

/**
 * Сворачивает строки работ в produced-lines (по partId + targetWarehouseId).
 * Использует склад цеха по умолчанию, если в строке не указано иначе.
 */
export function buildProducedLinesFromWorkLines(workLines: WorkOrderWorkLine[], targetWarehouseId: string): WorkOrderProducedLine[] {
  const acc = new Map<string, WorkOrderProducedLine>();
  let lineNo = 0;
  for (const line of workLines) {
    const partId = line.partId ? String(line.partId).trim() : '';
    const qty = Math.max(0, Math.trunc(Number(line.qty ?? 0)));
    if (!partId || qty <= 0) continue;
    const key = `${partId}@${targetWarehouseId}`;
    const existing = acc.get(key);
    if (existing) {
      existing.qty += qty;
    } else {
      lineNo += 1;
      acc.set(key, { lineNo, nomenclatureId: partId, qty, targetWarehouseId });
    }
  }
  return Array.from(acc.values());
}

/**
 * Сворачивает строки работ в consumed-lines (по partId + sourceWarehouseId).
 * Использует склад цеха как источник, если в строке не указано иначе.
 */
export function buildConsumedLinesFromWorkLines(workLines: WorkOrderWorkLine[], defaultSourceWarehouseId: string): WorkOrderConsumedLine[] {
  const acc = new Map<string, WorkOrderConsumedLine>();
  let lineNo = 0;
  for (const line of workLines) {
    const partId = line.partId ? String(line.partId).trim() : '';
    const qty = Math.max(0, Math.trunc(Number(line.qty ?? 0)));
    if (!partId || qty <= 0) continue;
    const lineSourceWarehouseId = line.sourceWarehouseId
      ? String(line.sourceWarehouseId).trim() || defaultSourceWarehouseId
      : defaultSourceWarehouseId;
    const key = `${partId}@${lineSourceWarehouseId}`;
    const existing = acc.get(key);
    if (existing) {
      existing.qty += qty;
    } else {
      lineNo += 1;
      acc.set(key, { lineNo, nomenclatureId: partId, qty, sourceWarehouseId: lineSourceWarehouseId });
    }
  }
  return Array.from(acc.values());
}

/**
 * G1 (parts-chain-audit): a work-line `partId` may be a `directory_parts.id` that differs
 * from its `erp_nomenclature.id` (the bom-parts backfill bridges via `directory_ref_id`,
 * not id-equality). Warehouse document lines key on `nomenclature_id`, so each line's id
 * must resolve to a real nomenclature: id-match → directory_ref bridge → passthrough.
 * Pure mapper (DB-free) so the resolution rule is unit-testable.
 */
export function buildPartIdToNomenclatureMap(
  ids: string[],
  validNomenclatureIds: Set<string>,
  refToNomenclature: Map<string, string>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const id of ids) {
    if (!id) continue;
    if (validNomenclatureIds.has(id)) map.set(id, id);
    else if (refToNomenclature.has(id)) map.set(id, refToNomenclature.get(id)!);
    else map.set(id, id);
  }
  return map;
}

export async function resolvePartIdToNomenclatureMap(rawIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(rawIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const validRows = await db
    .select({ id: erpNomenclature.id })
    .from(erpNomenclature)
    .where(and(inArray(erpNomenclature.id, ids), isNull(erpNomenclature.deletedAt)));
  const validSet = new Set(validRows.map((r) => String(r.id)));
  const refRows = await db
    .select({ id: erpNomenclature.id, refId: erpNomenclature.directoryRefId })
    .from(erpNomenclature)
    .where(and(inArray(erpNomenclature.directoryRefId, ids), isNull(erpNomenclature.deletedAt)));
  const refMap = new Map<string, string>();
  for (const r of refRows) {
    const ref = r.refId ? String(r.refId) : '';
    if (ref && !refMap.has(ref)) refMap.set(ref, String(r.id));
  }
  return buildPartIdToNomenclatureMap(ids, validSet, refMap);
}

/**
 * Серверные изменения operations (закрытие наряда, linkedDocumentId) обязаны уходить
 * в единый sync-путь (`recordSyncChanges`: ledger-подпись → last_server_seq → PG),
 * иначе incremental pull клиентов их не увидит (фильтр по last_server_seq) — закрывшая
 * карточка маскирует это оптимистичным апдейтом, остальные клиенты видят наряд открытым
 * до полного fullPull. Best-effort: сбой эмита не валит закрытие (warn), состояние
 * не хуже прежнего поведения.
 */
export async function emitOperationSyncChange(operationId: string, actor: Actor): Promise<void> {
  try {
    const rows = await db.select().from(operations).where(eq(operations.id, operationId)).limit(1);
    const op = rows[0];
    if (!op) return;
    await recordSyncChanges({ id: actor.id, username: actor.username, role: actor.role ?? 'user' }, [
      {
        tableName: SyncTableName.Operations,
        rowId: operationId,
        op: op.deletedAt != null ? 'delete' : 'upsert',
        payload: {
          id: String(op.id),
          engine_entity_id: String(op.engineEntityId),
          operation_type: String(op.operationType),
          status: String(op.status),
          note: op.note ?? null,
          performed_at: op.performedAt ?? null,
          performed_by: op.performedBy ?? null,
          meta_json: op.metaJson ?? null,
          created_at: Number(op.createdAt),
          updated_at: Number(op.updatedAt),
          deleted_at: op.deletedAt == null ? null : Number(op.deletedAt),
          sync_status: 'synced',
        },
        ts: nowMs(),
      },
    ]);
  } catch (e) {
    console.warn('[workOrderClosingService] operation sync redistribution skipped:', e);
  }
}

/**
 * Ф5 актов двигателя (GAP-4 исход): закрытие Repair-наряда → события «годна к сборке»
 * per (engineId, partId) из work-lines с привязкой к двигателю. Best-effort: ошибка
 * записи событий не валит закрытие наряда. События — обычные operations, синкаются
 * дженериком на клиентов (история статусов в карточке двигателя).
 */
async function writeRepairReadyPartStatusEvents(args: {
  workOrderOperationId: string;
  workOrderNumber: number;
  workLines: WorkOrderWorkLine[];
  actor: Actor;
}): Promise<void> {
  type Agg = { engineId: string; partId: string; partLabel: string; qty: number };
  const acc = new Map<string, Agg>();
  for (const line of args.workLines) {
    const engineId = String(line?.engineId ?? '').trim();
    const partId = String(line?.partId ?? '').trim();
    const qty = Math.max(0, Math.trunc(Number(line?.qty ?? 0)));
    if (!engineId || !partId || qty <= 0) continue;
    const key = `${engineId}@${partId}`;
    const existing = acc.get(key);
    if (existing) {
      existing.qty += qty;
    } else {
      acc.set(key, { engineId, partId, partLabel: String(line?.partName ?? '').trim(), qty });
    }
  }
  if (acc.size === 0) return;
  const ts = nowMs();
  for (const agg of acc.values()) {
    const payload: PartStatusEventPayload = {
      kind: 'part_status_event',
      engineEntityId: agg.engineId,
      partId: agg.partId,
      partLabel: agg.partLabel,
      qty: agg.qty,
      status: 'ready_for_assembly',
      workOrderOperationId: args.workOrderOperationId,
      workOrderNumber: args.workOrderNumber,
    };
    const id = randomUUID();
    const row = {
      id,
      engineEntityId: agg.engineId,
      operationType: PART_STATUS_EVENT_TYPE,
      status: 'event',
      note: buildPartStatusEventNote(payload),
      performedAt: ts,
      performedBy: args.actor.username,
      metaJson: JSON.stringify(payload),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    };
    await db.insert(operations).values(row);
    // Server-side write → unified sync path (ledger sign + last_server_seq stamp),
    // иначе строка никогда не уедет клиентам (pull фильтрует по last_server_seq).
    await recordSyncChanges({ id: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' }, [
      {
        tableName: SyncTableName.Operations,
        rowId: id,
        op: 'upsert',
        payload: {
          id,
          engine_entity_id: row.engineEntityId,
          operation_type: row.operationType,
          status: row.status,
          note: row.note,
          performed_at: row.performedAt,
          performed_by: row.performedBy,
          meta_json: row.metaJson,
          created_at: row.createdAt,
          updated_at: row.updatedAt,
          deleted_at: null,
          sync_status: 'synced',
        },
        ts,
      },
    ]);
  }
}

/**
 * Close a work-order operation and post the matching warehouse document.
 *
 * Repair work orders → repair_recovery document (planned → posted),
 * Assembly work orders → assembly_consumption document (draft → posted).
 *
 * Idempotent: if the operation already has `linkedDocumentId` set and is `closed`,
 * returns success with that document id without re-creating.
 */
export async function closeWorkOrderAndPostDocument(args: {
  operationId: string;
  actor: Actor;
  expectedUpdatedAt?: number;
}): Promise<Result<{ operationId: string; documentId: string | null; posted: boolean; updatedAt: number }>> {
  try {
    const ts = nowMs();
    const opRows = await db
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.id, args.operationId),
          eq(operations.operationType, WORK_ORDERS_OPERATION_TYPE),
          isNull(operations.deletedAt),
        ),
      )
      .limit(1);
    const op = opRows[0];
    if (!op) return { ok: false, error: 'Наряд не найден' };

    if (args.expectedUpdatedAt != null && Number(op.updatedAt) !== Math.trunc(Number(args.expectedUpdatedAt))) {
      return { ok: false, error: 'Конфликт обновления: наряд изменён другим пользователем. Обновите карточку.' };
    }

    const rawPayload = safeJsonParse(op.metaJson);
    if (!rawPayload || rawPayload.kind !== 'work_order') {
      return { ok: false, error: 'Некорректный payload наряда' };
    }
    const v3 = normalizeWorkOrderPayloadV3Fields(rawPayload);

    // Idempotency: already closed with a linked document.
    if (String(op.status) === 'closed' && v3.linkedDocumentId) {
      return {
        ok: true,
        operationId: args.operationId,
        documentId: v3.linkedDocumentId,
        posted: true,
        updatedAt: Number(op.updatedAt) || nowMs(),
      };
    }

    const workOrderNumber = Number((rawPayload as { workOrderNumber?: number }).workOrderNumber ?? 0);
    const engineEntityId = String(op.engineEntityId ?? '');
    const engineIdForMovements = engineEntityId || null;

    // --- Regular: закрытие без складского документа ------------------------------
    // Промежуточные работы — только для расчёта зарплат, ничего не списываем и не пополняем.
    if (v3.workOrderKind === WorkOrderKind.Regular) {
      const closedTs = nowMs();
      await db
        .update(operations)
        .set({
          status: 'closed',
          updatedAt: closedTs,
          syncStatus: 'pending',
        })
        .where(eq(operations.id, args.operationId));
      await emitOperationSyncChange(args.operationId, args.actor);
      return { ok: true, operationId: args.operationId, documentId: null, posted: false, updatedAt: closedTs };
    }

    if (!v3.workOrderKind) {
      return {
        ok: false,
        error: 'У наряда не задан тип (workOrderKind: regular | repair | workshop_template | assembly | manufacturing)',
      };
    }
    if (!v3.workshopId) {
      return { ok: false, error: 'У наряда не задан цех (workshopId)' };
    }

    const workshopWh = await resolveWorkshopWarehouseId(v3.workshopId);
    if (!workshopWh) {
      return { ok: false, error: 'Указанный цех не найден или не активен' };
    }

    // Workshop-template: до сборки строк прогоняем pruneEmptyWorkshopLines —
    // оператор оставляет qty=0 для невыпущенных строк шаблона, на проводке они
    // удаляются и из dock-документа, и из payload закрытого наряда (см. metaJson update).
    const prunedRawPayload =
      v3.workOrderKind === WorkOrderKind.WorkshopTemplate
        ? (pruneEmptyWorkshopLines(rawPayload as unknown as WorkOrderPayload) as unknown as Record<string, unknown>)
        : rawPayload;

    const workLines = collectWorkLines(prunedRawPayload);

    let docType: string;
    let docNoPrefix: string;
    let initialStatus: 'draft' | 'planned';
    let needsPlanStep: boolean;
    let lineInputs: Array<{ qty: number; nomenclatureId: string; payloadJson: string }>;

    if (
      v3.workOrderKind === WorkOrderKind.Repair ||
      v3.workOrderKind === WorkOrderKind.WorkshopTemplate ||
      v3.workOrderKind === WorkOrderKind.Manufacturing
    ) {
      // Repair / WorkshopTemplate / Manufacturing — единая складская семантика:
      // production_release (просто приход на склад цеха, без обращения к repair_fund).
      // Разборка двигателя (engine_dismantling) заморожена 2026-05-26 — см.
      // docs/plans/workshop-template-fixes.md. До этого Repair брал детали из
      // repair_fund, но бизнес теперь приходует ремонты как новые детали.
      const produced =
        v3.producedLines && v3.producedLines.length > 0
          ? (v3.producedLines as WorkOrderProducedLine[])
          : buildProducedLinesFromWorkLines(workLines, workshopWh);
      if (produced.length === 0) {
        const message =
          v3.workOrderKind === WorkOrderKind.WorkshopTemplate
            ? 'Заполните количество хотя бы в одной строке наряда (все строки шаблона пустые — нечего выпускать)'
            : v3.workOrderKind === WorkOrderKind.Manufacturing
              ? 'Для наряда-изготовления нужно указать «Наименование изделия» и количество хотя бы в одной строке работ'
              : 'Для ремонтного наряда нужно указать «Наименование изделия» и количество хотя бы в одной строке работ';
        return { ok: false, error: message };
      }
      docType = 'production_release';
      docNoPrefix =
        v3.workOrderKind === WorkOrderKind.WorkshopTemplate
          ? 'WSR'
          : v3.workOrderKind === WorkOrderKind.Manufacturing
            ? 'MFG'
            : 'REP';
      initialStatus = 'planned';
      needsPlanStep = false;
      lineInputs = produced.map((line) => {
        const targetWarehouseId = isWorkshopWarehouseId(line.targetWarehouseId) ? line.targetWarehouseId : workshopWh;
        return {
          qty: Math.max(0, Math.trunc(line.qty)),
          nomenclatureId: line.nomenclatureId,
          payloadJson: JSON.stringify({
            nomenclatureId: line.nomenclatureId,
            targetWarehouseId,
            warehouseId: targetWarehouseId,
          }),
        };
      });
    } else if (v3.workOrderKind === WorkOrderKind.Assembly) {
      const consumed =
        v3.consumedLines && v3.consumedLines.length > 0
          ? (v3.consumedLines as WorkOrderConsumedLine[])
          : buildConsumedLinesFromWorkLines(workLines, workshopWh);
      if (consumed.length === 0) {
        return {
          ok: false,
          error: 'Для сборочного наряда нужно указать «Наименование изделия» и количество хотя бы в одной строке работ',
        };
      }
      if (!engineIdForMovements) {
        return { ok: false, error: 'У сборочного наряда не привязан двигатель (operations.engineEntityId)' };
      }
      docType = 'assembly_consumption';
      docNoPrefix = 'ASM';
      initialStatus = 'draft';
      needsPlanStep = false;
      // Phase 2.4 PR 1: см. buildAssemblyDocLines — принимаем любой непустой sourceWarehouseId
      // (uuid из UI или legacy code), фолбэк на workshopWh цеха при пустом значении.
      lineInputs = consumed.map((line) => {
        const trimmed = String(line.sourceWarehouseId ?? '').trim();
        const sourceWarehouseId = trimmed.length > 0 ? trimmed : workshopWh;
        return {
          qty: Math.max(0, Math.trunc(line.qty)),
          nomenclatureId: line.nomenclatureId,
          payloadJson: JSON.stringify({
            nomenclatureId: line.nomenclatureId,
            sourceWarehouseId,
            engineId: engineIdForMovements,
          }),
        };
      });
    } else {
      return { ok: false, error: `Неподдерживаемый workOrderKind: ${v3.workOrderKind}` };
    }

    // G1: resolve each line's id to a real nomenclature before posting (covers both the
    // built-from-workLines path and precomputed produced/consumed lines). No-op when the
    // id is already a valid nomenclature; remaps the bom-parts directory_ref convention.
    const partNomenclMap = await resolvePartIdToNomenclatureMap(lineInputs.map((l) => l.nomenclatureId));
    for (const li of lineInputs) {
      const resolved = partNomenclMap.get(li.nomenclatureId);
      if (resolved && resolved !== li.nomenclatureId) {
        const payload = (safeJsonParse(li.payloadJson) ?? {}) as Record<string, unknown>;
        payload.nomenclatureId = resolved;
        li.payloadJson = JSON.stringify(payload);
        li.nomenclatureId = resolved;
      }
    }

    const cleanLines = lineInputs.filter((line) => line.qty > 0 && line.nomenclatureId);
    if (cleanLines.length === 0) {
      return { ok: false, error: 'Все строки наряда нулевой или пустые — нечего проводить' };
    }

    const docNo = buildDocNo(docNoPrefix, workOrderNumber, args.operationId);
    const headerPayloadObj: Record<string, unknown> = {
      module: 'parts_movement_v1',
      workshopId: v3.workshopId,
      workshopWarehouseId: workshopWh,
      workOrderOperationId: args.operationId,
      workOrderNumber,
    };
    if (engineIdForMovements) headerPayloadObj.engineId = engineIdForMovements;
    // Для production_release generic-incoming-ветка warehouseService использует header.warehouseId
    // и header.expectedDate для buildPlannedIncomingRows. Repair/Workshop/Manufacturing —
    // все три идут через production_release (см. switch выше).
    if (
      v3.workOrderKind === WorkOrderKind.Manufacturing ||
      v3.workOrderKind === WorkOrderKind.Repair ||
      v3.workOrderKind === WorkOrderKind.WorkshopTemplate
    ) {
      headerPayloadObj.warehouseId = workshopWh;
      headerPayloadObj.expectedDate = ts;
      headerPayloadObj.sourceType = 'production_release';
    }
    const headerPayloadJson = JSON.stringify(headerPayloadObj);

    const created = await createWarehouseDocument({
      docType,
      status: initialStatus,
      docNo,
      docDate: ts,
      payloadJson: headerPayloadJson,
      lines: cleanLines.map((line) => ({
        qty: line.qty,
        nomenclatureId: line.nomenclatureId,
        payloadJson: line.payloadJson,
      })),
      actor: args.actor,
    });
    if (!created.ok) return { ok: false, error: `Не удалось создать документ: ${created.error}` };
    const documentId = created.id;

    if (needsPlanStep) {
      const planned = await planWarehouseDocument({ documentId, actor: args.actor });
      if (!planned.ok) return { ok: false, error: `Не удалось запланировать документ: ${planned.error}` };
    }

    const posted = await postWarehouseDocument({ documentId, actor: args.actor });
    if (!posted.ok) return { ok: false, error: `Не удалось провести документ: ${posted.error}` };

    const updatedPayload: Record<string, unknown> = {
      ...prunedRawPayload,
      version: WORK_ORDER_PAYLOAD_VERSION,
      linkedDocumentId: documentId,
    };
    const closedTs = nowMs();
    await db
      .update(operations)
      .set({
        status: 'closed',
        metaJson: JSON.stringify(updatedPayload),
        updatedAt: closedTs,
        syncStatus: 'pending',
      })
      .where(eq(operations.id, args.operationId));
    await emitOperationSyncChange(args.operationId, args.actor);

    // Stage 2: bump engine_phase. Assembly close → assembled (assumes the work order completes assembly).
    // The "full BOM check" is left for the UI/operator — a phase transition here is best-effort.
    if (engineIdForMovements && v3.workOrderKind === WorkOrderKind.Assembly) {
      const phaseResult = await setEnginePhase({
        engineId: engineIdForMovements,
        phase: EnginePhase.Assembled,
        actor: { id: args.actor.id, username: args.actor.username },
        reasonDocumentId: documentId,
      });
      if (!phaseResult.ok) {
        console.warn('[workOrderClosingService] engine_phase=assembled skipped:', phaseResult.error);
      }
    }

    // Ф5 (GAP-4 исход): Repair-наряд закрыт → детали с привязкой к двигателю «годны к сборке».
    if (v3.workOrderKind === WorkOrderKind.Repair) {
      try {
        await writeRepairReadyPartStatusEvents({
          workOrderOperationId: args.operationId,
          workOrderNumber,
          workLines,
          actor: args.actor,
        });
      } catch (e) {
        console.warn('[workOrderClosingService] part_status_event skipped:', e);
      }
      // Ф2 ремфонда: отремонтированные детали покидают ремонтный фонд (best-effort,
      // clamp по остатку; динамический import — repairFundService импортит отсюда
      // resolvePartIdToNomenclatureMap, избегаем циклической инициализации).
      try {
        const { releaseRepairFundForWorkOrder } = await import('./repairFundService.js');
        const released = await releaseRepairFundForWorkOrder({ workLines, actor: args.actor });
        if (!released.ok) console.warn('[workOrderClosingService] repair_fund release skipped:', released.error);
      } catch (e) {
        console.warn('[workOrderClosingService] repair_fund release skipped:', e);
      }
    }

    return { ok: true, operationId: args.operationId, documentId, posted: true, updatedAt: closedTs };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Create + post an assembly_return document for the given engine, without lifecycle ties to a work-order.
 *
 * Lines: each item is one nomenclature returning from `assembly_in_progress` to either `repair_fund`
 * (`mode='rework'`) or `scrap` (`mode='scrap'`).
 */
export async function postAssemblyReturn(args: {
  engineId: string;
  actor: Actor;
  reason?: string | null;
  /**
   * Операционная дата документа (учёт «задним числом»). По умолчанию — сейчас.
   * ВАЖНО: влияет только на дату ДОКУМЕНТА, не на `performedAt` движений — те штампуются
   * реальным временем проводки, т.к. участвуют в hash-chain складских движений (порядок по
   * performedAt), и back-dating физического движения сломал бы цепочку целостности.
   */
  docDate?: number;
  lines: Array<{ nomenclatureId: string; qty: number; mode: 'rework' | 'scrap' }>;
}): Promise<Result<{ documentId: string; posted: boolean; docNo: string; docDate: number }>> {
  try {
    if (!args.engineId) return { ok: false, error: 'engineId обязателен' };
    const lines = (args.lines ?? []).filter((line) => line.nomenclatureId && line.qty > 0);
    if (lines.length === 0) return { ok: false, error: 'Нет строк для возврата' };
    for (const line of lines) {
      if (line.mode !== AssemblyReturnMode.Rework && line.mode !== AssemblyReturnMode.Scrap) {
        return { ok: false, error: `Некорректный режим возврата: ${line.mode}` };
      }
    }

    const ts = nowMs();
    const docDate = args.docDate && Number.isFinite(args.docDate) && args.docDate > 0 ? Math.trunc(args.docDate) : ts;
    const docNo = `RET-${args.engineId.replaceAll('-', '').slice(0, 8)}-${ts.toString(36)}`;
    const headerPayload: Record<string, unknown> = {
      module: 'parts_movement_v1',
      engineId: args.engineId,
    };
    if (args.reason) headerPayload.reason = args.reason;

    const created = await createWarehouseDocument({
      docType: 'assembly_return',
      status: 'draft',
      docNo,
      docDate,
      payloadJson: JSON.stringify(headerPayload),
      lines: lines.map((line) => ({
        qty: Math.max(0, Math.trunc(line.qty)),
        nomenclatureId: line.nomenclatureId,
        payloadJson: JSON.stringify({
          nomenclatureId: line.nomenclatureId,
          engineId: args.engineId,
          returnMode: line.mode,
          targetLocation: line.mode === AssemblyReturnMode.Rework ? WAREHOUSE_LOCATION_REPAIR_FUND : 'scrap',
        }),
      })),
      actor: args.actor,
    });
    if (!created.ok) return { ok: false, error: `Не удалось создать документ возврата: ${created.error}` };
    const documentId = created.id;

    const posted = await postWarehouseDocument({ documentId, actor: args.actor });
    if (!posted.ok) return { ok: false, error: `Не удалось провести возврат: ${posted.error}` };

    return { ok: true, documentId, posted: true, docNo, docDate };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ─── Stage 1 assembly lifecycle: save (draft + reserve) / post (release + post) / delete-draft ───
//
// План `docs/plans/assembly-work-order-from-forecast.md`. Существующий
// `closeWorkOrderAndPostDocument` остаётся для Repair/Workshop/Manufacturing и legacy
// прямого закрытия Assembly без save-шага. Новый flow для assembly:
//  1) saveAssemblyWorkOrderDraft  — создать (или обновить) assembly_consumption в draft,
//                                   зарезервировать детали через reservedQty.
//  2) postAssemblyWorkOrder       — освободить резерв, провести документ (списание qty),
//                                   закрыть наряд.
//  3) deleteAssemblyWorkOrderDraft — снять резерв, cancel документа, отвязать от наряда.

/** Загрузка operation для assembly-flow с типичными проверками. */
async function loadAssemblyOperation(args: { operationId: string; expectedUpdatedAt?: number }): Promise<
  Result<{
    op: typeof operations.$inferSelect;
    rawPayload: Record<string, unknown>;
    v3: ReturnType<typeof normalizeWorkOrderPayloadV3Fields>;
    engineId: string | null;
  }>
> {
  const opRows = await db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.id, args.operationId),
        eq(operations.operationType, WORK_ORDERS_OPERATION_TYPE),
        isNull(operations.deletedAt),
      ),
    )
    .limit(1);
  const op = opRows[0];
  if (!op) return { ok: false, error: 'Наряд не найден' };
  if (args.expectedUpdatedAt != null && Number(op.updatedAt) !== Math.trunc(Number(args.expectedUpdatedAt))) {
    return { ok: false, error: 'Конфликт обновления: наряд изменён другим пользователем. Обновите карточку.' };
  }
  const rawPayload = safeJsonParse(op.metaJson);
  if (!rawPayload || rawPayload.kind !== 'work_order') {
    return { ok: false, error: 'Некорректный payload наряда' };
  }
  const v3 = normalizeWorkOrderPayloadV3Fields(rawPayload);
  if (v3.workOrderKind !== WorkOrderKind.Assembly) {
    return { ok: false, error: 'Действие доступно только для сборочного наряда (workOrderKind=assembly)' };
  }
  const engineId = String(op.engineEntityId ?? '').trim() || null;
  return { ok: true, op, rawPayload, v3, engineId };
}

/** Собирает cleanLines (qty>0, nomenclatureId) для assembly_consumption. */
function buildAssemblyDocLines(args: {
  v3: ReturnType<typeof normalizeWorkOrderPayloadV3Fields>;
  rawPayload: Record<string, unknown>;
  workshopWh: string;
  engineId: string;
}): Result<{ lines: Array<{ qty: number; nomenclatureId: string; payloadJson: string }> }> {
  const workLines = collectWorkLines(args.rawPayload);
  const consumed =
    args.v3.consumedLines && args.v3.consumedLines.length > 0
      ? (args.v3.consumedLines as WorkOrderConsumedLine[])
      : buildConsumedLinesFromWorkLines(workLines, args.workshopWh);
  if (consumed.length === 0) {
    return {
      ok: false,
      error: 'Для сборочного наряда нужно указать «Наименование изделия» и количество хотя бы в одной строке работ',
    };
  }
  // Phase 2.4 PR 1: принимаем любой непустой sourceWarehouseId — uuid warehouse_location_id (новый формат
  // из UI после расширения dropdown), либо legacy code 'workshop_<N>'/'default'/system. reserve/release/post
  // резолвят оба формата через resolveLocationIdFromPayloadValue. Если строка не указала склад —
  // фолбэк на workshopWh цеха для backward-compat с legacy assembly-наряд без явного per-line склада.
  const lineInputs = consumed.map((line) => {
    const trimmed = String(line.sourceWarehouseId ?? '').trim();
    const sourceWarehouseId = trimmed.length > 0 ? trimmed : args.workshopWh;
    return {
      qty: Math.max(0, Math.trunc(line.qty)),
      nomenclatureId: line.nomenclatureId,
      payloadJson: JSON.stringify({
        nomenclatureId: line.nomenclatureId,
        sourceWarehouseId,
        engineId: args.engineId,
      }),
    };
  });
  const cleanLines = lineInputs.filter((line) => line.qty > 0 && line.nomenclatureId);
  if (cleanLines.length === 0) {
    return { ok: false, error: 'Все строки наряда нулевой или пустые — нечего сохранять' };
  }
  return { ok: true, lines: cleanLines };
}

/**
 * Сохранить сборочный наряд как черновик: создать assembly_consumption(draft) и зарезервировать детали.
 *
 * Идемпотентность: если у наряда уже linkedDocumentId,
 *  - status документа = draft → обновляем lines (createWarehouseDocument с тем же id) + reserve
 *    (предварительно release старого резерва — на случай если строки изменились);
 *  - status = cancelled → создаём новый документ;
 *  - status = posted → error «наряд уже проведён».
 *
 * Status operation остаётся 'open'.
 */
export async function saveAssemblyWorkOrderDraft(args: {
  operationId: string;
  actor: Actor;
  expectedUpdatedAt?: number;
}): Promise<Result<{ operationId: string; documentId: string; reserved: boolean; updatedAt: number }>> {
  try {
    const ts = nowMs();
    const loaded = await loadAssemblyOperation({
      operationId: args.operationId,
      ...(args.expectedUpdatedAt != null ? { expectedUpdatedAt: args.expectedUpdatedAt } : {}),
    });
    if (!loaded.ok) return loaded;
    const { op, rawPayload, v3, engineId } = loaded;

    if (String(op.status) === 'closed') {
      return { ok: false, error: 'Наряд уже проведён — сохранение черновика недоступно' };
    }
    if (!v3.workshopId) return { ok: false, error: 'У наряда не задан цех (workshopId)' };
    if (!engineId) return { ok: false, error: 'У сборочного наряда не привязан двигатель (operations.engineEntityId)' };

    const workshopWh = await resolveWorkshopWarehouseId(v3.workshopId);
    if (!workshopWh) return { ok: false, error: 'Указанный цех не найден или не активен' };

    const linesResult = buildAssemblyDocLines({ v3, rawPayload, workshopWh, engineId });
    if (!linesResult.ok) return linesResult;
    const cleanLines = linesResult.lines;

    const workOrderNumber = Number((rawPayload as { workOrderNumber?: number }).workOrderNumber ?? 0);

    let documentId: string | null = v3.linkedDocumentId ?? null;
    if (documentId) {
      const docRows = await db
        .select({ id: erpDocumentHeaders.id, status: erpDocumentHeaders.status })
        .from(erpDocumentHeaders)
        .where(and(eq(erpDocumentHeaders.id, documentId), isNull(erpDocumentHeaders.deletedAt)))
        .limit(1);
      const docRow = docRows[0];
      if (!docRow) {
        documentId = null;
      } else if (String(docRow.status) === 'posted') {
        return { ok: false, error: 'Связанный складской документ уже проведён — сохранение недоступно' };
      } else if (String(docRow.status) === 'cancelled') {
        documentId = null;
      } else {
        const released = await releaseAssemblyDraftReservation({ documentId, actor: args.actor });
        if (!released.ok) return { ok: false, error: `Не удалось снять старый резерв: ${released.error}` };
      }
    }

    const docNo = buildDocNo('ASM', workOrderNumber, args.operationId);
    const headerPayloadObj: Record<string, unknown> = {
      module: 'parts_movement_v1',
      workshopId: v3.workshopId,
      workshopWarehouseId: workshopWh,
      workOrderOperationId: args.operationId,
      workOrderNumber,
      engineId,
    };
    const headerPayloadJson = JSON.stringify(headerPayloadObj);

    const createArgs = {
      docType: 'assembly_consumption',
      status: 'draft' as const,
      docNo,
      docDate: ts,
      payloadJson: headerPayloadJson,
      lines: cleanLines.map((line) => ({
        qty: line.qty,
        nomenclatureId: line.nomenclatureId,
        payloadJson: line.payloadJson,
      })),
      actor: args.actor,
    };
    const created = documentId
      ? await createWarehouseDocument({ id: documentId, ...createArgs })
      : await createWarehouseDocument(createArgs);
    if (!created.ok) return { ok: false, error: `Не удалось сохранить документ: ${created.error}` };
    documentId = created.id;

    const reserved = await reserveAssemblyDraftReservation({ documentId, actor: args.actor });
    if (!reserved.ok) return { ok: false, error: `Не удалось зарезервировать детали: ${reserved.error}` };

    const updatedPayload: Record<string, unknown> = {
      ...rawPayload,
      version: WORK_ORDER_PAYLOAD_VERSION,
      linkedDocumentId: documentId,
    };
    const updatedTs = nowMs();
    await db
      .update(operations)
      .set({
        status: 'open',
        metaJson: JSON.stringify(updatedPayload),
        updatedAt: updatedTs,
        syncStatus: 'pending',
      })
      .where(eq(operations.id, args.operationId));
    await emitOperationSyncChange(args.operationId, args.actor);

    return { ok: true, operationId: args.operationId, documentId, reserved: true, updatedAt: updatedTs };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Провести assembly-наряд: снять резерв, postWarehouseDocument (списание qty), закрыть наряд.
 * Требует предварительного `saveAssemblyWorkOrderDraft` (у наряда должен быть linkedDocumentId
 * со status=draft). Для legacy одношагового закрытия использовать `closeWorkOrderAndPostDocument`.
 *
 * Идемпотентность: если operation.status='closed' и документ posted — возвращает success без действий.
 */
export async function postAssemblyWorkOrder(args: {
  operationId: string;
  actor: Actor;
  expectedUpdatedAt?: number;
}): Promise<Result<{ operationId: string; documentId: string; posted: boolean; updatedAt: number }>> {
  try {
    const loaded = await loadAssemblyOperation({
      operationId: args.operationId,
      ...(args.expectedUpdatedAt != null ? { expectedUpdatedAt: args.expectedUpdatedAt } : {}),
    });
    if (!loaded.ok) return loaded;
    const { op, rawPayload, v3, engineId } = loaded;

    if (!v3.linkedDocumentId) {
      return { ok: false, error: 'Сначала сохраните наряд как черновик (saveAssemblyWorkOrderDraft)' };
    }
    const documentId = v3.linkedDocumentId;

    if (String(op.status) === 'closed') {
      return { ok: true, operationId: args.operationId, documentId, posted: true, updatedAt: Number(op.updatedAt) || nowMs() };
    }

    const docRows = await db
      .select({ id: erpDocumentHeaders.id, status: erpDocumentHeaders.status })
      .from(erpDocumentHeaders)
      .where(and(eq(erpDocumentHeaders.id, documentId), isNull(erpDocumentHeaders.deletedAt)))
      .limit(1);
    const docRow = docRows[0];
    if (!docRow) return { ok: false, error: 'Связанный документ не найден' };
    if (String(docRow.status) === 'posted') {
      const released = await releaseAssemblyDraftReservation({ documentId, actor: args.actor, outcome: 'consumed' });
      if (!released.ok) return { ok: false, error: `Документ проведён, но не удалось закрыть его резерв: ${released.error}` };
    } else if (String(docRow.status) !== 'draft') {
      return { ok: false, error: `Документ в статусе ${String(docRow.status)} — провести нельзя` };
    } else {
      const posted = await postWarehouseDocument({ documentId, actor: args.actor });
      if (!posted.ok) return { ok: false, error: `Не удалось провести документ: ${posted.error}` };

      const released = await releaseAssemblyDraftReservation({ documentId, actor: args.actor, outcome: 'consumed' });
      if (!released.ok) return { ok: false, error: `Документ проведён, но не удалось закрыть его резерв: ${released.error}` };
    }

    const updatedPayload: Record<string, unknown> = {
      ...rawPayload,
      version: WORK_ORDER_PAYLOAD_VERSION,
      linkedDocumentId: documentId,
    };
    const closedTs = nowMs();
    await db
      .update(operations)
      .set({
        status: 'closed',
        metaJson: JSON.stringify(updatedPayload),
        updatedAt: closedTs,
        syncStatus: 'pending',
      })
      .where(eq(operations.id, args.operationId));
    await emitOperationSyncChange(args.operationId, args.actor);

    if (engineId) {
      const phaseResult = await setEnginePhase({
        engineId,
        phase: EnginePhase.Assembled,
        actor: { id: args.actor.id, username: args.actor.username },
        reasonDocumentId: documentId,
      });
      if (!phaseResult.ok) {
        console.warn('[workOrderClosingService] engine_phase=assembled skipped:', phaseResult.error);
      }
    }

    return { ok: true, operationId: args.operationId, documentId, posted: true, updatedAt: closedTs };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Удалить черновик сборочного наряда:
 *  - снять резерв (releaseAssemblyDraftReservation),
 *  - перевести документ в 'cancelled' (cancelWarehouseDocument),
 *  - убрать linkedDocumentId из payload наряда.
 *
 * Operation сам не удаляется и не закрывается — остаётся 'open' без резерва. Так оператор
 * может либо отредактировать строки и заново сохранить, либо удалить наряд через обычный delete.
 */
export async function deleteAssemblyWorkOrderDraft(args: {
  operationId: string;
  actor: Actor;
  expectedUpdatedAt?: number;
}): Promise<Result<{ operationId: string; updatedAt: number }>> {
  try {
    const loaded = await loadAssemblyOperation({
      operationId: args.operationId,
      ...(args.expectedUpdatedAt != null ? { expectedUpdatedAt: args.expectedUpdatedAt } : {}),
    });
    if (!loaded.ok) return loaded;
    const { op, rawPayload, v3 } = loaded;

    if (String(op.status) === 'closed') {
      return { ok: false, error: 'Проведённый наряд нельзя превратить обратно в черновик — оформите возврат' };
    }
    if (!v3.linkedDocumentId) {
      return { ok: false, error: 'У наряда нет связанного черновика для удаления' };
    }
    const documentId = v3.linkedDocumentId;

    const docRows = await db
      .select({ id: erpDocumentHeaders.id, status: erpDocumentHeaders.status })
      .from(erpDocumentHeaders)
      .where(and(eq(erpDocumentHeaders.id, documentId), isNull(erpDocumentHeaders.deletedAt)))
      .limit(1);
    const docRow = docRows[0];
    if (docRow && String(docRow.status) === 'draft') {
      const released = await releaseAssemblyDraftReservation({ documentId, actor: args.actor });
      if (!released.ok) return { ok: false, error: `Не удалось снять резерв: ${released.error}` };
      const cancelled = await cancelWarehouseDocument({ documentId, actor: args.actor });
      if (!cancelled.ok) return { ok: false, error: `Не удалось отменить документ: ${cancelled.error}` };
    } else if (docRow && String(docRow.status) === 'cancelled') {
      // Уже cancelled — продолжаем убирать ссылку из наряда.
    } else if (docRow && String(docRow.status) === 'posted') {
      return { ok: false, error: 'Связанный документ уже проведён — удаление черновика невозможно' };
    }

    const updatedPayload: Record<string, unknown> = {
      ...rawPayload,
      version: WORK_ORDER_PAYLOAD_VERSION,
    };
    delete updatedPayload['linkedDocumentId'];
    const ts = nowMs();
    await db
      .update(operations)
      .set({
        metaJson: JSON.stringify(updatedPayload),
        updatedAt: ts,
        syncStatus: 'pending',
      })
      .where(eq(operations.id, args.operationId));
    await emitOperationSyncChange(args.operationId, args.actor);

    return { ok: true, operationId: args.operationId, updatedAt: ts };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
