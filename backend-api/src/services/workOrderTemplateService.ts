import { and, asc, eq, isNull } from 'drizzle-orm';

import {
  WorkOrderKind,
  WORK_ORDER_TEMPLATE_KINDS,
  WORK_ORDER_TEMPLATE_NAME_MAX,
  isHidableField,
  isValidWorkOrderTemplateName,
  isWorkOrderTemplateKind,
  type WorkOrderTemplateDto,
  type WorkOrderTemplateLine,
  type WorkOrderTemplatePayloadOverrides,
  type WorkOrderTemplateSummary,
} from '@matricarmz/shared';

import { db } from '../database/db.js';
import { workOrderTemplates } from '../database/schema.js';

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

export type { WorkOrderTemplateDto, WorkOrderTemplateLine, WorkOrderTemplateSummary };

function nowMs() {
  return Date.now();
}

function parseLines(raw: string | null | undefined): WorkOrderTemplateLine[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row): row is WorkOrderTemplateLine => !!row && typeof row === 'object');
  } catch {
    return [];
  }
}

function parseObject(raw: string | null | undefined): WorkOrderTemplatePayloadOverrides {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as WorkOrderTemplatePayloadOverrides;
  } catch {
    return {};
  }
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

function rowToDto(row: typeof workOrderTemplates.$inferSelect): WorkOrderTemplateDto {
  return {
    id: String(row.id),
    workOrderKind: String(row.workOrderKind) as WorkOrderKind,
    name: String(row.name),
    payloadOverrides: parseObject(row.payloadOverridesJson),
    hiddenFields: parseStringArray(row.hiddenFieldsJson),
    lines: parseLines(row.linesJson),
    updatedAt: Number(row.updatedAt),
    updatedBy: row.updatedBy ?? null,
  };
}

function normalizeKind(raw: unknown): Result<{ kind: WorkOrderKind }> {
  if (!isWorkOrderTemplateKind(raw)) {
    return {
      ok: false,
      error: `Недопустимый тип наряда. Допустимы: ${WORK_ORDER_TEMPLATE_KINDS.join(', ')}`,
    };
  }
  return { ok: true, kind: raw };
}

function normalizeName(raw: unknown): Result<{ name: string }> {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, error: 'Название шаблона обязательно' };
  if (!isValidWorkOrderTemplateName(value)) {
    return { ok: false, error: `Название шаблона не должно превышать ${WORK_ORDER_TEMPLATE_NAME_MAX} символов` };
  }
  return { ok: true, name: value };
}

function normalizeHiddenFields(
  raw: unknown,
  kind: WorkOrderKind,
): Result<{ hiddenFields: string[] }> {
  if (raw === undefined || raw === null) return { ok: true, hiddenFields: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'hiddenFields должно быть массивом строк' };
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== 'string') {
      return { ok: false, error: `hiddenFields[${i}]: ожидается строка` };
    }
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    if (!isHidableField(kind, trimmed)) {
      return {
        ok: false,
        error: `Поле «${trimmed}» нельзя скрыть для типа наряда ${kind} (обязательное поле)`,
      };
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return { ok: true, hiddenFields: out };
}

function normalizePayloadOverrides(raw: unknown): Result<{ payloadOverrides: WorkOrderTemplatePayloadOverrides }> {
  if (raw === undefined || raw === null) return { ok: true, payloadOverrides: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'payloadOverrides должно быть объектом' };
  }
  return { ok: true, payloadOverrides: raw as WorkOrderTemplatePayloadOverrides };
}

