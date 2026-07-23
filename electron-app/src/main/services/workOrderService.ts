import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  WORK_ORDER_PAYLOAD_VERSION,
  WorkOrderKind,
  canViewWorkOrder,
  findWorkOrderSignatureSlots,
  normalizeWorkOrderLine,
  normalizeWorkOrderPayloadV3Fields,
  resolveAssemblyEngineId,
  workOrderWithdrawnAt,
  type WorkOrderAuditTrailItem,
  type WorkOrderPayload,
} from '@matricarmz/shared';
import { SystemIds } from '@matricarmz/shared';
import { getRestrictedWorkOrderPolicyLocal } from './employeeService.js';
import { listEngines } from './engineService.js';

import { auditLog, operations } from '../database/schema.js';

const WORK_ORDERS_CONTAINER_ID = SystemIds.WorkOrdersContainerEntityId;
const WORK_ORDERS_OPERATION_TYPE = 'work_order';

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

function normalizeSearch(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/[^a-z0-9а-я\s_-]+/gi, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function monthKeyFromMs(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function safeNum(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toCents(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100);
}

function fromCents(value: number): number {
  return Math.round(value) / 100;
}

function normalizeLine(line: unknown, lineNo: number) {
  return normalizeWorkOrderLine(line, lineNo);
}

function distributeByKtu(
  totalAmountRub: number,
  crew: Array<{ ktu: number; payoutFrozen: boolean; manualPayoutRub: number }>,
): number[] {
  const totalCents = toCents(Math.max(0, safeNum(totalAmountRub, 0)));
  const frozenCentsByIndex = crew.map((member) => (member.payoutFrozen ? toCents(Math.max(0, safeNum(member.manualPayoutRub, 0))) : 0));
  const frozenTotalCents = frozenCentsByIndex.reduce((acc, value) => acc + value, 0);
  const remainingCents = Math.max(0, totalCents - frozenTotalCents);

  const unfrozen = crew
    .map((member, index) => ({ index, ktu: Math.max(0.01, safeNum(member.ktu, 1)), frozen: member.payoutFrozen }))
    .filter((entry) => !entry.frozen);
  const totalKtu = unfrozen.reduce((acc, entry) => acc + entry.ktu, 0);

  const payoutsCents = [...frozenCentsByIndex];
  if (unfrozen.length === 0 || totalKtu <= 0 || remainingCents <= 0) {
    for (const entry of unfrozen) payoutsCents[entry.index] = 0;
    return payoutsCents.map(fromCents);
  }

  const weighted = unfrozen.map((entry) => {
    const raw = (remainingCents * entry.ktu) / totalKtu;
    const floor = Math.floor(raw);
    return { index: entry.index, floor, remainder: raw - floor };
  });
  let distributed = weighted.reduce((acc, row) => acc + row.floor, 0);
  let remainder = remainingCents - distributed;
  weighted.sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    return a.index - b.index;
  });
  for (let i = 0; i < weighted.length && remainder > 0; i += 1) {
    const row = weighted[i];
    if (row) {
      row.floor += 1;
      remainder -= 1;
      distributed += 1;
    }
  }
  for (const row of weighted) payoutsCents[row.index] = row.floor;
  return payoutsCents.map(fromCents);
}

function getWorkOrderPartNames(payload: WorkOrderPayload): string[] {
  const names = (Array.isArray(payload.workGroups) ? payload.workGroups : [])
    .map((group) => String(group.partName ?? '').trim())
    .filter((name) => name.length > 0);
  if (names.length > 0) return Array.from(new Set(names));

  const legacyName = String((payload as any).partName ?? '').trim();
  return legacyName ? [legacyName] : [];
}

