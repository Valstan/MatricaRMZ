import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  actOperationType,
  applyWorkOrderWithdrawal,
  buildAutoWithdrawReason,
  computeInventoryShortage,
  engineActSnapshotSignature,
  ENGINE_INVENTORY_STAGE,
  listScrapPartNames,
  resolveAssemblyEngineId,
  WorkOrderKind,
  type WorkOrderPayload,
  type EngineActSnapshotPayload,
  type EngineActType,
  type EngineActVersionRecord,
  type EngineInventoryRow,
  parseRepairFundRequirementPayload,
  REPAIR_FUND_REQUIREMENT_TYPE,
  repairFundRequirementSignature,
  type RepairChecklistAnswers,
  type RepairChecklistPayload,
  type RepairChecklistTemplate,
  type RepairFundInstancePayload,
  type RepairFundRequirementSnapshotPayload,
  type RepairFundRequirementVersionRecord,
} from '@matricarmz/shared';
import { operations } from '../database/schema.js';
import { getEntityDetails, listEntitiesByType } from './entityService.js';
import { listEntityTypes } from './adminService.js';

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

function defaultEngineInventoryTemplate(): RepairChecklistTemplate {
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
          // Т6: номер, набитый на самой детали (узнаётся при осмотре; в чистом акте пуст).
          { id: 'stamped_number', label: '№ на детали' },
          // Т5: per-engine галочки актов (override поверх шаблона марки).
          { id: 'in_completeness_act', label: 'В акт комплектности', kind: 'boolean' },
          { id: 'in_defect_act', label: 'В акт дефектовки', kind: 'boolean' },
          { id: 'quantity', label: 'План', kind: 'number' },
          { id: 'present', label: 'На месте при приёмке', kind: 'boolean' },
          { id: 'actual_qty', label: 'Фактически принято', kind: 'number' },
          { id: 'repairable_qty', label: 'Ремонтопригодная', kind: 'number' },
          { id: 'scrap_qty', label: 'В утиль', kind: 'number' },
          { id: 'replace_qty', label: 'Заменить новой', kind: 'number' },
        ],
      },
      // Т6: дата осмотра — печатается внизу акта комплектности.
      { id: 'completeness_inspection_date', label: 'Дата осмотра (акт комплектности)', kind: 'date' },
      // Т6: комиссия акта комплектности — ФИО идут и в шапку («Комиссия в составе…»),
      // и в подписи внизу печатной формы.
      { id: 'commission_workshop_head', label: 'Комиссия: начальник цеха', kind: 'signature' },
      { id: 'commission_workshop_master', label: 'Комиссия: мастер цеха', kind: 'signature' },
      { id: 'commission_otk_head', label: 'Комиссия: начальник ОТК', kind: 'signature' },
      { id: 'acceptance_signed_by', label: 'Приёмку провёл (ФИО, должность, подпись)', kind: 'signature' },
      // Опциональная подпись представителя заказчика на акте комплектности (решение владельца
      // 2026-07-09): иногда приёмка идёт с представителем; обычно строка остаётся пустой.
      { id: 'customer_representative', label: 'Представитель заказчика (ФИО, должность, подпись)', kind: 'signature' },
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