function normalizeLines(raw: unknown): Result<{ lines: WorkOrderTemplateLine[] }> {
  if (raw === undefined || raw === null) return { ok: true, lines: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'lines должно быть массивом' };
  const out: WorkOrderTemplateLine[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') {
      return { ok: false, error: `lines[${i}]: ожидается объект` };
    }
    const rec = item as Record<string, unknown>;
    const line: WorkOrderTemplateLine = {};
    if (typeof rec.nomenclatureId === 'string' && rec.nomenclatureId.trim()) {
      line.nomenclatureId = rec.nomenclatureId.trim();
    }
    if (typeof rec.serviceId === 'string' && rec.serviceId.trim()) {
      line.serviceId = rec.serviceId.trim();
    }
    if (typeof rec.serviceName === 'string' && rec.serviceName.trim()) {
      line.serviceName = rec.serviceName.trim();
    }
    if (typeof rec.unit === 'string' && rec.unit.trim()) {
      line.unit = rec.unit.trim();
    }
    if (rec.defaultQty !== undefined && rec.defaultQty !== null) {
      const qty = Number(rec.defaultQty);
      if (!Number.isFinite(qty) || qty < 0) {
        return { ok: false, error: `lines[${i}].defaultQty должно быть числом >= 0` };
      }
      if (qty > 0) line.defaultQty = qty;
    }
    if (typeof rec.productNumber === 'string' && rec.productNumber.trim()) {
      line.productNumber = rec.productNumber.trim();
    }
    if (typeof rec.engineId === 'string' && rec.engineId.trim()) {
      line.engineId = rec.engineId.trim();
    } else if (rec.engineId === null) {
      line.engineId = null;
    }
    if (typeof rec.engineNumber === 'string' && rec.engineNumber.trim()) {
      line.engineNumber = rec.engineNumber.trim();
    }
    if (typeof rec.engineBrandId === 'string' && rec.engineBrandId.trim()) {
      line.engineBrandId = rec.engineBrandId.trim();
    } else if (rec.engineBrandId === null) {
      line.engineBrandId = null;
    }
    if (typeof rec.engineBrandName === 'string' && rec.engineBrandName.trim()) {
      line.engineBrandName = rec.engineBrandName.trim();
    }
    // Шаблон без идентификаторов (ни номенклатуры, ни услуги) — бессмысленная строка.
    if (!line.nomenclatureId && !line.serviceId) {
      return {
        ok: false,
        error: `lines[${i}]: должна содержать хотя бы nomenclatureId или serviceId`,
      };
    }
    out.push(line);
  }
  return { ok: true, lines: out };
}

