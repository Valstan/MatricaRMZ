import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { ToolDetails, ToolListItem, ToolMovementItem, ToolPropertyListItem } from '@matricarmz/shared';
import { createEntity, getEntityDetails, setEntityAttribute, softDeleteEntity } from './entityService.js';
import { BrowserWindow } from 'electron';
import { attributeDefs, attributeValues, entities, entityTypes, operations } from '../database/schema.js';

const TOOL_TYPE_CODE = 'tool';
const TOOL_PROPERTY_TYPE_CODE = 'tool_property';
const TOOL_MOVEMENT_TYPE = 'tool_movement';

function nowMs() {
  return Date.now();
}

function safeJsonParse(value: string | null): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function escapeHtml(s: string) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function renderHtmlWindow(html: string) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      offscreen: true,
    },
  });
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  await win.loadURL(url);
  return win;
}

function normalizeRole(role: string | null | undefined) {
  return String(role ?? '').trim().toLowerCase();
}

function canViewAllDepartments(role: string) {
  const r = normalizeRole(role);
  return r === 'admin' || r === 'superadmin';
}

function canEditAllDepartments(role: string) {
  return normalizeRole(role) === 'superadmin';
}

async function getEntityTypeIdByCode(db: BetterSQLite3Database, code: string): Promise<string | null> {
  const rows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, code), isNull(entityTypes.deletedAt)))
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

async function getAttributeDefIdByCode(db: BetterSQLite3Database, entityTypeId: string, code: string): Promise<string | null> {
  const rows = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, entityTypeId), eq(attributeDefs.code, code), isNull(attributeDefs.deletedAt)))
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

async function getUserDepartmentId(db: BetterSQLite3Database, userId: string): Promise<string | null> {
  const employeeTypeId = await getEntityTypeIdByCode(db, 'employee');
  if (!employeeTypeId) return null;
  const defId = await getAttributeDefIdByCode(db, employeeTypeId, 'department_id');
  if (!defId) return null;
  const rows = await db
    .select({ valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, userId), eq(attributeValues.attributeDefId, defId), isNull(attributeValues.deletedAt)))
    .limit(1);
  const raw = rows[0]?.valueJson ? String(rows[0].valueJson) : '';
  if (!raw) return null;
  const parsed = safeJsonParse(raw);
  return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : null;
}

async function getDepartmentNamesById(db: BetterSQLite3Database, ids: string[]): Promise<Record<string, string>> {
  const unique = Array.from(new Set(ids.map((id) => String(id)).filter(Boolean)));
  if (unique.length === 0) return {};
  const departmentTypeId = await getEntityTypeIdByCode(db, 'department');
  if (!departmentTypeId) return {};
  const nameDefId = await getAttributeDefIdByCode(db, departmentTypeId, 'name');
  if (!nameDefId) return {};
  const rows = await db
    .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(inArray(attributeValues.entityId, unique), eq(attributeValues.attributeDefId, nameDefId), isNull(attributeValues.deletedAt)))
    .limit(20_000);
  return rows.reduce<Record<string, string>>((acc, r) => {
    const val = r.valueJson ? safeJsonParse(String(r.valueJson)) : null;
    if (val != null && val !== '') acc[String(r.entityId)] = String(val);
    return acc;
  }, {});
}

async function getEmployeeNamesById(db: BetterSQLite3Database, ids: string[]): Promise<Record<string, string>> {
  const unique = Array.from(new Set(ids.map((id) => String(id)).filter(Boolean)));
  if (unique.length === 0) return {};
  const employeeTypeId = await getEntityTypeIdByCode(db, 'employee');
  if (!employeeTypeId) return {};
  const nameDefId =
    (await getAttributeDefIdByCode(db, employeeTypeId, 'full_name')) ??
    (await getAttributeDefIdByCode(db, employeeTypeId, 'name'));
  if (!nameDefId) return {};
  const rows = await db
    .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(inArray(attributeValues.entityId, unique), eq(attributeValues.attributeDefId, nameDefId), isNull(attributeValues.deletedAt)))
    .limit(20_000);
  return rows.reduce<Record<string, string>>((acc, r) => {
    const val = r.valueJson ? safeJsonParse(String(r.valueJson)) : null;
    if (val != null && val !== '') acc[String(r.entityId)] = String(val);
    return acc;
  }, {});
}

