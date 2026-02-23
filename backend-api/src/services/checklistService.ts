import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';

import type { RepairChecklistPayload, RepairChecklistTemplate } from '@matricarmz/shared';
import { SyncTableName } from '@matricarmz/shared';

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

function defaultRepairTemplate(): RepairChecklistTemplate {
  return {
    id: 'default',
    code: 'repair_checklist_default',
    name: 'Контрольный лист ремонта двигателя (MVP)',
    stage: 'repair',
    version: 1,
    active: true,
    items: [
      { id: 'delivery_date', label: 'Дата поставки двигателя', kind: 'date' },
      { id: 'engine_mark_number', label: 'Марка, № двигателя', kind: 'text', required: true },
      { id: 'accompanying_docs', label: 'Сопроводительные документы', kind: 'text' },
      { id: 'passport_details', label: 'Реквизиты паспорта двигателя', kind: 'text' },
      { id: 'completeness_ok', label: 'Отметка о комплектности (комплектный)', kind: 'boolean' },
      {
        id: 'missing_parts',
        label: 'Недостающие детали (агрегаты)',
        kind: 'table',
        columns: [
          { id: 'name', label: 'Наименование детали (агрегата)' },
          { id: 'number', label: '№ детали (агрегата)' },
        ],
      },
      { id: 'photo_done', label: 'Отметка о фотофиксации', kind: 'boolean' },
      { id: 'photo_location', label: 'Место хранения файла (фото)', kind: 'text' },
      { id: 'missing_req_sent_at', label: 'Заявка на недостающие детали передана в снабжение (дата)', kind: 'date' },
      { id: 'missing_bought_at', label: 'Недостающие детали приобретены (дата)', kind: 'date' },
      { id: 'missing_bought_basis', label: 'Недостающие детали приобретены (основание)', kind: 'text' },
      { id: 'disassembly_transfer_at', label: 'Дата передачи двигателя на разборку', kind: 'date' },
      { id: 'disassembly_act', label: 'Реквизиты акта приема двигателя в ремонт', kind: 'text' },
      { id: 'defect_act_date_number', label: 'Дата и № акта полной дефектовки двигателя', kind: 'text' },
      { id: 'spare_req_sent_at', label: 'Заявка З/П (детали) передана в снабжение (дата)', kind: 'date' },
      { id: 'spare_bought_at', label: 'З/П (детали) приобретены (дата)', kind: 'date' },
      { id: 'spare_bought_basis', label: 'З/П (детали) приобретены (основание)', kind: 'text' },
      { id: 'assembly_numbers_ok', label: 'Контроль номерного соответствия: соответствует', kind: 'boolean' },
      {
        id: 'mismatch_parts',
        label: 'Несоответствующие детали и их №',
        kind: 'table',
        columns: [
          { id: 'name', label: 'Наименование детали' },
          { id: 'number', label: '№ детали' },
        ],
      },
      { id: 'test_at', label: 'Дата прохождения испытаний двигателя', kind: 'date' },
      { id: 'research_act', label: 'Дата и № акта исследований', kind: 'text' },
      { id: 'research_act_original_received', label: 'Оригинал акта исследований получен', kind: 'boolean' },
      { id: 'otk_mark', label: 'Проверка комплектности двигателя (отметка мастера ОТК)', kind: 'text' },
      { id: 'packaging_at', label: 'Дата упаковки двигателя', kind: 'date' },
      { id: 'storage_location', label: 'Место хранения упакованного двигателя', kind: 'text' },
      { id: 'shipment_at', label: 'Дата отгрузки двигателя', kind: 'date' },
      { id: 'delivered', label: 'Отметка о доставке двигателя заказчику', kind: 'boolean' },
      { id: 'claims_present', label: 'Наличие претензий (да)', kind: 'boolean' },
      { id: 'claims_text', label: 'Содержание претензий (при наличии)', kind: 'text' },
      { id: 'compiled_by', label: 'Настоящий акт составлен (ФИО, должность, подпись)', kind: 'signature' },
    ],
  };
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

function defaultTemplates(): RepairChecklistTemplate[] {
  return [defaultRepairTemplate(), defaultCompletenessTemplate(), defaultDefectTemplate()];
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
        stage: String((a as any).stage ?? 'repair'),
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
      if (!row[0]) return { ok: false as const, error: 'operation not found' };
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
      return { ok: true as const, operationId: opId };
    }

    const newId = randomUUID();
    const note =
      args.stage === 'defect'
        ? 'Лист дефектовки двигателя'
        : args.stage === 'completeness'
          ? 'Акт комплектности двигателя'
        : args.stage === 'repair'
          ? 'Контрольный лист ремонта'
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
    return { ok: true as const, operationId: newId };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}