function getWorkOrderPrimaryWorkType(payload: WorkOrderPayload): string {
  const workGroups = Array.isArray(payload.workGroups) ? payload.workGroups : [];
  for (const group of workGroups) {
    const lines = Array.isArray(group?.lines) ? group.lines : [];
    const firstNamed = lines.find((line) => String(line?.serviceName ?? '').trim().length > 0);
    if (firstNamed) return String(firstNamed.serviceName).trim();
  }
  const freeWorks = Array.isArray(payload.freeWorks) ? payload.freeWorks : [];
  const freeNamed = freeWorks.find((line) => String(line?.serviceName ?? '').trim().length > 0);
  if (freeNamed) return String(freeNamed.serviceName).trim();
  const legacyWorks = Array.isArray((payload as any).works) ? (payload as any).works : [];
  const legacyNamed = legacyWorks.find((line: any) => String(line?.serviceName ?? '').trim().length > 0);
  if (legacyNamed) return String(legacyNamed.serviceName).trim();
  return '';
}

function getCrewSurnames(payload: WorkOrderPayload): string {
  const crew = Array.isArray(payload.crew) ? payload.crew : [];
  const surnames: string[] = [];
  const seen = new Set<string>();
  for (const member of crew) {
    const full = String(member?.employeeName ?? '').trim();
    if (!full) continue;
    const surname = full.split(/[,\s]+/).find((part) => String(part).trim().length > 0);
    const normalized = String(surname ?? '').trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    surnames.push(normalized);
  }
  return surnames.join(', ');
}

/** Марка, № и внутренний № двигателя для списка: первые непустые значения по строкам наряда. */
function getWorkOrderEngineInfo(payload: WorkOrderPayload): {
  engineBrand: string;
  engineNumber: string;
  engineInternalNumber: string;
} {
  const lines = Array.isArray(payload.freeWorks) ? payload.freeWorks : [];
  let engineBrand = '';
  let engineNumber = '';
  let engineInternalNumber = '';
  for (const l of lines) {
    if (!engineBrand) engineBrand = String((l as { engineBrandName?: unknown }).engineBrandName ?? '').trim();
    if (!engineNumber) engineNumber = String((l as { engineNumber?: unknown }).engineNumber ?? '').trim();
    if (!engineInternalNumber) {
      engineInternalNumber = String((l as { engineInternalNumber?: unknown }).engineInternalNumber ?? '').trim();
    }
    if (engineBrand && engineNumber && engineInternalNumber) break;
  }
  return { engineBrand, engineNumber, engineInternalNumber };
}

/**
 * «Принял в работу» (нач. цеха): подписант блока «Выдача» со строкой-ролью «Принял в работу».
 * Если таких подписантов несколько (напр. два начальника цеха) — берём первого заполненного.
 * Роль ищем по caption (он сохраняется вместе со слотом); запасной путь — слот после
 * «Наряд выдал»/«Согласовано (ОТК)» (индекс ≥ 2), если оператор переименовал подпись.
 */
function getWorkOrderAcceptedByEmployeeId(payload: WorkOrderPayload): string | null {
  const slots = findWorkOrderSignatureSlots(payload.signatureBlocks, 'issue');
  const isAcceptedCaption = (caption: unknown) =>
    String(caption ?? '')
      .toLowerCase()
      .replaceAll('ё', 'е')
      .includes('принял');
  for (const s of slots) {
    if (!isAcceptedCaption(s.caption)) continue;
    const id = String(s.employeeId ?? '').trim();
    if (id) return id;
  }
  for (let i = 2; i < slots.length; i += 1) {
    const id = String(slots[i]?.employeeId ?? '').trim();
    if (id) return id;
  }
  return null;
}

function getPrimaryPartId(payload: WorkOrderPayload): string | null {
  const group = (Array.isArray(payload.workGroups) ? payload.workGroups : []).find((entry) => entry?.partId);
  if (group?.partId) return String(group.partId);
  const legacyPartId = (payload as any).partId;
  return legacyPartId ? String(legacyPartId) : null;
}

// Для Assembly-наряда engine_entity_id должен указывать на собираемый двигатель
// (бэк-проверка workOrderClosingService требует engine_entity_id у Assembly).
// partId на Assembly = изделие сборки, не двигатель — поэтому берём двигатель наряда:
// шапка (`assemblyEngineId`), с фоллбеком на построчные штампы у старых нарядов. Читать
// только строки нельзя: у наряда с двигателем лишь в шапке провенанс молча уезжал на
// изделие/контейнер (регрессия после #133).
function workOrderEngineEntityId(payload: WorkOrderPayload): string {
  if (payload.workOrderKind === WorkOrderKind.Assembly) {
    const engineId = resolveAssemblyEngineId(payload);
    if (engineId) return engineId;
  }
  return getPrimaryPartId(payload) ?? WORK_ORDERS_CONTAINER_ID;
}