async function getToolTypeId(db: BetterSQLite3Database) {
  return getEntityTypeIdByCode(db, TOOL_TYPE_CODE);
}

async function getToolPropertyTypeId(db: BetterSQLite3Database) {
  return getEntityTypeIdByCode(db, TOOL_PROPERTY_TYPE_CODE);
}

async function ensureToolAccess(
  db: BetterSQLite3Database,
  toolId: string,
  scope?: { userId: string; role: string },
  mode: 'view' | 'edit' = 'view',
): Promise<{ ok: true; departmentId: string | null } | { ok: false; error: string }> {
  if (!scope?.userId) return { ok: false, error: 'missing user session' };
  const toolTypeId = await getToolTypeId(db);
  if (!toolTypeId) return { ok: false, error: 'tool type not found' };
  const rows = await db
    .select({ id: entities.id, typeId: entities.typeId })
    .from(entities)
    .where(and(eq(entities.id, toolId), eq(entities.typeId, toolTypeId), isNull(entities.deletedAt)))
    .limit(1);
  if (!rows[0]) return { ok: false, error: 'tool not found' };

  const viewAll = canViewAllDepartments(scope.role);
  const editAll = canEditAllDepartments(scope.role);
  if ((mode === 'view' && viewAll) || (mode === 'edit' && editAll)) return { ok: true, departmentId: null };

  const toolDepartmentDefId = await getAttributeDefIdByCode(db, toolTypeId, 'department_id');
  if (!toolDepartmentDefId) return { ok: false, error: 'tool.department_id missing' };
  const toolDeptRow = await db
    .select({ valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, toolId), eq(attributeValues.attributeDefId, toolDepartmentDefId), isNull(attributeValues.deletedAt)))
    .limit(1);
  const toolDeptRaw = toolDeptRow[0]?.valueJson ? String(toolDeptRow[0].valueJson) : '';
  const parsedDept = safeJsonParse(toolDeptRaw);
  const toolDept = typeof parsedDept === 'string' ? parsedDept : toolDeptRaw;
  const userDept = await getUserDepartmentId(db, scope.userId).catch(() => null);
  if (!userDept || !toolDept || String(toolDept) !== userDept) {
    return { ok: false, error: `permission denied: tools.${mode}` };
  }
  return { ok: true, departmentId: userDept };
}

