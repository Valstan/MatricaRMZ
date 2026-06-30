import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import type { TimesheetCodeDef, TimesheetData, TimesheetHeader, TimesheetRowData, TimesheetStatus, WeekMode } from '@matricarmz/shared';
import { timesheetNormHours } from '@matricarmz/shared';
import { db } from '../database/db.js';
import {
  attributeDefs,
  attributeValues,
  directoryWorkshops,
  entities,
  entityTypes,
  timesheetCells,
  timesheetCodes,
  timesheetRows,
  timesheets,
} from '../database/schema.js';

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

const nowMs = () => Date.now();
const numOrNull = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));
const normLogin = (v: unknown): string => String(v ?? '').trim().toLowerCase();

// Право на редактирование табеля: автор-создатель редактирует всегда; другие — только
// при включённом allow_others_edit. Легаси-табели без автора (created_by IS NULL)
// остаются открытыми — как было до фичи прав (иначе их никто не смог бы править).
type TimesheetEditMeta = { createdBy: string | null; allowOthersEdit: boolean };

async function loadTimesheetEditMeta(timesheetId: string): Promise<TimesheetEditMeta | null> {
  const rows = await db
    .select({ createdBy: timesheets.createdBy, allowOthersEdit: timesheets.allowOthersEdit })
    .from(timesheets)
    .where(and(eq(timesheets.id, timesheetId), isNull(timesheets.deletedAt)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return { createdBy: r.createdBy ?? null, allowOthersEdit: Boolean(r.allowOthersEdit) };
}

export function actorIsAuthor(createdBy: string | null, actor?: string | null): boolean {
  return !!createdBy && normLogin(createdBy) === normLogin(actor);
}

export function canEditTimesheet(meta: TimesheetEditMeta, actor?: string | null): boolean {
  if (!meta.createdBy) return true; // legacy timesheet without an author → open
  return actorIsAuthor(meta.createdBy, actor) || meta.allowOthersEdit;
}

async function assertCanEditTimesheet(timesheetId: string, actor?: string | null): Promise<Err | null> {
  const meta = await loadTimesheetEditMeta(timesheetId);
  if (!meta) return { ok: false, error: 'Табель не найден' };
  if (!canEditTimesheet(meta, actor))
    return { ok: false, error: 'Редактировать этот табель может только его автор (включите «Разрешить редактирование другим пользователям»)' };
  return null;
}

async function timesheetIdForRow(rowId: string): Promise<string | null> {
  const rows = await db.select({ timesheetId: timesheetRows.timesheetId }).from(timesheetRows).where(eq(timesheetRows.id, rowId)).limit(1);
  return rows[0] ? String(rows[0].timesheetId) : null;
}

function parseTextAttr(json: string | null): string {
  if (!json) return '';
  try {
    const v = JSON.parse(json);
    return v == null ? '' : String(v);
  } catch {
    return String(json);
  }
}

async function resolveEmployeeNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .innerJoin(attributeDefs, eq(attributeDefs.id, attributeValues.attributeDefId))
    .where(and(eq(attributeDefs.code, 'full_name'), inArray(attributeValues.entityId, ids), isNull(attributeValues.deletedAt)))
    .limit(10_000);
  for (const r of rows) out.set(String(r.entityId), parseTextAttr(r.valueJson));
  return out;
}

// Department entities carry their display name in the EAV `name` attribute (unlike
// directory_workshops which has a native name column). Mirrors resolveEmployeeNames.
async function resolveDepartmentNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return out;
  const rows = await db
    .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .innerJoin(attributeDefs, eq(attributeDefs.id, attributeValues.attributeDefId))
    .where(and(eq(attributeDefs.code, 'name'), inArray(attributeValues.entityId, unique), isNull(attributeValues.deletedAt)))
    .limit(10_000);
  for (const r of rows) out.set(String(r.entityId), parseTextAttr(r.valueJson));
  return out;
}