async function nextWorkOrderNumber(db: BetterSQLite3Database): Promise<number> {
  const rows = await db
    .select({ metaJson: operations.metaJson })
    .from(operations)
    .where(
      and(
        eq(operations.operationType, WORK_ORDERS_OPERATION_TYPE),
        isNull(operations.deletedAt),
      ),
    )
    .orderBy(desc(operations.createdAt))
    .limit(5000);
  let max = 0;
  for (const row of rows) {
    const parsed = row.metaJson ? (safeJsonParse(String(row.metaJson)) as any) : null;
    if (!parsed || parsed.kind !== 'work_order') continue;
    const n = Number(parsed.workOrderNumber ?? 0);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

function recalcPayload(payload: WorkOrderPayload): WorkOrderPayload {
  const rawPayload = payload as any;
  const normalizedGroupsSource: Array<{ groupId: string; partId: string | null; partName: string; lines: any[] }> = [];
  const normalizedFreeSource: any[] = [];

  const hasV2Groups = Array.isArray(rawPayload.workGroups) || Array.isArray(rawPayload.freeWorks);
  if (hasV2Groups) {
    const groups = Array.isArray(rawPayload.workGroups) ? rawPayload.workGroups : [];
    for (let idx = 0; idx < groups.length; idx += 1) {
      const group = groups[idx] ?? {};
      normalizedGroupsSource.push({
        groupId: String(group.groupId ?? `group-${idx + 1}`),
        partId: group.partId ? String(group.partId) : null,
        partName: String(group.partName ?? ''),
        lines: Array.isArray(group.lines) ? group.lines : [],
      });
    }
    if (Array.isArray(rawPayload.freeWorks)) {
      normalizedFreeSource.push(...rawPayload.freeWorks);
    }
  } else {
    const legacyWorks = Array.isArray(rawPayload.works) ? rawPayload.works : [];
    const legacyPartId = rawPayload.partId ? String(rawPayload.partId) : null;
    const legacyPartName = String(rawPayload.partName ?? '');
    if (legacyPartId || legacyPartName.trim().length > 0) {
      normalizedGroupsSource.push({
        groupId: 'legacy-main-group',
        partId: legacyPartId,
        partName: legacyPartName,
        lines: legacyWorks,
      });
    } else {
      normalizedFreeSource.push(...legacyWorks);
    }
  }

  const workGroups = normalizedGroupsSource.map((group, groupIdx) => ({
    groupId: group.groupId || `group-${groupIdx + 1}`,
    partId: group.partId ? String(group.partId) : null,
    partName: String(group.partName ?? ''),
    lines: (Array.isArray(group.lines) ? group.lines : []).map((line, lineIdx) => normalizeLine(line, lineIdx + 1)),
  }));
  const freeWorks = normalizedFreeSource.map((line, idx) => normalizeLine(line, idx + 1));

  const works = [...workGroups.flatMap((group) => group.lines), ...freeWorks].map((line, idx) => ({
    ...line,
    lineNo: idx + 1,
  }));
  const totalAmountRub = fromCents(works.reduce((acc, line) => acc + toCents(safeNum(line.amountRub, 0)), 0));

  const crew = (Array.isArray(rawPayload.crew) ? rawPayload.crew : []).map((member: any) => {
    const ktu = Math.max(0.01, safeNum(member?.ktu, 1));
    const payoutFrozen = Boolean(member?.payoutFrozen);
    const manualPayoutRub = Math.max(0, safeNum(member?.manualPayoutRub ?? member?.payoutRub, 0));
    return {
      employeeId: String(member?.employeeId ?? ''),
      employeeName: String(member?.employeeName ?? ''),
      ktu,
      payoutFrozen,
      manualPayoutRub,
    };
  });

  const payoutValues = distributeByKtu(totalAmountRub, crew);
  const payouts = crew.map((member: { employeeId: string; employeeName: string; ktu: number; payoutFrozen: boolean; manualPayoutRub: number }, idx: number) => ({
    employeeId: member.employeeId,
    employeeName: member.employeeName,
    ktu: member.ktu,
    amountRub: payoutValues[idx] ?? 0,
  }));
  const crewWithPayout = crew.map((member: { employeeId: string; employeeName: string; ktu: number; payoutFrozen: boolean; manualPayoutRub: number }, idx: number) => ({
    ...member,
    payoutRub: payoutValues[idx] ?? 0,
    manualPayoutRub: member.payoutFrozen ? member.manualPayoutRub : undefined,
  }));

  // Preserve v3 parts-movement module fields (workshopId, workOrderKind, consumed/producedLines, linkedDocumentId).
  // Without this, recalcPayload would silently wipe new fields when a v3 work order is edited on this client.
  const v3 = normalizeWorkOrderPayloadV3Fields(rawPayload);

  return {
    ...payload,
    version: WORK_ORDER_PAYLOAD_VERSION,
    workGroups,
    freeWorks,
    works,
    crew: crewWithPayout,
    totalAmountRub,
    basePerWorkerRub: crew.length > 0 ? fromCents(toCents(totalAmountRub / crew.length)) : 0,
    payouts,
    partId: null,
    partName: '',
    ...v3,
  };
}

function parseWorkOrder(metaJson: string | null): WorkOrderPayload | null {
  if (!metaJson) return null;
  const parsed = safeJsonParse(metaJson) as any;
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.kind !== 'work_order') return null;
  return recalcPayload(parsed as WorkOrderPayload);
}

async function audit(db: BetterSQLite3Database, actor: string, action: string, payload: any) {
  const ts = nowMs();
  await db.insert(auditLog).values({
    id: randomUUID(),
    actor,
    action,
    entityId: payload?.operationId ? String(payload.operationId) : null,
    tableName: 'operations',
    payloadJson: JSON.stringify(payload ?? null),
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'pending',
  });
}

export async function listWorkOrders(
  db: BetterSQLite3Database,
  args?: { q?: string; month?: string; viewer?: { login: string; role: string } },
): Promise<
  | {
      ok: true;
      rows: Array<{
        id: string;
        workOrderNumber: number;
        orderDate: number;
        startDate: number | null;
        workType: string;
        crewCount: number;
        performerSurnames: string;
        totalAmountRub: number;
        updatedAt: number;
        status: string;
        linkedDocumentId: string | null;
        dueDate: number | null;
        completedAt: number | null;
        completedDate: number | null;
        engineBrand: string;
        engineNumber: string;
        engineInternalNumber: string;
        acceptedByEmployeeId: string | null;
        workOrderKind: string;
        withdrawnAt: number | null;
      }>;
    }
  | { ok: false; error: string }
> {
  try {
    const rows = await db
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.operationType, WORK_ORDERS_OPERATION_TYPE),
          isNull(operations.deletedAt),
        ),
      )
      .orderBy(desc(operations.updatedAt))
      .limit(5000);

    const qNorm = args?.q ? normalizeSearch(args.q) : '';
    const month = args?.month ? String(args.month).trim() : '';
    const viewer = args?.viewer;
    // Сборочный наряд после #133 несёт двигатель в шапке (payload.assemblyEngineId), а
    // построчные штампы могут быть стрижены normalizeWorkOrderLine — резолвим номер/марку
    // по карте двигателей. Карта грузится ОДИН раз на вызов и только если в выборке
    // вообще есть сборочные наряды (без N+1 на 5000 строк).
    const mayNeedEngineMap = rows.some((r) => String(r.metaJson ?? '').includes('"workOrderKind":"assembly"'));
    const engineById = mayNeedEngineMap
      ? new Map((await listEngines(db).catch(() => [])).map((e) => [String(e.id), e]))
      : null;
    // Configurable restricted-orders lists (Ф3); undefined → shared legacy hardcode.
    const restrictedPolicy = viewer
      ? ((await getRestrictedWorkOrderPolicyLocal(db).catch(() => null)) ?? undefined)
      : undefined;

    const out: Array<{
      id: string;
      workOrderNumber: number;
      orderDate: number;
      startDate: number | null;
      workType: string;
      crewCount: number;
      performerSurnames: string;
      totalAmountRub: number;
      updatedAt: number;
      status: string;
      linkedDocumentId: string | null;
      dueDate: number | null;
      completedAt: number | null;
      completedDate: number | null;
      engineBrand: string;
      engineNumber: string;
      engineInternalNumber: string;
      acceptedByEmployeeId: string | null;
      workOrderKind: string;
      withdrawnAt: number | null;
    }> = [];

    for (const row of rows) {
      const payload = parseWorkOrder(row.metaJson ? String(row.metaJson) : null);
      if (!payload) continue;
      // Display-time isolation: hide work orders the signed-in user may not see
      // (owner = performed_by). Full DB stays local; this filters the list only.
      if (
        viewer &&
        !canViewWorkOrder({
          viewerLogin: viewer.login,
          viewerRole: viewer.role,
          ownerLogin: String(row.performedBy ?? ''),
          ...(restrictedPolicy ? { policy: restrictedPolicy } : {}),
        })
      ) {
        continue;
      }
      const partName = getWorkOrderPartNames(payload).join(', ');
      const workType = getWorkOrderPrimaryWorkType(payload);
      const performerSurnames = getCrewSurnames(payload);
      const engineInfo = getWorkOrderEngineInfo(payload);
      if ((!engineInfo.engineBrand || !engineInfo.engineNumber || !engineInfo.engineInternalNumber) && engineById) {
        const engineId = resolveAssemblyEngineId(payload);
        const engine = engineId ? engineById.get(engineId) : undefined;
        if (engine) {
          if (!engineInfo.engineBrand) engineInfo.engineBrand = String(engine.engineBrand ?? '').trim();
          if (!engineInfo.engineNumber) engineInfo.engineNumber = String(engine.engineNumber ?? '').trim();
          // Наряды, выписанные до внутренних номеров, снимка не имеют — дотягиваем из
          // карточки двигателя, иначе колонка была бы вечно пустой на старых нарядах.
          if (!engineInfo.engineInternalNumber) {
            engineInfo.engineInternalNumber = String(engine.internalNumberFull ?? '').trim();
          }
        }
      }
      const isClosedRow = String(row.status ?? 'open') === 'closed';
      const mKey = monthKeyFromMs(Number(payload.orderDate ?? row.createdAt));
      if (month && mKey !== month) continue;
      if (qNorm) {
        // Номер/марка двигателя явно в haystack: у сборочных нарядов они резолвятся из
        // шапки и в JSON payload'а могут отсутствовать (иначе поиск по № двигателя слеп).
        const hay = normalizeSearch(
          [
            payload.workOrderNumber,
            workType,
            performerSurnames,
            partName,
            engineInfo.engineNumber,
            engineInfo.engineInternalNumber,
            engineInfo.engineBrand,
            row.note ?? '',
            JSON.stringify(payload),
          ].join(' '),
        );
        if (!hay.includes(qNorm)) continue;
      }
      out.push({
        id: String(row.id),
        workOrderNumber: Number(payload.workOrderNumber ?? 0),
        orderDate: Number(payload.orderDate ?? row.createdAt),
        startDate: payload.startDate != null && payload.startDate > 0 ? Number(payload.startDate) : null,
        workType,
        crewCount: Array.isArray(payload.crew) ? payload.crew.length : 0,
        performerSurnames,
        totalAmountRub: Number(payload.totalAmountRub ?? 0),
        updatedAt: Number(row.updatedAt),
        status: String(row.status ?? 'open'),
        linkedDocumentId: payload.linkedDocumentId ? String(payload.linkedDocumentId) : null,
        dueDate: payload.dueDate != null && payload.dueDate > 0 ? Number(payload.dueDate) : null,
        completedAt: isClosedRow
          ? payload.completedDate != null && Number(payload.completedDate) > 0
            ? Number(payload.completedDate)
            : Number(row.updatedAt)
          : null,
        // Оператор-заданная дата выполнения — surface для ВСЕХ нарядов (в т.ч. открытых): по ней
        // статус деривится как «выполнен», иначе открытый наряд с датой в срок красился overdue.
        completedDate: payload.completedDate != null && Number(payload.completedDate) > 0 ? Number(payload.completedDate) : null,
        engineBrand: engineInfo.engineBrand,
        engineNumber: engineInfo.engineNumber,
        engineInternalNumber: engineInfo.engineInternalNumber,
        acceptedByEmployeeId: getWorkOrderAcceptedByEmployeeId(payload),
        workOrderKind: String(payload.workOrderKind ?? WorkOrderKind.Regular),
        withdrawnAt: workOrderWithdrawnAt(payload as unknown as Record<string, unknown>),
      });
    }

    return { ok: true as const, rows: out };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function getWorkOrder(
  db: BetterSQLite3Database,
  id: string,
): Promise<{ ok: true; payload: WorkOrderPayload; status: string; updatedAt: number } | { ok: false; error: string }> {
  try {
    const rows = await db
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.id, id),
          eq(operations.operationType, WORK_ORDERS_OPERATION_TYPE),
          isNull(operations.deletedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return { ok: false as const, error: 'Наряд не найден' };
    const payload = parseWorkOrder(row.metaJson ? String(row.metaJson) : null);
    if (!payload) return { ok: false as const, error: 'Некорректный metaJson наряда' };
    return {
      ok: true as const,
      payload,
      status: String(row.status ?? 'open'),
      updatedAt: Number(row.updatedAt ?? 0),
    };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

/**
 * Активный вариант сборки (BOM `variantGroup`) для двигателя — из его последнего НЕзакрытого
 * Assembly-наряда. Используется списком деталей двигателя (checklist Этап 5) для фильтра строк.
 * Нет подходящего наряда → `variantGroup: null` (фильтр не применяется).
 */
export async function getActiveAssemblyVariant(
  db: BetterSQLite3Database,
  engineId: string,
): Promise<{ ok: true; variantGroup: string | null } | { ok: false; error: string }> {
  try {
    const target = String(engineId ?? '').trim();
    if (!target) return { ok: true as const, variantGroup: null };
    const rows = await db
      .select()
      .from(operations)
      .where(and(eq(operations.operationType, WORK_ORDERS_OPERATION_TYPE), isNull(operations.deletedAt)))
      .orderBy(desc(operations.updatedAt))
      .limit(5000);

    for (const row of rows) {
      if (String(row.status ?? 'open') === 'closed') continue;
      const payload = parseWorkOrder(row.metaJson ? String(row.metaJson) : null);
      if (!payload || payload.workOrderKind !== WorkOrderKind.Assembly) continue;
      // Двигатель наряда — шапка, с фоллбеком на строки: иначе наряд с двигателем только
      // в шапке не находился и вариант сборки считался незанятым.
      if (resolveAssemblyEngineId(payload) !== target) continue;
      const vg = String(payload.assemblyVariantGroup ?? '').trim();
      return { ok: true as const, variantGroup: vg || null };
    }
    return { ok: true as const, variantGroup: null };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

/**
 * Phase 2 (deferred-create): returns a fresh id + synthesized empty payload WITHOUT inserting
 * an operations row. `workOrderNumber: 0` is the «не присвоен» sentinel — the number (max+1) and
 * the row are materialized on the first save (`updateWorkOrder` upsert). An abandoned empty card
 * leaves no row and no number consumed; content is held meanwhile as a recovery draft (Phase 3b).
 */
export async function createWorkOrder(
  db: BetterSQLite3Database,
  actor: string,
): Promise<{ ok: true; id: string; payload: WorkOrderPayload } | { ok: false; error: string }> {
  try {
    const ts = nowMs();
    const id = randomUUID();
    const payload = recalcPayload({
      kind: 'work_order',
      version: 2,
      operationId: id,
      workOrderNumber: 0,
      orderDate: ts,
      crew: [],
      workGroups: [],
      freeWorks: [],
      works: [],
      totalAmountRub: 0,
      basePerWorkerRub: 0,
      payouts: [],
      auditTrail: [{ at: ts, by: actor, action: 'create' }],
    });
    return { ok: true as const, id, payload };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

/**
 * След аудита — история, а не поле карточки: базой берём то, что уже лежит в строке, и добавляем
 * то, чего в ней нет. Открытая карточка держит снимок payload'а, сделанный при загрузке, и её
 * сохранение затирало след — вместе с маркером `number_change`, по которому серверный backstop
 * (`workOrderNumberGuard`) отличает осознанную смену номера от чужой. Симптом был ровно такой:
 * номер меняется, а ближайший push прилетает без маркера, сервер лечит его назад, и через полминуты
 * pull возвращает старый номер.
 */
function mergeAuditTrail(stored: unknown, incoming: unknown): WorkOrderAuditTrailItem[] {
  const seen = new Set<string>();
  const merged: WorkOrderAuditTrailItem[] = [];
  for (const raw of [...(Array.isArray(stored) ? stored : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as WorkOrderAuditTrailItem;
    const key = `${Number(item.at) || 0}|${String(item.by ?? '')}|${String(item.action ?? '')}|${String(item.note ?? '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
}

export async function updateWorkOrder(
  db: BetterSQLite3Database,
  args: { id: string; payload: WorkOrderPayload; actor: string },
): Promise<{ ok: true; workOrderNumber: number } | { ok: false; error: string }> {
  try {
    const ts = nowMs();
    const existing = await db
      .select({ id: operations.id, metaJson: operations.metaJson })
      .from(operations)
      .where(
        and(
          eq(operations.id, args.id),
          eq(operations.operationType, WORK_ORDERS_OPERATION_TYPE),
          isNull(operations.deletedAt),
        ),
      )
      .limit(1);

    // Phase 2 (deferred-create): first save of a not-yet-materialized order inserts the row and
    // assigns the number (max+1) now. Any number carried in the payload (0 sentinel, or a source
    // order's number on copy) is ignored on insert — a new order always gets a fresh number.
    if (existing.length === 0) {
      const workOrderNumber = await nextWorkOrderNumber(db);
      const payload = recalcPayload({
        ...args.payload,
        operationId: args.id,
        workOrderNumber,
        auditTrail: [...(args.payload.auditTrail ?? []), { at: ts, by: args.actor, action: 'create' }],
      });
      await db.insert(operations).values({
        id: args.id,
        engineEntityId: workOrderEngineEntityId(payload),
        operationType: WORK_ORDERS_OPERATION_TYPE,
        status: 'draft',
        note: `Наряд №${workOrderNumber}`,
        performedAt: payload.orderDate,
        performedBy: args.actor?.trim() ? args.actor.trim() : 'local',
        metaJson: JSON.stringify(payload),
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'pending',
      });
      await audit(db, args.actor, 'work_order.create', payload);
      return { ok: true as const, workOrderNumber };
    }

    // The assigned number is immutable: a stale recovery draft (snapshot taken before
    // materialization) carries `workOrderNumber: 0` — committing it must never downgrade the
    // stored number (the «№ новый навсегда» loss). Row's number wins; if the row itself is
    // broken (0, from a past incident), heal it: keep a valid payload number or assign a fresh one.
    const existingParsed = existing[0]?.metaJson ? (safeJsonParse(String(existing[0].metaJson)) as any) : null;
    const existingNumber = Number(existingParsed?.workOrderNumber ?? 0);
    const payloadNumber = Number(args.payload.workOrderNumber ?? 0);
    const workOrderNumber =
      existingNumber > 0 ? existingNumber : payloadNumber > 0 ? payloadNumber : await nextWorkOrderNumber(db);

    const payload = recalcPayload({
      ...args.payload,
      operationId: args.id,
      workOrderNumber,
      auditTrail: [
        ...mergeAuditTrail(existingParsed?.auditTrail, args.payload.auditTrail),
        { at: ts, by: args.actor, action: 'update' },
      ],
    });

    await db
      .update(operations)
      .set({
        engineEntityId: workOrderEngineEntityId(payload),
        status: 'draft',
        note: `Наряд №${payload.workOrderNumber}`,
        performedAt: payload.orderDate,
        metaJson: JSON.stringify(payload),
        updatedAt: ts,
        syncStatus: 'pending',
      })
      .where(
        and(
          eq(operations.id, args.id),
          eq(operations.operationType, WORK_ORDERS_OPERATION_TYPE),
          isNull(operations.deletedAt),
        ),
      );

    return { ok: true as const, workOrderNumber: Number(payload.workOrderNumber ?? 0) };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export const MAX_WORK_ORDER_NUMBER = 999999;

/**
 * Смена номера наряда — только для суперадмина (право проверяется в IPC-слое) и только этим путём:
 * `updateWorkOrder` номер по-прежнему не пускает (фикс «№ новый навсегда»). Нужна, чтобы чинить
 * номера, потерянные старым багом. Статус наряда намеренно НЕ трогаем — иначе закрытый наряд
 * «раскрылся» бы и разъехался со своим складским документом.
 */
export async function setWorkOrderNumber(
  db: BetterSQLite3Database,
  args: { id: string; workOrderNumber: number; actor: string },
): Promise<{ ok: true; workOrderNumber: number } | { ok: false; error: string }> {
  try {
    const next = Number(args.workOrderNumber);
    if (!Number.isInteger(next) || next <= 0 || next > MAX_WORK_ORDER_NUMBER) {
      return { ok: false as const, error: `Номер должен быть целым числом от 1 до ${MAX_WORK_ORDER_NUMBER}` };
    }

    const current = await getWorkOrder(db, args.id);
    if (!current.ok) return current;
    const previous = Number(current.payload.workOrderNumber ?? 0);
    if (previous === next) return { ok: true as const, workOrderNumber: next };

    const rows = await db
      .select({ id: operations.id, metaJson: operations.metaJson })
      .from(operations)
      .where(
        and(
          eq(operations.operationType, WORK_ORDERS_OPERATION_TYPE),
          isNull(operations.deletedAt),
        ),
      );
    for (const row of rows) {
      if (String(row.id) === args.id) continue;
      const parsed = row.metaJson ? (safeJsonParse(String(row.metaJson)) as any) : null;
      if (!parsed || parsed.kind !== 'work_order') continue;
      if (Number(parsed.workOrderNumber ?? 0) === next) {
        return { ok: false as const, error: `Номер ${next} уже занят другим нарядом — освободите его или выберите другой` };
      }
    }

    const ts = nowMs();
    const payload = recalcPayload({
      ...current.payload,
      workOrderNumber: next,
      // note читает серверный backstop (workOrderNumberGuard): это маркер осознанной смены.
      auditTrail: [...(current.payload.auditTrail ?? []), { at: ts, by: args.actor, action: 'number_change', note: `№${next}` }],
    });
    await db
      .update(operations)
      .set({
        note: `Наряд №${next}`,
        metaJson: JSON.stringify(payload),
        updatedAt: ts,
        syncStatus: 'pending',
      })
      .where(
        and(
          eq(operations.id, args.id),
          eq(operations.operationType, WORK_ORDERS_OPERATION_TYPE),
          isNull(operations.deletedAt),
        ),
      );
    await audit(db, args.actor, 'work_order.number_change', { operationId: args.id, from: previous, to: next });
    return { ok: true as const, workOrderNumber: next };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function deleteWorkOrder(
  db: BetterSQLite3Database,
  args: { id: string; actor: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const current = await getWorkOrder(db, args.id);
    if (!current.ok) return current;
    const ts = nowMs();
    await db
      .update(operations)
      .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'pending' })
      .where(
        and(
          eq(operations.id, args.id),
          eq(operations.operationType, WORK_ORDERS_OPERATION_TYPE),
          isNull(operations.deletedAt),
        ),
      );
    await audit(db, args.actor, 'work_order.delete', current.payload);
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export const __workOrderTestUtils = {
  recalcPayload,
  distributeByKtu,
  normalizeLine,
  getWorkOrderPartNames,
  workOrderEngineEntityId,
};

