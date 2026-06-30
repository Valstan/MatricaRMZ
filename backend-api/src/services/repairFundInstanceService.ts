/**
 * Ремфонд Ф3 (план docs/plans/repair-fund-2026-06.md): поэкземплярный учёт деталей
 * по личным (набитым) номерам. Записи — строки `operations`
 * (`operationType='repair_fund_instance'`), `engineEntityId` = двигатель-источник
 * (провенанс). Одна строка на физический номерной экземпляр.
 *
 * Идемпотентность по ключу `(engineId, nomenclatureId, stampedNumber)`: повторный
 * захват без изменений ничего не пишет; смена классификации перезаписывает запись
 * (soft-delete прежней + новая). Уже продвинутый статус (`repaired` после Ф2) при
 * неизменной классификации сохраняется — повтор не откатывает его в `in_fund`.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';

import {
  REPAIR_FUND_INSTANCE_TYPE,
  SyncTableName,
  buildRepairFundInstanceNote,
  canToggleRepairedStatus,
  parseRepairFundInstancePayload,
  repairFundInstanceStatusLabel,
  statusFromClassification,
  toRepairFundInstanceClassification,
  type RepairFundInstanceClassification,
  type RepairFundInstancePayload,
  type RepairFundInstanceStatus,
} from '@matricarmz/shared';

import { db } from '../database/db.js';
import { operations } from '../database/schema.js';
import { recordSyncChanges, type SyncChange } from './sync/syncChangeService.js';
import { resolvePartIdToNomenclatureMap } from './workOrderClosingService.js';

type Actor = { id: string; username: string; role?: string };

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

type CaptureInstance = {
  partId: string;
  partLabel: string;
  stampedNumber: string;
  classification: RepairFundInstanceClassification;
};

function nowMs(): number {
  return Date.now();
}

function instanceKey(nomenclatureId: string, stampedNumber: string): string {
  return `${nomenclatureId}|${stampedNumber.trim().toLowerCase()}`;
}

/** Экземпляр после резолва partId→nomenclatureId, готовый к планированию. */
export type ResolvedInstance = {
  nomenclatureId: string;
  partId: string;
  partLabel: string;
  stampedNumber: string;
  classification: RepairFundInstanceClassification;
};

export type CapturePlanItem = {
  key: string;
  instance: ResolvedInstance;
  /** id прежней операции этого экземпляра, которую soft-delete'им (смена классификации); null = новый. */
  replacesOpId: string | null;
};

export type CapturePlan = {
  inserts: CapturePlanItem[];
  added: number;
  updated: number;
  unchanged: number;
  total: number;
};

/**
 * Чистое решение захвата (без БД) — что вставить/перезаписать/пропустить.
 * `prior` — текущие экземпляры двигателя (key → { opId, classification }).
 * Правила: неизменная классификация → no-op (сохраняем продвинутый статус Ф2);
 * смена классификации → перезапись (soft-delete + insert); новый ключ → insert;
 * дубли во входе (один и тот же key) схлопываются.
 */
export function planStampedInstanceCapture(
  prior: Map<string, { opId: string; classification: RepairFundInstanceClassification }>,
  incoming: ReadonlyArray<ResolvedInstance>,
): CapturePlan {
  const inserts: CapturePlanItem[] = [];
  const seen = new Set<string>();
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const inst of incoming) {
    const nomenclatureId = inst.nomenclatureId.trim();
    const stampedNumber = inst.stampedNumber.trim();
    if (!nomenclatureId || !stampedNumber) continue;
    const key = instanceKey(nomenclatureId, stampedNumber);
    if (seen.has(key)) continue;
    seen.add(key);
    const existing = prior.get(key);
    if (existing && existing.classification === inst.classification) {
      unchanged += 1;
      continue;
    }
    if (existing) {
      updated += 1;
      inserts.push({ key, instance: inst, replacesOpId: existing.opId });
    } else {
      added += 1;
      inserts.push({ key, instance: inst, replacesOpId: null });
    }
  }
  return { inserts, added, updated, unchanged, total: seen.size };
}

export type EngineStampedInstanceRecord = RepairFundInstancePayload & { operationId: string };