export async function listWorkOrderTemplates(
  filter: { kind?: unknown } = {},
): Promise<Result<{ templates: WorkOrderTemplateSummary[] }>> {
  try {
    const kindFilter = filter.kind === undefined ? undefined : filter.kind;
    let rows: Array<typeof workOrderTemplates.$inferSelect>;
    if (kindFilter !== undefined) {
      const kindResult = normalizeKind(kindFilter);
      if (!kindResult.ok) return kindResult;
      rows = await db
        .select()
        .from(workOrderTemplates)
        .where(and(eq(workOrderTemplates.workOrderKind, kindResult.kind), isNull(workOrderTemplates.archivedAt)))
        .orderBy(asc(workOrderTemplates.name));
    } else {
      rows = await db
        .select()
        .from(workOrderTemplates)
        .where(isNull(workOrderTemplates.archivedAt))
        .orderBy(asc(workOrderTemplates.workOrderKind), asc(workOrderTemplates.name));
    }
    const templates = rows.map((row): WorkOrderTemplateSummary => ({
      id: String(row.id),
      workOrderKind: String(row.workOrderKind) as WorkOrderKind,
      name: String(row.name),
      lineCount: parseLines(row.linesJson).length,
      updatedAt: Number(row.updatedAt),
    }));
    return { ok: true, templates };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getWorkOrderTemplateById(
  id: string,
): Promise<Result<{ template: WorkOrderTemplateDto }>> {
  try {
    const tid = String(id || '').trim();
    if (!tid) return { ok: false, error: 'id обязателен' };
    const rows = await db
      .select()
      .from(workOrderTemplates)
      .where(eq(workOrderTemplates.id, tid))
      .limit(1);
    const row = rows[0];
    if (!row) return { ok: false, error: 'Шаблон не найден' };
    return { ok: true, template: rowToDto(row) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function createWorkOrderTemplate(args: {
  workOrderKind: unknown;
  name: unknown;
  payloadOverrides?: unknown;
  hiddenFields?: unknown;
  lines?: unknown;
  actor?: string | null;
}): Promise<Result<{ template: WorkOrderTemplateDto }>> {
  try {
    const kindResult = normalizeKind(args.workOrderKind);
    if (!kindResult.ok) return kindResult;
    if (kindResult.kind === WorkOrderKind.Assembly) {
      return { ok: false, error: 'Сборочные шаблоны заменены вариантами BOM и больше не создаются' };
    }
    const nameResult = normalizeName(args.name);
    if (!nameResult.ok) return nameResult;
    const hiddenResult = normalizeHiddenFields(args.hiddenFields, kindResult.kind);
    if (!hiddenResult.ok) return hiddenResult;
    const overridesResult = normalizePayloadOverrides(args.payloadOverrides);
    if (!overridesResult.ok) return overridesResult;
    const linesResult = normalizeLines(args.lines);
    if (!linesResult.ok) return linesResult;

    const existing = await db
      .select({ id: workOrderTemplates.id })
      .from(workOrderTemplates)
      .where(
        and(
          eq(workOrderTemplates.workOrderKind, kindResult.kind),
          eq(workOrderTemplates.name, nameResult.name),
          isNull(workOrderTemplates.archivedAt),
        ),
      )
      .limit(1);
    if (existing[0]) {
      return { ok: false, error: `Шаблон «${nameResult.name}» для типа ${kindResult.kind} уже существует` };
    }

    const ts = nowMs();
    const actor = args.actor ? String(args.actor) : null;
    const inserted = await db
      .insert(workOrderTemplates)
      .values({
        workOrderKind: kindResult.kind,
        name: nameResult.name,
        payloadOverridesJson: JSON.stringify(overridesResult.payloadOverrides),
        hiddenFieldsJson: JSON.stringify(hiddenResult.hiddenFields),
        linesJson: JSON.stringify(linesResult.lines),
        updatedAt: ts,
        updatedBy: actor,
      })
      .returning();
    const row = inserted[0];
    if (!row) return { ok: false, error: 'Не удалось создать шаблон' };
    return { ok: true, template: rowToDto(row) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function updateWorkOrderTemplate(args: {
  id: string;
  name?: unknown;
  payloadOverrides?: unknown;
  hiddenFields?: unknown;
  lines?: unknown;
  actor?: string | null;
}): Promise<Result<{ template: WorkOrderTemplateDto }>> {
  try {
    const id = String(args.id || '').trim();
    if (!id) return { ok: false, error: 'id обязателен' };

    const currentRows = await db
      .select()
      .from(workOrderTemplates)
      .where(eq(workOrderTemplates.id, id))
      .limit(1);
    const current = currentRows[0];
    if (!current) return { ok: false, error: 'Шаблон не найден' };

    const kind = String(current.workOrderKind) as WorkOrderKind;
    if (kind === WorkOrderKind.Assembly) {
      return { ok: false, error: 'Сборочный шаблон архивирован: изменяйте состав и настройки в BOM' };
    }
    const patch: Record<string, unknown> = {};

    if (args.name !== undefined) {
      const nameResult = normalizeName(args.name);
      if (!nameResult.ok) return nameResult;
      if (nameResult.name !== current.name) {
        const dup = await db
          .select({ id: workOrderTemplates.id })
          .from(workOrderTemplates)
          .where(
            and(
              eq(workOrderTemplates.workOrderKind, kind),
              eq(workOrderTemplates.name, nameResult.name),
              isNull(workOrderTemplates.archivedAt),
            ),
          )
          .limit(1);
        if (dup[0]) {
          return { ok: false, error: `Шаблон «${nameResult.name}» для типа ${kind} уже существует` };
        }
      }
      patch.name = nameResult.name;
    }

    if (args.payloadOverrides !== undefined) {
      const result = normalizePayloadOverrides(args.payloadOverrides);
      if (!result.ok) return result;
      patch.payloadOverridesJson = JSON.stringify(result.payloadOverrides);
    }

    if (args.hiddenFields !== undefined) {
      const result = normalizeHiddenFields(args.hiddenFields, kind);
      if (!result.ok) return result;
      patch.hiddenFieldsJson = JSON.stringify(result.hiddenFields);
    }

    if (args.lines !== undefined) {
      const result = normalizeLines(args.lines);
      if (!result.ok) return result;
      patch.linesJson = JSON.stringify(result.lines);
    }

    if (Object.keys(patch).length === 0) {
      return { ok: true, template: rowToDto(current) };
    }

    const ts = nowMs();
    patch.updatedAt = ts;
    patch.updatedBy = args.actor ? String(args.actor) : null;

    const updated = await db
      .update(workOrderTemplates)
      .set(patch as Partial<typeof workOrderTemplates.$inferInsert>)
      .where(eq(workOrderTemplates.id, id))
      .returning();
    const row = updated[0];
    if (!row) return { ok: false, error: 'Шаблон не найден после обновления' };
    return { ok: true, template: rowToDto(row) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deleteWorkOrderTemplate(id: string): Promise<Result<{ deleted: true }>> {
  try {
    const tid = String(id || '').trim();
    if (!tid) return { ok: false, error: 'id обязателен' };
    const deleted = await db
      .delete(workOrderTemplates)
      .where(eq(workOrderTemplates.id, tid))
      .returning({ id: workOrderTemplates.id });
    if (deleted.length === 0) return { ok: false, error: 'Шаблон не найден' };
    return { ok: true, deleted: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