export async function listTools(
  db: BetterSQLite3Database,
  args?: { q?: string },
  scope?: { userId: string; role: string },
): Promise<{ ok: true; tools: ToolListItem[] } | { ok: false; error: string }> {
  try {
    const toolTypeId = await getToolTypeId(db);
    if (!toolTypeId) return { ok: true as const, tools: [] };

    const rows = await db
      .select()
      .from(entities)
      .where(and(eq(entities.typeId, toolTypeId), isNull(entities.deletedAt)))
      .orderBy(desc(entities.updatedAt))
      .limit(5000);

    const defIds = {
      toolNumber: await getAttributeDefIdByCode(db, toolTypeId, 'tool_number'),
      name: await getAttributeDefIdByCode(db, toolTypeId, 'name'),
      serial: await getAttributeDefIdByCode(db, toolTypeId, 'serial_number'),
      department: await getAttributeDefIdByCode(db, toolTypeId, 'department_id'),
      receivedAt: await getAttributeDefIdByCode(db, toolTypeId, 'received_at'),
      retiredAt: await getAttributeDefIdByCode(db, toolTypeId, 'retired_at'),
    };
    const defIdList = Object.values(defIds).filter(Boolean) as string[];

    const ids = rows.map((r) => String(r.id));
    const values =
      ids.length && defIdList.length
        ? await db
            .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
            .from(attributeValues)
            .where(and(inArray(attributeValues.entityId, ids), inArray(attributeValues.attributeDefId, defIdList), isNull(attributeValues.deletedAt)))
            .limit(200_000)
        : [];

    const byEntity: Record<string, Record<string, unknown>> = {};
    for (const v of values as any[]) {
      const entityId = String(v.entityId);
      const defId = String(v.attributeDefId);
      if (!byEntity[entityId]) byEntity[entityId] = {};
      byEntity[entityId][defId] = safeJsonParse(v.valueJson ? String(v.valueJson) : null);
    }

    const viewAll = scope?.role ? canViewAllDepartments(scope.role) : false;
    const userDept = !viewAll && scope?.userId ? await getUserDepartmentId(db, scope.userId).catch(() => null) : null;

    const out: ToolListItem[] = [];
    for (const row of rows as any[]) {
      const entityId = String(row.id);
      const rec = byEntity[entityId] ?? {};
      const toolNumber = defIds.toolNumber ? rec[defIds.toolNumber] : null;
      const name = defIds.name ? rec[defIds.name] : null;
      const serial = defIds.serial ? rec[defIds.serial] : null;
      const departmentId = defIds.department ? rec[defIds.department] : null;
      const receivedAt = defIds.receivedAt ? rec[defIds.receivedAt] : null;
      const retiredAt = defIds.retiredAt ? rec[defIds.retiredAt] : null;

      if (!viewAll) {
        if (!userDept || !departmentId || String(departmentId) !== userDept) continue;
      }

      out.push({
        id: entityId,
        toolNumber: toolNumber ? String(toolNumber) : undefined,
        name: name ? String(name) : undefined,
        serialNumber: serial ? String(serial) : undefined,
        departmentId: departmentId ? String(departmentId) : null,
        receivedAt: typeof receivedAt === 'number' ? receivedAt : receivedAt ? Number(receivedAt) : null,
        retiredAt: typeof retiredAt === 'number' ? retiredAt : retiredAt ? Number(retiredAt) : null,
        updatedAt: Number(row.updatedAt ?? 0),
        createdAt: Number(row.createdAt ?? 0),
      });
    }

    if (args?.q) {
      const q = String(args.q).toLowerCase();
      const filtered = out.filter((t) => {
        const hay = `${t.toolNumber ?? ''} ${t.name ?? ''} ${t.serialNumber ?? ''}`.toLowerCase();
        return hay.includes(q);
      });
      out.length = 0;
      out.push(...filtered);
    }

    const departmentNames = await getDepartmentNamesById(
      db,
      out.map((r) => String(r.departmentId ?? '')).filter(Boolean),
    );
    for (const row of out) {
      row.departmentName = row.departmentId ? departmentNames[row.departmentId] ?? null : null;
    }

    return { ok: true as const, tools: out };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function getTool(
  db: BetterSQLite3Database,
  toolId: string,
  scope?: { userId: string; role: string },
): Promise<{ ok: true; tool: ToolDetails } | { ok: false; error: string }> {
  const access = await ensureToolAccess(db, toolId, scope, 'view');
  if (!access.ok) return access;
  const details = await getEntityDetails(db, toolId);
  return { ok: true as const, tool: details };
}

export async function createTool(
  db: BetterSQLite3Database,
  actor: string,
  scope?: { userId: string; role: string },
): Promise<{ ok: true; tool: ToolDetails } | { ok: false; error: string }> {
  try {
    const toolTypeId = await getToolTypeId(db);
    if (!toolTypeId) return { ok: false as const, error: 'tool type not found' };
    const userDept = scope?.userId ? await getUserDepartmentId(db, scope.userId).catch(() => null) : null;
    if (!canEditAllDepartments(scope?.role ?? '') && !userDept) {
      return { ok: false as const, error: 'Не задано подразделение в профиле пользователя' };
    }
    const created = await createEntity(db, toolTypeId);
    if (!created.ok) return created as any;
    if (!canEditAllDepartments(scope?.role ?? '') && userDept) {
      await setEntityAttribute(db, created.id, 'department_id', userDept);
    }
    await setEntityAttribute(db, created.id, 'description', '');
    const tool = await getEntityDetails(db, created.id);
    return { ok: true as const, tool };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function setToolAttribute(
  db: BetterSQLite3Database,
  args: { toolId: string; code: string; value: unknown; scope?: { userId: string; role: string } },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const access = await ensureToolAccess(db, args.toolId, args.scope, 'edit');
  if (!access.ok) return access;

  if (!canEditAllDepartments(args.scope?.role ?? '') && args.code === 'department_id') {
    const userDept = args.scope?.userId ? await getUserDepartmentId(db, args.scope.userId).catch(() => null) : null;
    if (!userDept || String(args.value ?? '') !== userDept) {
      return { ok: false as const, error: 'permission denied: tools.edit' };
    }
  }

  return setEntityAttribute(db, args.toolId, args.code, args.value) as any;
}

export async function deleteTool(
  db: BetterSQLite3Database,
  args: { toolId: string; scope?: { userId: string; role: string } },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const access = await ensureToolAccess(db, args.toolId, args.scope, 'edit');
  if (!access.ok) return access;
  return softDeleteEntity(db, args.toolId) as any;
}

export async function listToolProperties(db: BetterSQLite3Database): Promise<{ ok: true; items: ToolPropertyListItem[] } | { ok: false; error: string }> {
  try {
    const typeId = await getToolPropertyTypeId(db);
    if (!typeId) return { ok: true as const, items: [] };
    const rows = await db
      .select()
      .from(entities)
      .where(and(eq(entities.typeId, typeId), isNull(entities.deletedAt)))
      .orderBy(desc(entities.updatedAt))
      .limit(5000);
    const nameDefId = await getAttributeDefIdByCode(db, typeId, 'name');
    const paramsDefId = await getAttributeDefIdByCode(db, typeId, 'params');
    const defIds = [nameDefId, paramsDefId].filter(Boolean) as string[];
    const ids = rows.map((r) => String(r.id));
    const vals =
      ids.length && defIds.length
        ? await db
            .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
            .from(attributeValues)
            .where(and(inArray(attributeValues.entityId, ids), inArray(attributeValues.attributeDefId, defIds), isNull(attributeValues.deletedAt)))
            .limit(200_000)
        : [];
    const byEntity: Record<string, Record<string, unknown>> = {};
    for (const v of vals as any[]) {
      const entityId = String(v.entityId);
      const defId = String(v.attributeDefId);
      if (!byEntity[entityId]) byEntity[entityId] = {};
      byEntity[entityId][defId] = safeJsonParse(v.valueJson ? String(v.valueJson) : null);
    }

    const out: ToolPropertyListItem[] = rows.map((r: any) => {
      const rec = byEntity[String(r.id)] ?? {};
      const name = nameDefId ? rec[nameDefId] : null;
      const params = paramsDefId ? rec[paramsDefId] : null;
      return {
        id: String(r.id),
        name: name ? String(name) : undefined,
        params: params ? String(params) : undefined,
        updatedAt: Number(r.updatedAt ?? 0),
        createdAt: Number(r.createdAt ?? 0),
      };
    });
    return { ok: true as const, items: out };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function getToolProperty(
  db: BetterSQLite3Database,
  id: string,
): Promise<{ ok: true; property: ToolDetails } | { ok: false; error: string }> {
  try {
    const details = await getEntityDetails(db, id);
    return { ok: true as const, property: details };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function createToolProperty(db: BetterSQLite3Database): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const typeId = await getToolPropertyTypeId(db);
    if (!typeId) return { ok: false as const, error: 'tool_property type not found' };
    const created = await createEntity(db, typeId);
    if (!created.ok) return created as any;
    return { ok: true as const, id: created.id };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function setToolPropertyAttribute(
  db: BetterSQLite3Database,
  args: { id: string; code: string; value: unknown },
): Promise<{ ok: true } | { ok: false; error: string }> {
  return setEntityAttribute(db, args.id, args.code, args.value) as any;
}

export async function deleteToolProperty(
  db: BetterSQLite3Database,
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return softDeleteEntity(db, id) as any;
}

export async function listToolMovements(
  db: BetterSQLite3Database,
  toolId: string,
  scope?: { userId: string; role: string },
): Promise<{ ok: true; movements: ToolMovementItem[] } | { ok: false; error: string }> {
  const access = await ensureToolAccess(db, toolId, scope, 'view');
  if (!access.ok) return access;
  const rows = await db
    .select()
    .from(operations)
    .where(and(eq(operations.engineEntityId, toolId), eq(operations.operationType, TOOL_MOVEMENT_TYPE), isNull(operations.deletedAt)))
    .orderBy(desc(operations.performedAt))
    .limit(2000);
  const out: ToolMovementItem[] = [];
  for (const r of rows as any[]) {
    const parsed = r.metaJson ? (safeJsonParse(String(r.metaJson)) as any) : null;
    out.push({
      id: String(r.id),
      toolId,
      movementAt: Number(parsed?.movementAt ?? r.performedAt ?? r.createdAt),
      mode: parsed?.mode === 'returned' ? 'returned' : 'received',
      employeeId: parsed?.employeeId ? String(parsed.employeeId) : null,
      confirmed: parsed?.confirmed === true,
      confirmedById: parsed?.confirmedById ? String(parsed.confirmedById) : null,
      comment: parsed?.comment ? String(parsed.comment) : null,
      createdAt: Number(r.createdAt ?? 0),
      updatedAt: Number(r.updatedAt ?? 0),
    });
  }
  return { ok: true as const, movements: out };
}

export async function addToolMovement(
  db: BetterSQLite3Database,
  args: {
    toolId: string;
    movementAt: number;
    mode: 'received' | 'returned';
    employeeId?: string | null;
    confirmed?: boolean;
    confirmedById?: string | null;
    comment?: string | null;
    actor: string;
    scope?: { userId: string; role: string };
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const access = await ensureToolAccess(db, args.toolId, args.scope, 'edit');
  if (!access.ok) return access;
  const ts = nowMs();
  const payload = {
    toolId: args.toolId,
    movementAt: args.movementAt,
    mode: args.mode,
    employeeId: args.employeeId ?? null,
    confirmed: args.confirmed === true,
    confirmedById: args.confirmedById ?? null,
    comment: args.comment ?? null,
  };
  await db.insert(operations).values({
    id: randomUUID(),
    engineEntityId: args.toolId,
    operationType: TOOL_MOVEMENT_TYPE,
    status: args.mode,
    note: args.comment ?? null,
    performedAt: args.movementAt,
    performedBy: args.actor?.trim() ? args.actor.trim() : 'local',
    metaJson: JSON.stringify(payload),
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'pending',
  });
  return { ok: true as const };
}

function fileListHtml(list: unknown) {
  const items = Array.isArray(list)
    ? list.filter((x) => x && typeof x === 'object' && typeof (x as any).name === 'string')
    : [];
  if (items.length === 0) return '<div class="muted">Нет файлов</div>';
  return `<ul>${items.map((f) => `<li>${escapeHtml(String((f as any).name))}</li>`).join('')}</ul>`;
}

function keyValueTable(rows: Array<[string, string]>) {
  const body = rows
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value || '—')}</td></tr>`)
    .join('\n');
  return `<table><tbody>${body}</tbody></table>`;
}

function toolCardHtml(args: {
  title: string;
  subtitle?: string | null;
  mainRows: Array<[string, string]>;
  propertiesRows: Array<[string, string]>;
  movementsRows: Array<[string, string]>;
  filesHtml: string;
}) {
  const subtitle = args.subtitle ? `<div class="subtitle">${escapeHtml(args.subtitle)}</div>` : '';
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${escapeHtml(args.title)}</title>
  <style>
    body { font-family: system-ui, Arial, sans-serif; margin: 24px; color: #0b1220; }
    h1 { margin: 0 0 6px 0; font-size: 20px; }
    h2 { margin: 0 0 8px 0; font-size: 14px; }
    .subtitle { color: #6b7280; font-size: 12px; margin-bottom: 14px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; font-size: 12px; vertical-align: top; }
    th { background: #f8fafc; width: 35%; }
    ul { margin: 0; padding-left: 18px; }
    .section { margin-bottom: 16px; }
    .muted { color: #6b7280; }
  </style>
</head>
<body>
  <h1>${escapeHtml(args.title)}</h1>
  ${subtitle}
  <section class="section">
    <h2>Основные данные</h2>
    ${keyValueTable(args.mainRows)}
  </section>
  <section class="section">
    <h2>Свойства инструмента</h2>
    ${args.propertiesRows.length ? keyValueTable(args.propertiesRows) : '<div class="muted">Нет данных</div>'}
  </section>
  <section class="section">
    <h2>Движение инструмента</h2>
    ${args.movementsRows.length ? keyValueTable(args.movementsRows) : '<div class="muted">Нет данных</div>'}
  </section>
  <section class="section">
    <h2>Фото</h2>
    ${args.filesHtml}
  </section>
</body>
</html>`;
}

export async function exportToolCardPdf(
  db: BetterSQLite3Database,
  args: { toolId: string; scope?: { userId: string; role: string } },
): Promise<{ ok: true; contentBase64: string; fileName: string; mime: string } | { ok: false; error: string }> {
  const access = await ensureToolAccess(db, args.toolId, args.scope, 'view');
  if (!access.ok) return access;
  const tool = await getEntityDetails(db, args.toolId);
  const attrs = tool.attributes ?? {};
  const deptId = attrs.department_id ? String(attrs.department_id) : '';
  const deptNameMap = await getDepartmentNamesById(db, deptId ? [deptId] : []);
  const deptName = deptId ? deptNameMap[deptId] ?? deptId : '';
  const propertiesRaw = Array.isArray(attrs.properties) ? attrs.properties : [];
  const propIds = propertiesRaw
    .map((p: any) => (p && typeof p === 'object' ? p.propertyId : null))
    .filter(Boolean)
    .map((id: any) => String(id));
  const propList = await listToolProperties(db);
  const propMap = new Map<string, { name?: string; params?: string }>();
  if (propList.ok) {
    for (const p of propList.items) propMap.set(p.id, { name: p.name, params: p.params });
  }

  const movements = await listToolMovements(db, args.toolId, args.scope);
  const employeeIds = movements.ok
    ? Array.from(
        new Set(
          movements.movements
            .flatMap((m) => [m.employeeId, m.confirmedById])
            .filter(Boolean)
            .map((id) => String(id)),
        ),
      )
    : [];
  const employeeNames = await getEmployeeNamesById(db, employeeIds);

  const mainRows: Array<[string, string]> = [
    ['Табельный номер', String(attrs.tool_number ?? '')],
    ['Наименование', String(attrs.name ?? '')],
    ['Серийный номер', String(attrs.serial_number ?? '')],
    ['Описание', String(attrs.description ?? '')],
    ['Подразделение', deptName || '—'],
    ['Дата поступления', attrs.received_at ? new Date(Number(attrs.received_at)).toLocaleDateString('ru-RU') : '—'],
    ['Дата снятия', attrs.retired_at ? new Date(Number(attrs.retired_at)).toLocaleDateString('ru-RU') : '—'],
    ['Причина снятия', String(attrs.retire_reason ?? '')],
  ];
  const propertiesRows = propIds.map((id) => {
    const p = propMap.get(id);
    return [p?.name ?? id, p?.params ?? '—'];
  });
  const movementsRows = movements.ok
    ? movements.movements.map((m) => {
        const who = m.employeeId ? employeeNames[m.employeeId] ?? m.employeeId : '—';
        const confirmedBy = m.confirmedById ? employeeNames[m.confirmedById] ?? m.confirmedById : '—';
        return [
          new Date(m.movementAt).toLocaleDateString('ru-RU'),
          `${m.mode === 'returned' ? 'Вернул' : 'Получил'}; сотрудник: ${who}; подтверждение: ${
            m.confirmed ? `да (${confirmedBy})` : 'нет'
          }; комментарий: ${m.comment ?? ''}`,
        ];
      })
    : [];

  const html = toolCardHtml({
    title: 'Карточка инструмента',
    subtitle: attrs.name ? `Наименование: ${String(attrs.name)}` : null,
    mainRows,
    propertiesRows,
    movementsRows,
    filesHtml: fileListHtml(attrs.photos),
  });

  const win = await renderHtmlWindow(html);
  try {
    const pdf = await win.webContents.printToPDF({ printBackground: true });
    return {
      ok: true,
      contentBase64: Buffer.from(pdf).toString('base64'),
      fileName: `tool_${args.toolId.slice(0, 8)}.pdf`,
      mime: 'application/pdf',
    };
  } finally {
    win.destroy();
  }
}