/** Текущие (не удалённые) экземпляры двигателя: key → { opId, classification }. */
async function loadEngineInstances(
  engineId: string,
): Promise<Map<string, { opId: string; classification: RepairFundInstanceClassification }>> {
  const rows = await db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.operationType, REPAIR_FUND_INSTANCE_TYPE),
        eq(operations.engineEntityId, engineId),
        isNull(operations.deletedAt),
      ),
    );
  const out = new Map<string, { opId: string; classification: RepairFundInstanceClassification }>();
  for (const r of rows) {
    const payload = parseRepairFundInstancePayload(r.metaJson ? String(r.metaJson) : null);
    if (!payload || !payload.nomenclatureId || !payload.stampedNumber) continue;
    out.set(instanceKey(payload.nomenclatureId, payload.stampedNumber), {
      opId: String(r.id),
      classification: payload.classification,
    });
  }
  return out;
}

/** Список экземпляров двигателя (не удалённые), для ответа capture и кросс-проверок. */
export async function listStampedInstancesForEngine(engineId: string): Promise<EngineStampedInstanceRecord[]> {
  const rows = await db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.operationType, REPAIR_FUND_INSTANCE_TYPE),
        eq(operations.engineEntityId, String(engineId ?? '').trim()),
        isNull(operations.deletedAt),
      ),
    );
  const out: EngineStampedInstanceRecord[] = [];
  for (const r of rows) {
    const payload = parseRepairFundInstancePayload(r.metaJson ? String(r.metaJson) : null);
    if (!payload) continue;
    out.push({ ...payload, operationId: String(r.id) });
  }
  return out;
}

/**
 * Захватывает номерные экземпляры деталей двигателя в реестр Ф3. `instances` —
 * уже посчитанный на клиенте список (см. `buildStampedInstancesFromInventory`).
 */
export async function captureStampedInstancesFromEngine(args: {
  engineId: string;
  instances: CaptureInstance[];
  actor: Actor;
}): Promise<
  Result<{
    added: number;
    updated: number;
    unchanged: number;
    total: number;
    instances: EngineStampedInstanceRecord[];
    skippedNoNom?: number;
  }>