export async function listRepairChecklistTemplates(db: BetterSQLite3Database, stage?: string) {
  try {
    const types = await listEntityTypes(db);
    const type = types.find((t) => String((t as any).code) === 'repair_checklist_template') ?? null;
    if (!type) {
      return { ok: true as const, templates: filterByStage(defaultTemplates(), stage) };
    }

    const items = await listEntitiesByType(db, String((type as any).id));
    const out: RepairChecklistTemplate[] = [];
    for (const it of items) {
      const d = await getEntityDetails(db, it.id);
      const a = d.attributes ?? {};
      const itemsVal = (a as any).itemsJson ?? (a as any).items ?? null;
      const itemsParsed =
        Array.isArray(itemsVal) ? itemsVal : typeof itemsVal === 'string' ? safeJsonParse(itemsVal) : itemsVal;
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
  db: BetterSQLite3Database,
  engineId: string,
  stage: string,
): Promise<{ ok: true; operationId: string | null; payload: RepairChecklistPayload | null } | { ok: false; error: string }> {
  try {
    const rows = await db
      .select()
      .from(operations)
      .where(and(eq(operations.engineEntityId, engineId), eq(operations.operationType, stage), isNull(operations.deletedAt)))
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
 * Связка «утиль ⇄ наряд на сборку»: после сохранения дефектовки с утильными строками
 * автоматически отзывает из работы выданные Assembly-наряды этого двигателя
 * (repairIssued → withdrawn с авто-причиной). Идемпотентен: не-выданные наряды пропускает.
 * Ошибка хука не роняет сохранение чеклиста (best-effort, backend-хук продублирует).
 */
async function autoWithdrawIssuedAssemblyWorkOrders(
  db: BetterSQLite3Database,
  args: { engineId: string; checklistPayload: RepairChecklistPayload; actor: string },
): Promise<void> {
  const scrapParts = listScrapPartNames(args.checklistPayload);
  if (scrapParts.length === 0) return;
  // Без фильтра по engine_entity_id: у старых Assembly-нарядов колонка может быть пустой,
  // двигатель резолвится из payload (resolveAssemblyEngineId) ниже.
  const rows = await db
    .select({ id: operations.id, status: operations.status, metaJson: operations.metaJson })
    .from(operations)
    .where(and(eq(operations.operationType, 'work_order'), isNull(operations.deletedAt)));
  const ts = nowMs();
  const reason = buildAutoWithdrawReason(scrapParts);
  for (const r of rows) {
    if (String(r.status) === 'closed') continue;
    const parsed = safeJsonParse(String(r.metaJson ?? '')) as WorkOrderPayload | null;
    if (!parsed || typeof parsed !== 'object' || parsed.kind !== 'work_order') continue;
    if (parsed.workOrderKind !== WorkOrderKind.Assembly) continue;
    if (parsed.repairIssued !== true) continue;
    if (resolveAssemblyEngineId(parsed) !== args.engineId) continue;
    const next = applyWorkOrderWithdrawal(parsed, { at: ts, by: args.actor, reason, auto: true });
    await db
      .update(operations)
      .set({ metaJson: JSON.stringify(next), updatedAt: ts, syncStatus: 'pending' })
      .where(and(eq(operations.id, r.id), isNull(operations.deletedAt)));
  }
}

export async function saveRepairChecklistForEngine(
  db: BetterSQLite3Database,
  args: { engineId: string; stage: string; operationId?: string | null; payload: RepairChecklistPayload; actor: string },
): Promise<{ ok: true; operationId: string } | { ok: false; error: string }> {
  try {
    const ts = nowMs();
    const metaJson = JSON.stringify(args.payload);

    const opId = args.operationId?.trim() ? args.operationId.trim() : null;
    if (opId) {
      await db
        .update(operations)
        .set({ metaJson, updatedAt: ts, syncStatus: 'pending' })
        .where(and(eq(operations.id, opId), isNull(operations.deletedAt)));
      if (args.stage === ENGINE_INVENTORY_STAGE) {
        try {
          await autoWithdrawIssuedAssemblyWorkOrders(db, { engineId: args.engineId, checklistPayload: args.payload, actor: args.actor });
        } catch {
          // best-effort: backend-хук продублирует после sync
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
      engineEntityId: args.engineId,
      operationType: args.stage,
      status: 'checklist',
      note,
      performedAt: ts,
      performedBy: args.actor?.trim() ? args.actor.trim() : 'local',
      metaJson,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });
    if (args.stage === ENGINE_INVENTORY_STAGE) {
      try {
        await autoWithdrawIssuedAssemblyWorkOrders(db, { engineId: args.engineId, checklistPayload: args.payload, actor: args.actor });
      } catch {
        // best-effort: backend-хук продублирует после sync
      }
    }
    return { ok: true as const, operationId: newId };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

/* -------------------------------------------------------------------------- *
 * Engine-acts Фаза 2 — версионируемые снимки актов (печать = новая версия).
 * Хранятся как отдельные строки operations (operationType = completeness_act /
 * defect_act), payload плоско в meta_json. Новые типы синкаются дженериком.
 * -------------------------------------------------------------------------- */

async function readEngineActVersions(
  db: BetterSQLite3Database,
  engineId: string,
  actType: EngineActType,
): Promise<EngineActVersionRecord[]> {
  const opType = actOperationType(actType);
  const rows = await db
    .select()
    .from(operations)
    .where(and(eq(operations.engineEntityId, engineId), eq(operations.operationType, opType), isNull(operations.deletedAt)))
    .orderBy(desc(operations.performedAt))
    .limit(500);
  const out: EngineActVersionRecord[] = [];
  for (const r of rows as any[]) {
    const raw = r.metaJson ? String(r.metaJson) : '';
    if (!raw) continue;
    const parsed = safeJsonParse(raw) as any;
    if (parsed && typeof parsed === 'object' && parsed.kind === 'engine_act_snapshot') {
      out.push({ ...(parsed as EngineActSnapshotPayload), operationId: String(r.id) });
    }
  }
  return out;
}

export async function listEngineActVersions(
  db: BetterSQLite3Database,
  engineId: string,
  actType: EngineActType,
): Promise<{ ok: true; versions: EngineActVersionRecord[] } | { ok: false; error: string }> {
  try {
    return { ok: true as const, versions: await readEngineActVersions(db, engineId, actType) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function saveEngineActSnapshot(
  db: BetterSQLite3Database,
  args: {
    engineId: string;
    actType: EngineActType;
    rows: EngineInventoryRow[];
    header: { engineBrand: string; engineNumber: string; contractNumber: string };
    answers: RepairChecklistAnswers;
    selectedCount: number;
    actor: string;
  },
): Promise<{ ok: true; operationId: string; version: number; deduped: boolean } | { ok: false; error: string }> {
  try {
    const existing = await readEngineActVersions(db, args.engineId, args.actType);
    const latest = existing[0] ?? null; // newest first
    const maxVersion = existing.reduce((m, v) => Math.max(m, Number(v.version) || 0), 0);

    const signature = engineActSnapshotSignature({ actType: args.actType, rows: args.rows, answers: args.answers });
    if (latest) {
      const latestSig = engineActSnapshotSignature({ actType: args.actType, rows: latest.rows, answers: latest.answers });
      if (latestSig === signature) {
        return { ok: true as const, operationId: latest.operationId, version: latest.version, deduped: true };
      }
    }

    const ts = nowMs();
    const version = maxVersion + 1;
    const payload: EngineActSnapshotPayload = {
      kind: 'engine_act_snapshot',
      actType: args.actType,
      engineEntityId: args.engineId,
      version,
      rows: args.rows,
      header: args.header,
      answers: args.answers,
      // Недостача — часть комплектности и претензии (секция «некомплект»); дефектовке не нужна.
      shortage: args.actType === 'defect' ? null : computeInventoryShortage(args.rows),
      selectedCount: args.selectedCount,
      printedBy: args.actor?.trim() ? args.actor.trim() : null,
      printedAt: ts,
    };
    const newId = randomUUID();
    const note =
      args.actType === 'claim'
        ? `Акт претензии заказчику (версия ${version})`
        : `${args.actType === 'defect' ? 'Акт дефектовки' : 'Акт комплектности'} двигателя (версия ${version})`;
    await db.insert(operations).values({
      id: newId,
      engineEntityId: args.engineId,
      operationType: actOperationType(args.actType),
      status: 'act',
      note,
      performedAt: ts,
      performedBy: payload.printedBy ?? 'local',
      metaJson: JSON.stringify(payload),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });
    return { ok: true as const, operationId: newId, version, deduped: false };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

/* -------------------------------------------------------------------------- *
 * Ремфонд Ф4 — версионируемые снимки «требования к заказчику» (печать = новая
 * версия). Строки operations (operationType=repair_fund_requirement), payload
 * плоско в meta_json. Образец — снимки актов выше.
 * -------------------------------------------------------------------------- */

async function readRequirementVersions(
  db: BetterSQLite3Database,
  engineId: string,
): Promise<RepairFundRequirementVersionRecord[]> {
  const rows = await db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.engineEntityId, engineId),
        eq(operations.operationType, REPAIR_FUND_REQUIREMENT_TYPE),
        isNull(operations.deletedAt),
      ),
    )
    .orderBy(desc(operations.performedAt))
    .limit(500);
  const out: RepairFundRequirementVersionRecord[] = [];
  for (const r of rows as any[]) {
    const parsed = parseRepairFundRequirementPayload(r.metaJson ? String(r.metaJson) : null);
    if (parsed) out.push({ ...parsed, operationId: String(r.id) });
  }
  return out;
}

export async function listRepairFundRequirementVersions(
  db: BetterSQLite3Database,
  engineId: string,
): Promise<{ ok: true; versions: RepairFundRequirementVersionRecord[] } | { ok: false; error: string }> {
  try {
    return { ok: true as const, versions: await readRequirementVersions(db, engineId) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function saveRepairFundRequirementSnapshot(
  db: BetterSQLite3Database,
  args: {
    engineId: string;
    instances: RepairFundInstancePayload[];
    header: { engineBrand: string; engineNumber: string; contractNumber: string };
    actor: string;
  },
): Promise<{ ok: true; operationId: string; version: number; deduped: boolean } | { ok: false; error: string }> {
  try {
    const existing = await readRequirementVersions(db, args.engineId);
    const latest = existing[0] ?? null;
    const maxVersion = existing.reduce((m, v) => Math.max(m, Number(v.version) || 0), 0);

    const signature = repairFundRequirementSignature({ instances: args.instances });
    if (latest && repairFundRequirementSignature({ instances: latest.instances }) === signature) {
      return { ok: true as const, operationId: latest.operationId, version: latest.version, deduped: true };
    }

    const ts = nowMs();
    const version = maxVersion + 1;
    const printedBy = args.actor?.trim() ? args.actor.trim() : null;
    const payload: RepairFundRequirementSnapshotPayload = {
      kind: 'repair_fund_requirement_snapshot',
      engineEntityId: args.engineId,
      version,
      instances: args.instances,
      header: args.header,
      printedBy,
      printedAt: ts,
    };
    const newId = randomUUID();
    await db.insert(operations).values({
      id: newId,
      engineEntityId: args.engineId,
      operationType: REPAIR_FUND_REQUIREMENT_TYPE,
      status: 'act',
      note: `Требование к заказчику (версия ${version})`,
      performedAt: ts,
      performedBy: printedBy ?? 'local',
      metaJson: JSON.stringify(payload),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });
    return { ok: true as const, operationId: newId, version, deduped: false };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}