export async function listTimesheetCodes(): Promise<Result<{ codes: TimesheetCodeDef[] }>> {
  try {
    const rows = await db.select().from(timesheetCodes).where(eq(timesheetCodes.isActive, true)).orderBy(asc(timesheetCodes.sort));
    return {
      ok: true,
      codes: rows.map((r) => ({
        code: r.code,
        numCode: r.numCode,
        title: r.title,
        countsAsWorked: r.countsAsWorked,
        defaultHours: numOrNull(r.defaultHours),
        color: r.color ?? null,
        sort: r.sort,
      })),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listTimesheets(args?: { workshopId?: string; departmentId?: string; year?: number; actor?: string | null }): Promise<Result<{ rows: TimesheetHeader[] }>> {
  try {
    const conds = [isNull(timesheets.deletedAt)];
    if (args?.workshopId) conds.push(eq(timesheets.workshopId, args.workshopId));
    if (args?.departmentId) conds.push(eq(timesheets.departmentId, args.departmentId));
    if (typeof args?.year === 'number') conds.push(eq(timesheets.year, args.year));
    // LEFT join workshops so department-scoped timesheets (workshop_id NULL) are not dropped.
    const rows = await db
      .select({
        id: timesheets.id,
        workshopId: timesheets.workshopId,
        workshopName: directoryWorkshops.name,
        departmentId: timesheets.departmentId,
        year: timesheets.year,
        month: timesheets.month,
        status: timesheets.status,
        weekMode: timesheets.weekMode,
        normHours: timesheets.normHours,
        createdBy: timesheets.createdBy,
        allowOthersEdit: timesheets.allowOthersEdit,
        updatedAt: timesheets.updatedAt,
      })
      .from(timesheets)
      .leftJoin(directoryWorkshops, eq(directoryWorkshops.id, timesheets.workshopId))
      .where(and(...conds))
      .orderBy(asc(timesheets.year), asc(timesheets.month))
      .limit(5_000);
    const deptNames = await resolveDepartmentNames(rows.map((r) => String(r.departmentId ?? '')));
    return {
      ok: true,
      rows: rows.map((r) => {
        const isDept = !!r.departmentId;
        const workshopName = String(r.workshopName ?? '');
        const departmentName = isDept ? (deptNames.get(String(r.departmentId)) ?? '') : null;
        return {
          id: String(r.id),
          workshopId: String(r.workshopId ?? ''),
          workshopName,
          departmentId: r.departmentId ? String(r.departmentId) : null,
          departmentName,
          scopeKind: isDept ? 'department' : 'workshop',
          scopeName: isDept ? (departmentName ?? '') : workshopName,
          year: Number(r.year),
          month: Number(r.month),
          status: r.status as TimesheetStatus,
          weekMode: (Number(r.weekMode) === 5 ? 5 : 6) as WeekMode,
          normHours: numOrNull(r.normHours),
          createdBy: r.createdBy ?? null,
          allowOthersEdit: Boolean(r.allowOthersEdit),
          isAuthor: actorIsAuthor(r.createdBy ?? null, args?.actor),
          updatedAt: Number(r.updatedAt),
        };
      }),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getTimesheet(id: string, actor?: string | null): Promise<Result<{ timesheet: TimesheetData }>> {
  try {
    const header = await db.select().from(timesheets).where(and(eq(timesheets.id, id), isNull(timesheets.deletedAt))).limit(1);
    const h = header[0];
    if (!h) return { ok: false, error: 'Табель не найден' };

    const rows = await db.select().from(timesheetRows).where(eq(timesheetRows.timesheetId, id)).orderBy(asc(timesheetRows.sort));
    const rowIds = rows.map((r) => String(r.id));
    const cells = rowIds.length
      ? await db.select().from(timesheetCells).where(inArray(timesheetCells.rowId, rowIds)).limit(50_000)
      : [];
    const names = await resolveEmployeeNames(rows.map((r) => String(r.employeeId)));

    const cellsByRow = new Map<string, { day: number; code: string | null; hours: number | null; comment: string | null }[]>();
    for (const c of cells) {
      const list = cellsByRow.get(String(c.rowId)) ?? [];
      list.push({ day: Number(c.day), code: c.code ?? null, hours: numOrNull(c.hours), comment: c.comment ?? null });
      cellsByRow.set(String(c.rowId), list);
    }

    const rowData: TimesheetRowData[] = rows.map((r) => ({
      id: String(r.id),
      employeeId: String(r.employeeId),
      fullName: names.get(String(r.employeeId)) ?? '',
      tabNumber: r.tabNumber ?? null,
      position: r.position ?? null,
      sort: Number(r.sort),
      cells: cellsByRow.get(String(r.id)) ?? [],
    }));

    return {
      ok: true,
      timesheet: {
        id: String(h.id),
        workshopId: String(h.workshopId ?? ''),
        departmentId: h.departmentId ? String(h.departmentId) : null,
        year: Number(h.year),
        month: Number(h.month),
        status: h.status as TimesheetStatus,
        weekMode: (Number(h.weekMode) === 5 ? 5 : 6) as WeekMode,
        normHours: numOrNull(h.normHours),
        createdBy: h.createdBy ?? null,
        allowOthersEdit: Boolean(h.allowOthersEdit),
        isAuthor: actorIsAuthor(h.createdBy ?? null, actor),
        rows: rowData,
      },
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Departments (подразделения) selectable as a timesheet scope — exposed under timesheet
// permissions (not employees.view) so a табельщик can pick ОПП without HR access.
export async function listTimesheetDepartments(): Promise<Result<{ rows: Array<{ id: string; name: string }> }>> {
  try {
    const type = await db.select({ id: entityTypes.id }).from(entityTypes).where(eq(entityTypes.code, 'department')).limit(1);
    const typeId = type[0]?.id;
    if (!typeId) return { ok: true, rows: [] };
    const rows = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.typeId, typeId), isNull(entities.deletedAt)))
      .limit(2_000);
    const ids = rows.map((r) => String(r.id));
    const names = await resolveDepartmentNames(ids);
    const out = ids
      .map((id) => ({ id, name: names.get(id) ?? '' }))
      .filter((d) => d.name)
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    return { ok: true, rows: out };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function createTimesheet(args: {
  workshopId?: string | null;
  departmentId?: string | null;
  year: number;
  month: number;
  weekMode?: WeekMode;
  shiftHours?: number;
  createdBy?: string | null;
}): Promise<Result<{ id: string }>> {
  try {
    // Scope = workshop XOR department: exactly one must be chosen.
    const workshopId = String(args.workshopId || '').trim() || null;
    const departmentId = String(args.departmentId || '').trim() || null;
    if (workshopId && departmentId) return { ok: false, error: 'Укажите либо цех, либо подразделение — не оба' };
    if (!workshopId && !departmentId) return { ok: false, error: 'Не выбран цех или подразделение' };
    const year = Math.trunc(Number(args.year));
    const month = Math.trunc(Number(args.month));
    if (!(year >= 2000 && year <= 2100)) return { ok: false, error: 'Некорректный год' };
    if (!(month >= 1 && month <= 12)) return { ok: false, error: 'Некорректный месяц' };

    // Validate the chosen scope exists (department is an EAV entity).
    if (departmentId) {
      const d = await db
        .select({ id: entities.id })
        .from(entities)
        .where(and(eq(entities.id, departmentId), isNull(entities.deletedAt)))
        .limit(1);
      if (!d[0]) return { ok: false, error: 'Подразделение не найдено' };
    }

    const scopeCond = workshopId ? eq(timesheets.workshopId, workshopId) : eq(timesheets.departmentId, departmentId!);
    const existing = await db
      .select({ id: timesheets.id })
      .from(timesheets)
      .where(and(scopeCond, eq(timesheets.year, year), eq(timesheets.month, month), isNull(timesheets.deletedAt)))
      .limit(1);
    if (existing[0]) {
      return { ok: false, error: workshopId ? 'Табель на этот цех и месяц уже существует' : 'Табель на это подразделение и месяц уже существует' };
    }

    const weekMode: WeekMode = args.weekMode === 5 ? 5 : 6;
    const shift = typeof args.shiftHours === 'number' && args.shiftHours > 0 ? args.shiftHours : 8;
    const norm = timesheetNormHours(year, month, weekMode, shift);
    const ts = nowMs();
    const id = randomUUID();
    await db.insert(timesheets).values({
      id,
      workshopId,
      departmentId,
      year,
      month,
      status: 'draft',
      weekMode,
      normHours: String(norm),
      createdBy: args.createdBy?.trim() ? args.createdBy.trim() : null,
      allowOthersEdit: false,
      createdAt: ts,
      updatedAt: ts,
    });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function updateTimesheet(args: {
  id: string;
  status?: TimesheetStatus;
  weekMode?: WeekMode;
  normHours?: number | null;
  allowOthersEdit?: boolean;
  actor?: string | null;
}): Promise<Result<{ id: string }>> {
  try {
    const id = String(args.id || '').trim();
    if (!id) return { ok: false, error: 'id обязателен' };
    const meta = await loadTimesheetEditMeta(id);
    if (!meta) return { ok: false, error: 'Табель не найден' };
    // Галку «разрешить другим» меняет ТОЛЬКО автор (на легаси-табелях без автора —
    // любой редактор, иначе её некому было бы включить).
    if (args.allowOthersEdit !== undefined && meta.createdBy && !actorIsAuthor(meta.createdBy, args.actor)) {
      return { ok: false, error: 'Менять разрешение на редактирование может только автор табеля' };
    }
    // Прочие правки заголовка (статус/режим/норма) — по обычному праву редактирования.
    if (!canEditTimesheet(meta, args.actor)) {
      return { ok: false, error: 'Редактировать этот табель может только его автор (включите «Разрешить редактирование другим пользователям»)' };
    }
    const set: Record<string, unknown> = { updatedAt: nowMs() };
    if (args.status === 'draft' || args.status === 'closed') set.status = args.status;
    if (args.weekMode === 5 || args.weekMode === 6) set.weekMode = args.weekMode;
    if (args.normHours !== undefined) set.normHours = args.normHours == null ? null : String(args.normHours);
    if (args.allowOthersEdit !== undefined) set.allowOthersEdit = Boolean(args.allowOthersEdit);
    await db.update(timesheets).set(set).where(and(eq(timesheets.id, id), isNull(timesheets.deletedAt)));
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deleteTimesheet(args: { id: string; actor?: string | null }): Promise<Result<{ id: string }>> {
  try {
    const id = String(args.id || '').trim();
    if (!id) return { ok: false, error: 'id обязателен' };
    const denied = await assertCanEditTimesheet(id, args.actor);
    if (denied) return denied;
    await db.update(timesheets).set({ deletedAt: nowMs(), updatedAt: nowMs() }).where(eq(timesheets.id, id));
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function addTimesheetRows(args: {
  timesheetId: string;
  employees: { employeeId: string; tabNumber?: string | null; position?: string | null }[];
  actor?: string | null;
}): Promise<Result<{ added: number }>> {
  try {
    const timesheetId = String(args.timesheetId || '').trim();
    if (!timesheetId) return { ok: false, error: 'timesheetId обязателен' };
    const denied = await assertCanEditTimesheet(timesheetId, args.actor);
    if (denied) return denied;
    const existing = await db.select({ employeeId: timesheetRows.employeeId, sort: timesheetRows.sort }).from(timesheetRows).where(eq(timesheetRows.timesheetId, timesheetId));
    const present = new Set(existing.map((r) => String(r.employeeId)));
    let sort = existing.reduce((m, r) => Math.max(m, Number(r.sort)), 0);
    let added = 0;
    for (const emp of args.employees) {
      const employeeId = String(emp.employeeId || '').trim();
      if (!employeeId || present.has(employeeId)) continue;
      present.add(employeeId);
      sort += 10;
      await db.insert(timesheetRows).values({
        id: randomUUID(),
        timesheetId,
        employeeId,
        tabNumber: emp.tabNumber ?? null,
        position: emp.position ?? null,
        sort,
      });
      added += 1;
    }
    if (added > 0) await db.update(timesheets).set({ updatedAt: nowMs() }).where(eq(timesheets.id, timesheetId));
    return { ok: true, added };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function removeTimesheetRow(args: { rowId: string; actor?: string | null }): Promise<Result<{ rowId: string }>> {
  try {
    const rowId = String(args.rowId || '').trim();
    if (!rowId) return { ok: false, error: 'rowId обязателен' };
    const tsId = await timesheetIdForRow(rowId);
    if (!tsId) return { ok: true, rowId }; // строки нет — нечего удалять (идемпотентно)
    const denied = await assertCanEditTimesheet(tsId, args.actor);
    if (denied) return denied;
    await db.delete(timesheetRows).where(eq(timesheetRows.id, rowId));
    return { ok: true, rowId };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Пакетная запись ячеек строки. Пустая ячейка (code=null & hours=null & comment пуст) удаляется. */
export async function setTimesheetCells(args: {
  rowId: string;
  cells: { day: number; code?: string | null; hours?: number | null; comment?: string | null }[];
  actor?: string | null;
}): Promise<Result<{ written: number }>> {
  try {
    const rowId = String(args.rowId || '').trim();
    if (!rowId) return { ok: false, error: 'rowId обязателен' };
    const tsId = await timesheetIdForRow(rowId);
    if (!tsId) return { ok: false, error: 'Строка табеля не найдена' };
    const denied = await assertCanEditTimesheet(tsId, args.actor);
    if (denied) return denied;
    let written = 0;
    for (const c of args.cells) {
      const day = Math.trunc(Number(c.day));
      if (!(day >= 1 && day <= 31)) continue;
      const code = c.code == null || c.code === '' ? null : String(c.code);
      const hours = c.hours == null || (c.hours as unknown) === '' ? null : Number(c.hours);
      const comment = c.comment == null || String(c.comment).trim() === '' ? null : String(c.comment).trim();
      if (hours != null && (!Number.isFinite(hours) || hours < 0 || hours > 24)) return { ok: false, error: `Часы должны быть в диапазоне 0..24 (день ${day})` };
      if (code == null && hours == null && comment == null) {
        await db.delete(timesheetCells).where(and(eq(timesheetCells.rowId, rowId), eq(timesheetCells.day, day)));
        written += 1;
        continue;
      }
      await db
        .insert(timesheetCells)
        .values({ id: randomUUID(), rowId, day, code, hours: hours == null ? null : String(hours), comment })
        .onConflictDoUpdate({ target: [timesheetCells.rowId, timesheetCells.day], set: { code, hours: hours == null ? null : String(hours), comment } });
      written += 1;
    }
    return { ok: true, written };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