> {
  try {
    const engineId = String(args.engineId ?? '').trim();
    if (!engineId) return { ok: false, error: 'Не задан двигатель' };

    const partIds = [...new Set(args.instances.map((i) => String(i.partId ?? '').trim()).filter(Boolean))];
    const nomMap = partIds.length ? await resolvePartIdToNomenclatureMap(partIds) : new Map<string, string>();

    // Резолвим partId→nomenclatureId; нерезолвенные считаем и отбрасываем.
    const resolved: ResolvedInstance[] = [];
    let skippedNoNom = 0;
    for (const inst of args.instances) {
      const partId = String(inst.partId ?? '').trim();
      const stampedNumber = String(inst.stampedNumber ?? '').trim();
      if (!partId || !stampedNumber) continue;
      const nomenclatureId = nomMap.get(partId);
      if (!nomenclatureId) {
        skippedNoNom += 1;
        continue;
      }
      resolved.push({
        nomenclatureId,
        partId,
        partLabel: String(inst.partLabel ?? ''),
        stampedNumber,
        classification: toRepairFundInstanceClassification(inst.classification),
      });
    }

    const prior = await loadEngineInstances(engineId);
    const plan = planStampedInstanceCapture(prior, resolved);

    const ts = nowMs();
    const by = args.actor.username || 'system';
    const role = args.actor.role ?? 'user';

    // Server-side write → проводим через единый sync-путь (recordSyncChanges: ledger-подпись
    // + last_server_seq + проекция в operations), иначе incremental pull клиентов их не увидит
    // (фильтр по last_server_seq). Замена (смена классификации) — upsert по тому же opId
    // (in-place, без дублей/сирот). Образец — workOrderClosingService.writeRepairReadyPartStatusEvents.
    const changes: SyncChange[] = plan.inserts.map((item) => {
      const id = item.replacesOpId ?? randomUUID();
      const payload: RepairFundInstancePayload = {
        kind: REPAIR_FUND_INSTANCE_TYPE,
        engineEntityId: engineId,
        nomenclatureId: item.instance.nomenclatureId,
        partId: item.instance.partId,
        partLabel: item.instance.partLabel,
        stampedNumber: item.instance.stampedNumber,
        classification: item.instance.classification,
        status: statusFromClassification(item.instance.classification),
        capturedAt: ts,
        capturedBy: by,
      };
      return {
        tableName: SyncTableName.Operations,
        rowId: id,
        op: 'upsert' as const,
        payload: {
          id,
          engine_entity_id: engineId,
          operation_type: REPAIR_FUND_INSTANCE_TYPE,
          status: 'event',
          note: buildRepairFundInstanceNote(payload),
          performed_at: ts,
          performed_by: by,
          meta_json: JSON.stringify(payload),
          created_at: ts,
          updated_at: ts,
          deleted_at: null,
          sync_status: 'synced',
        },
        ts,
      };
    });
    if (changes.length > 0) {
      await recordSyncChanges({ id: args.actor.id, username: by, role }, changes);
    }

    const instances = await listStampedInstancesForEngine(engineId);
    return {
      ok: true,
      added: plan.added,
      updated: plan.updated,
      unchanged: plan.unchanged,
      total: plan.total,
      instances,
      ...(skippedNoNom > 0 ? { skippedNoNom } : {}),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Ф3.1: ручная отметка экземпляра «отремонтирована» (`in_fund → repaired`) либо возврат
 * в фонд (`repaired → in_fund`) с карточки двигателя. Точно, без эвристики «первые N» —
 * мастер указывает конкретную физическую деталь по личному номеру. Серверная запись →
 * проводим через `recordSyncChanges` (upsert по тому же opId, in-place), иначе incremental
 * pull клиентов её не увидит. Терминальные `scrapped`/`replaced` сменить нельзя.
 */
export async function setStampedInstanceRepaired(args: {
  operationId: string;
  repaired: boolean;
  actor: Actor;
}): Promise<Result<{ instances: EngineStampedInstanceRecord[]; changed: boolean }>> {
  try {
    const opId = String(args.operationId ?? '').trim();
    if (!opId) return { ok: false, error: 'Не задан экземпляр' };

    const rows = await db
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.id, opId),
          eq(operations.operationType, REPAIR_FUND_INSTANCE_TYPE),
          isNull(operations.deletedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return { ok: false, error: 'Экземпляр не найден' };

    const payload = parseRepairFundInstancePayload(row.metaJson ? String(row.metaJson) : null);
    if (!payload || !payload.engineEntityId) return { ok: false, error: 'Битая запись экземпляра' };

    if (!canToggleRepairedStatus(payload.status)) {
      return { ok: false, error: `Нельзя сменить статус «${repairFundInstanceStatusLabel(payload.status)}» вручную` };
    }

    const engineId = payload.engineEntityId;
    const nextStatus: RepairFundInstanceStatus = args.repaired ? 'repaired' : 'in_fund';
    if (payload.status === nextStatus) {
      const instances = await listStampedInstancesForEngine(engineId);
      return { ok: true, instances, changed: false };
    }

    const ts = nowMs();
    const by = args.actor.username || 'system';
    const role = args.actor.role ?? 'user';
    const nextPayload: RepairFundInstancePayload = { ...payload, status: nextStatus };

    await recordSyncChanges({ id: args.actor.id, username: by, role }, [
      {
        tableName: SyncTableName.Operations,
        rowId: opId,
        op: 'upsert' as const,
        payload: {
          id: opId,
          engine_entity_id: engineId,
          operation_type: REPAIR_FUND_INSTANCE_TYPE,
          status: 'event',
          note: buildRepairFundInstanceNote(nextPayload),
          performed_at: Number(row.performedAt ?? payload.capturedAt ?? ts),
          performed_by: row.performedBy ? String(row.performedBy) : by,
          meta_json: JSON.stringify(nextPayload),
          created_at: Number(row.createdAt ?? ts),
          updated_at: ts,
          deleted_at: null,
          sync_status: 'synced',
        },
        ts,
      },
    ]);

    const instances = await listStampedInstancesForEngine(engineId);
    return { ok: true, instances, changed: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
