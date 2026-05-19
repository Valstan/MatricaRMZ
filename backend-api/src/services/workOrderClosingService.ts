import { and, eq, isNull } from 'drizzle-orm';

import {
  AssemblyReturnMode,
  WAREHOUSE_LOCATION_REPAIR_FUND,
  WORK_ORDER_PAYLOAD_VERSION,
  WorkOrderKind,
  isWorkshopWarehouseId,
  normalizeWorkOrderPayloadV3Fields,
  parseWorkshopWarehouseId,
  workshopWarehouseId,
  type WorkOrderConsumedLine,
  type WorkOrderProducedLine,
} from '@matricarmz/shared';

import { db } from '../database/db.js';
import { directoryWorkshops, operations } from '../database/schema.js';
import { EnginePhase, setEnginePhase } from './enginePhaseService.js';
import {
  createWarehouseDocument,
  planWarehouseDocument,
  postWarehouseDocument,
} from './warehouseService.js';

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
}): Promise<Result<{ operationId: string; documentId: string | null; posted: boolean }>> {
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
      return { ok: true, operationId: args.operationId, documentId: v3.linkedDocumentId, posted: true };
    }

    if (!v3.workOrderKind) {
      return { ok: false, error: 'У наряда не задан тип (workOrderKind: repair | assembly)' };
    }
    if (!v3.workshopId) {
      return { ok: false, error: 'У наряда не задан цех (workshopId)' };
    }

    const workshopWh = await resolveWorkshopWarehouseId(v3.workshopId);
    if (!workshopWh) {
      return { ok: false, error: 'Указанный цех не найден или не активен' };
    }

    const engineEntityId = String(op.engineEntityId ?? '');
    const engineIdForMovements = engineEntityId || null;
    const workOrderNumber = Number((rawPayload as { workOrderNumber?: number }).workOrderNumber ?? 0);

    let docType: string;
    let docNoPrefix: string;
    let initialStatus: 'draft' | 'planned';
    let needsPlanStep: boolean;
    let lineInputs: Array<{ qty: number; nomenclatureId: string; payloadJson: string }>;

    if (v3.workOrderKind === WorkOrderKind.Repair) {
      const produced = (v3.producedLines ?? []) as WorkOrderProducedLine[];
      if (produced.length === 0) {
        return { ok: false, error: 'Для ремонтного наряда нужны строки производимых деталей (producedLines)' };
      }
      docType = 'repair_recovery';
      docNoPrefix = 'REP';
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
            engineId: engineIdForMovements,
          }),
        };
      });
    } else if (v3.workOrderKind === WorkOrderKind.Assembly) {
      const consumed = (v3.consumedLines ?? []) as WorkOrderConsumedLine[];
      if (consumed.length === 0) {
        return { ok: false, error: 'Для сборочного наряда нужны строки расходуемых деталей (consumedLines)' };
      }
      if (!engineIdForMovements) {
        return { ok: false, error: 'У сборочного наряда не привязан двигатель (operations.engineEntityId)' };
      }
      docType = 'assembly_consumption';
      docNoPrefix = 'ASM';
      initialStatus = 'draft';
      needsPlanStep = false;
      lineInputs = consumed.map((line) => {
        const sourceWarehouseId = parseWorkshopWarehouseId(line.sourceWarehouseId) ? line.sourceWarehouseId : workshopWh;
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
      ...rawPayload,
      version: WORK_ORDER_PAYLOAD_VERSION,
      linkedDocumentId: documentId,
    };
    await db
      .update(operations)
      .set({
        status: 'closed',
        metaJson: JSON.stringify(updatedPayload),
        updatedAt: nowMs(),
        syncStatus: 'pending',
      })
      .where(eq(operations.id, args.operationId));

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

    return { ok: true, operationId: args.operationId, documentId, posted: true };
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
  lines: Array<{ nomenclatureId: string; qty: number; mode: 'rework' | 'scrap' }>;
}): Promise<Result<{ documentId: string; posted: boolean }>> {
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
      docDate: ts,
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

    return { ok: true, documentId, posted: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
