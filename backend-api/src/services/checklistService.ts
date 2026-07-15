import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';

import type { RepairChecklistPayload, RepairChecklistTemplate, WorkOrderPayload } from '@matricarmz/shared';
import {
  applyWorkOrderWithdrawal,
  buildAutoWithdrawReason,
  ENGINE_INVENTORY_STAGE,
  isScrapEngine,
  listScrapPartNames,
  resolveAssemblyEngineId,
  type StatusCode,
  SyncTableName,
  WorkOrderKind,
} from '@matricarmz/shared';

import { db } from '../database/db.js';
import { operations, rowOwners } from '../database/schema.js';
import { getEntityDetails, listEntitiesByType, listEntityTypes } from './adminMasterdataService.js';
import { recordSyncChanges } from './sync/syncChangeService.js';

type Actor = { id: string; username: string };

function nowMs() {
  return Date.now();
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function defaultCompletenessTemplate(): RepairChecklistTemplate {
  return {
    id: 'completeness_default',
    code: 'completeness_act_default',
    name: 'Акт комплектности двигателя (MVP)',
    stage: 'completeness',
    version: 1,
    active: true,
    items: [
      { id: 'contract_number', label: 'Номер договора', kind: 'text' },
      { id: 'engine_brand', label: 'Марка двигателя', kind: 'text', required: true },
      { id: 'engine_number', label: '№ двигателя', kind: 'text', required: true },
      { id: 'engine_internal_number', label: 'Внутренний №', kind: 'text' },
      { id: 'inspection_method', label: 'Проверка комплектности (способ)', kind: 'text' },
      {
        id: 'completeness_items',
        label: 'Комплектность по группам',
        kind: 'table',
        columns: [
          { id: 'part_name', label: 'Наименование' },
          { id: 'assembly_unit_number', label: 'Обозначение (№ сборочной единицы)' },
          { id: 'quantity', label: 'Количество', kind: 'number' },
          { id: 'present', label: 'Наличие', kind: 'boolean' },
          { id: 'actual_qty', label: 'Фактическое количество', kind: 'number' },
        ],
      },
      { id: 'approved_by', label: 'Утверждаю: директор по качеству', kind: 'signature' },
      { id: 'commission_chief', label: 'Врио начальника цеха', kind: 'signature' },
      { id: 'commission_master', label: 'Мастер цеха', kind: 'signature' },
      { id: 'commission_otk', label: 'Начальник ОТК', kind: 'signature' },
      { id: 'act_date', label: 'Дата акта', kind: 'date' },
    ],
  };
}

function defaultDefectTemplate(): RepairChecklistTemplate {
  return {
    id: 'defect_default',
    code: 'defect_sheet_default',
    name: 'Лист дефектовки двигателя (MVP)',
    stage: 'defect',
    version: 2,
    active: true,
    items: [
      { id: 'defect_act_number', label: 'Акт полной дефектовки двигателя (номер)', kind: 'text' },
      { id: 'engine_brand', label: 'Марка двигателя', kind: 'text', required: true },
      { id: 'engine_number', label: '№ двигателя', kind: 'text', required: true },
      { id: 'engine_internal_number', label: 'Внутренний №', kind: 'text' },
      { id: 'passport_number', label: 'Паспорт двигателя (№)', kind: 'text' },
      { id: 'defect_start_date', label: 'Дата начала дефектовки', kind: 'date' },
      { id: 'defect_end_date', label: 'Дата окончания дефектовки', kind: 'date' },
      { id: 'defect_summary', label: 'Итоги дефектовки', kind: 'text' },
      {
        id: 'defect_items',
        label: 'Результаты дефектовки',
        kind: 'table',
        columns: [
          { id: 'part_name', label: 'Наименование узла (детали)' },
          { id: 'part_number', label: '№ детали (узла)' },
          { id: 'quantity', label: 'Количество', kind: 'number' },
          { id: 'repairable_qty', label: 'Ремонтно-пригодная', kind: 'number' },
          { id: 'scrap_qty', label: 'Утиль', kind: 'number' },
        ],
      },
      { id: 'compiled_by', label: 'Настоящий акт составил (ФИО, должность, подпись)', kind: 'signature' },
      { id: 'agreed_by', label: 'Настоящий акт согласовали (ФИО, должность, подпись)', kind: 'signature' },
      { id: 'tech_director', label: 'Ремонт производить в соответствии с настоящим актом (ФИО, должность, подпись)', kind: 'signature' },
    ],
  };
}

function defaultEngineInventoryTemplate(): RepairChecklistTemplate {
  // Объединённый список деталей двигателя — заменяет defect + completeness.
  // См. docs/plans/checklist-unify.md и shared/repairChecklist.ts (EngineInventoryRow).
  return {
    id: 'engine_inventory_default',
    code: 'engine_inventory_default',
    name: 'Список деталей двигателя (приёмка + дефектовка)',
    stage: ENGINE_INVENTORY_STAGE,
    version: 1,
    active: true,
    items: [
      { id: 'contract_number', label: 'Номер договора', kind: 'text' },
      { id: 'engine_brand', label: 'Марка двигателя', kind: 'text', required: true },
      { id: 'engine_number', label: '№ двигателя', kind: 'text', required: true },
      { id: 'engine_internal_number', label: 'Внутренний №', kind: 'text' },
      { id: 'arrival_date', label: 'Дата приёмки двигателя', kind: 'date' },
      { id: 'defect_start_date', label: 'Дата начала дефектовки', kind: 'date' },
      { id: 'defect_end_date', label: 'Дата окончания дефектовки', kind: 'date' },
      {
        id: 'engine_inventory_items',
        label: 'Список деталей двигателя',
        kind: 'table',
        columns: [
          { id: 'part_name', label: 'Наименование детали (узла)' },
          { id: 'assembly_unit_number', label: '№ сборочной единицы' },
          { id: 'part_number', label: '№ детали по чертежу' },
          { id: 'quantity', label: 'План', kind: 'number' },
          { id: 'present', label: 'На месте при приёмке', kind: 'boolean' },
          { id: 'actual_qty', label: 'Фактически принято', kind: 'number' },
          { id: 'repairable_qty', label: 'Ремонтопригодная', kind: 'number' },
          { id: 'scrap_qty', label: 'В утиль', kind: 'number' },
          { id: 'replace_qty', label: 'Заменить новой', kind: 'number' },
        ],
      },
      { id: 'acceptance_signed_by', label: 'Приёмку провёл (ФИО, должность, подпись)', kind: 'signature' },
      { id: 'defect_signed_by', label: 'Дефектовку провёл (ФИО, должность, подпись)', kind: 'signature' },
      { id: 'approved_by', label: 'Утверждаю: директор по качеству', kind: 'signature' },
    ],
  };
}

function defaultTemplates(): RepairChecklistTemplate[] {
  return [
    defaultCompletenessTemplate(),
    defaultDefectTemplate(),
    defaultEngineInventoryTemplate(),
  ];
}

function filterByStage(templates: RepairChecklistTemplate[], stage?: string) {
  return stage ? templates.filter((t) => t.stage === stage) : templates;
}

function normalizeOpFromDeletedAt(deletedAt: number | null | undefined) {
  return deletedAt ? 'delete' : 'upsert';
}

function operationPayload(row: {
  id: string;
  engineEntityId: string;
  operationType: string;
  status: string;
  note: string | null;
  performedAt: number | null;
  performedBy: string | null;
  metaJson: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncStatus: string;
}) {
  return {
    id: String(row.id),
    engine_entity_id: String(row.engineEntityId),
    operation_type: String(row.operationType),
    status: String(row.status),
    note: row.note ?? null,
    performed_at: row.performedAt ?? null,
    performed_by: row.performedBy ?? null,
    meta_json: row.metaJson ?? null,
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: String(row.syncStatus ?? 'synced'),
  };
}

async function insertChangeLog(rowId: string, payload: unknown, actor: Actor, opts: { allowSyncConflicts?: boolean } = {}) {
  await recordSyncChanges(
    { id: actor.id, username: actor.username, role: 'user' },
    [
      {
        tableName: SyncTableName.Operations,
        rowId,
        op: normalizeOpFromDeletedAt((payload as any)?.deleted_at ?? null),
        payload: payload as Record<string, unknown>,
        ts: nowMs(),
      },
    ],
    opts,
  );
}

async function ensureOwner(tableName: SyncTableName, rowId: string, actor: Actor) {
  if (!actor?.id) return;
  await db
    .insert(rowOwners)
    .values({
      id: randomUUID(),
      tableName,
      rowId: rowId as any,
      ownerUserId: actor.id as any,
      ownerUsername: actor.username ?? null,
      createdAt: nowMs(),
    })
    .onConflictDoNothing();
}

export async function listRepairChecklistTemplates(stage?: string) {
  try {
    const types = await listEntityTypes();
    const type = types.find((t) => String((t as any).code) === 'repair_checklist_template') ?? null;
    if (!type) {
      return { ok: true as const, templates: filterByStage(defaultTemplates(), stage) };
    }

    const items = await listEntitiesByType(String((type as any).id));
    const out: RepairChecklistTemplate[] = [];
    for (const it of items) {
      const d = await getEntityDetails(String(it.id));
      const a = d.attributes ?? {};
      const itemsVal = (a as any).itemsJson ?? (a as any).items ?? null;
      const itemsParsed = Array.isArray(itemsVal) ? itemsVal : typeof itemsVal === 'string' ? safeJsonParse(itemsVal) : itemsVal;
      if (!Array.isArray(itemsParsed)) continue;
      const tmpl: RepairChecklistTemplate = {
        id: d.id,
        code: String((a as any).code ?? it.id),
        name: String((a as any).name ?? it.displayName ?? 'Шаблон'),
        stage: String((a as any).stage ?? ENGINE_INVENTORY_STAGE),
        version: Number((a as any).version ?? 1) || 1,
        active: (a as any).active === false ? false : true,
        items: itemsParsed as any,
      };
      if (stage && tmpl.stage !== stage) continue;
      out.push(tmpl);
    }

    if (out.length === 0) return { ok: true as const, templates: filterByStage(defaultTemplates(), stage) };
    return { ok: true as const, templates: out };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function getRepairChecklistForEngine(
  engineId: string,
  stage: string,
): Promise<{ ok: true; operationId: string | null; payload: RepairChecklistPayload | null } | { ok: false; error: string }> {
  try {
    const rows = await db
      .select()
      .from(operations)
      .where(and(eq(operations.engineEntityId, engineId as any), eq(operations.operationType, stage), isNull(operations.deletedAt)))
      .orderBy(desc(operations.updatedAt))
      .limit(200);

    for (const r of rows as any[]) {
      const raw = r.metaJson ? String(r.metaJson) : '';
      if (!raw) continue;
      const parsed = safeJsonParse(raw) as any;
      if (parsed && typeof parsed === 'object' && parsed.kind === 'repair_checklist') {
        return { ok: true as const, operationId: String(r.id), payload: parsed as RepairChecklistPayload };
      }
    }

    return { ok: true as const, operationId: null, payload: null };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

/**
 * Связка «утиль ⇄ наряд на сборку» (web-admin путь; клиентские правки дефектовки
 * отрабатывает такой же хук в electron main): после сохранения дефектовки с утильными
 * строками отзывает из работы выданные Assembly-наряды двигателя. Изменение уезжает
 * клиентам через recordSyncChanges. Идемпотентен: не-выданные наряды пропускает.
 */
async function autoWithdrawIssuedAssemblyWorkOrders(args: {
  engineId: string;
  checklistPayload: RepairChecklistPayload;
  actor: Actor;
  allowSyncConflicts?: boolean;
}): Promise<void> {
  const scrapParts = listScrapPartNames(args.checklistPayload);
  if (scrapParts.length === 0) return;
  // Утильный двигатель: его наряд на сборку — штатный путь возврата заказчику, утиль в
  // дефектовке для него ожидаем. Не отзываем (иначе метка утиля отзывала бы свой же наряд).
  const engine = await getEntityDetails(args.engineId).catch(() => null);
  if (isScrapEngine((engine?.attributes ?? {}) as Partial<Record<StatusCode, boolean>>)) return;
  // Без фильтра по engine_entity_id: у старых Assembly-нарядов колонка может быть пустой,
  // двигатель резолвится из payload (resolveAssemblyEngineId) ниже.
  const rows = await db
    .select()
    .from(operations)
    .where(and(eq(operations.operationType, 'work_order'), isNull(operations.deletedAt)));
  const ts = nowMs();
  const reason = buildAutoWithdrawReason(scrapParts);
  const syncOptions = args.allowSyncConflicts ? { allowSyncConflicts: true } : {};
  for (const r of rows as any[]) {
    if (String(r.status) === 'closed') continue;
    const parsed = safeJsonParse(r.metaJson ? String(r.metaJson) : '') as WorkOrderPayload | null;
    if (!parsed || typeof parsed !== 'object' || parsed.kind !== 'work_order') continue;
    if (parsed.workOrderKind !== WorkOrderKind.Assembly) continue;
    if (parsed.repairIssued !== true) continue;
    if (resolveAssemblyEngineId(parsed) !== args.engineId) continue;
    const nextMetaJson = JSON.stringify(
      applyWorkOrderWithdrawal(parsed, { at: ts, by: args.actor.username || 'backend', reason, auto: true }),
    );
    await db
      .update(operations)
      .set({ metaJson: nextMetaJson, updatedAt: ts, syncStatus: 'synced' })
      .where(and(eq(operations.id, r.id), isNull(operations.deletedAt)));
    const payload = operationPayload({
      id: String(r.id),
      engineEntityId: String(r.engineEntityId),
      operationType: String(r.operationType),
      status: String(r.status),
      note: r.note ?? null,
      performedAt: r.performedAt == null ? null : Number(r.performedAt),
      performedBy: r.performedBy == null ? null : String(r.performedBy),
      metaJson: nextMetaJson,
      createdAt: Number(r.createdAt),
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });
    await insertChangeLog(String(r.id), payload, args.actor, syncOptions);
  }
}

export async function saveRepairChecklistForEngine(args: {
  engineId: string;
  stage: string;
  operationId?: string | null;
  payload: RepairChecklistPayload;
  actor: Actor;
  allowSyncConflicts?: boolean;
}): Promise<{ ok: true; operationId: string } | { ok: false; error: string }> {
  try {
    const ts = nowMs();
    const metaJson = JSON.stringify(args.payload);

    const opId = args.operationId?.trim() ? args.operationId.trim() : null;
    if (opId) {
      await db
        .update(operations)
        .set({ metaJson, updatedAt: ts, syncStatus: 'synced' })
        .where(and(eq(operations.id, opId as any), isNull(operations.deletedAt)));
      const row = await db.select().from(operations).where(eq(operations.id, opId as any)).limit(1);
      if (!row[0]) return { ok: false as const, error: 'операция не найдена' };
      const payload = operationPayload({
        id: String(row[0].id),
        engineEntityId: String(row[0].engineEntityId),
        operationType: String(row[0].operationType),
        status: String(row[0].status),
        note: row[0].note ?? null,
        performedAt: row[0].performedAt == null ? null : Number(row[0].performedAt),
        performedBy: row[0].performedBy == null ? null : String(row[0].performedBy),
        metaJson: row[0].metaJson == null ? null : String(row[0].metaJson),
        createdAt: Number(row[0].createdAt),
        updatedAt: Number(row[0].updatedAt),
        deletedAt: row[0].deletedAt == null ? null : Number(row[0].deletedAt),
        syncStatus: 'synced',
      });
    const syncOptions = args.allowSyncConflicts ? { allowSyncConflicts: true } : {};
    await insertChangeLog(opId, payload, args.actor, syncOptions);
      if (args.stage === ENGINE_INVENTORY_STAGE) {
        try {
          await autoWithdrawIssuedAssemblyWorkOrders({
            engineId: args.engineId,
            checklistPayload: args.payload,
            actor: args.actor,
            ...(args.allowSyncConflicts ? { allowSyncConflicts: true } : {}),
          });
        } catch {
          // best-effort: не роняем сохранение чеклиста
        }
      }
      return { ok: true as const, operationId: opId };
    }

    const newId = randomUUID();
    const note =
      args.stage === 'defect'
        ? 'Лист дефектовки двигателя'
        : args.stage === 'completeness'
          ? 'Акт комплектности двигателя'
          : args.stage === ENGINE_INVENTORY_STAGE
            ? 'Список деталей двигателя'
            : `Чек-лист: ${args.stage}`;
    await db.insert(operations).values({
      id: newId,
      engineEntityId: args.engineId as any,
      operationType: args.stage,
      status: 'checklist',
      note,
      performedAt: ts,
      performedBy: args.actor?.username?.trim() ? args.actor.username.trim() : 'web-admin',
      metaJson,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });
    const payload = operationPayload({
      id: newId,
      engineEntityId: args.engineId,
      operationType: args.stage,
      status: 'checklist',
      note,
      performedAt: ts,
      performedBy: args.actor?.username?.trim() ? args.actor.username.trim() : 'web-admin',
      metaJson,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });
    const syncOptions = args.allowSyncConflicts ? { allowSyncConflicts: true } : {};
    await insertChangeLog(newId, payload, args.actor, syncOptions);
    await ensureOwner(SyncTableName.Operations, newId, args.actor);
    if (args.stage === ENGINE_INVENTORY_STAGE) {
      try {
        await autoWithdrawIssuedAssemblyWorkOrders({
            engineId: args.engineId,
            checklistPayload: args.payload,
            actor: args.actor,
            ...(args.allowSyncConflicts ? { allowSyncConflicts: true } : {}),
          });
      } catch {
        // best-effort: не роняем сохранение чеклиста
      }
    }
    return { ok: true as const, operationId: newId };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}
