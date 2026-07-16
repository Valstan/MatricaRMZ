import { and, eq, isNull, lte } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  type ReportCellValue,
  type ReportPresetFilters,
  type ReportPresetPreviewResult,
  ENGINE_INTERNAL_NUMBER_CODE,
  ENGINE_INTERNAL_NUMBER_YEAR_CODE,
  formatEngineInternalNumber,
  resolveWorkOrderSignatureDecryptions,
  deriveWorkOrderStatusCode,
  findWorkOrderSignatureSlots,
  WORK_ORDER_STATUS_LABELS,
  WORK_ORDER_KIND_LABELS,
  collectWorkOrderWorkLines,
  computeWorkOrdersStatusSummary,
  resolveAssemblyEngineId,
  selectWorkOrdersReportColumns,
  sortWorkOrdersReportRows,
  workOrderWithdrawnAt,
  type WorkOrderSignatureEmployee,
  type WorkOrderStatusCode,
  type WorkOrdersReportRow,
  type WorkOrdersReportSortBy,
} from '@matricarmz/shared';

import {
  operations,
} from '../../../database/schema.js';
import { formatMoscowDate } from '../../../utils/dateUtils.js';


import { resolveEngineShippingState } from '../../reportEngineShippingState.js';

import { safeJsonParse, toNumber, normalizeText, asArray, asNumberOrNull, readPeriod, msToDate } from '../format.js';
import { getPreset, loadSnapshot, getIdsByType } from '../context.js';
import { relatedEntityLabel, buildOptions, buildCounterpartyOptions } from '../options.js';

export type NormalizedWorkOrderReportLine = {
  serviceName: string;
  qty: number;
  amountRub: number;
};

export type NormalizedWorkOrderReportCrewMember = {
  employeeId: string;
  employeeName: string;
  personnelNumber: string;
  ktu: number;
  payoutRub: number;
};

export type PayrollSummaryBucket = {
  employeeName: string;
  personnelNumber: string;
  departmentName: string;
  lines: number;
  totalKtu: number;
  amountRub: number;
  workOrderKeys: Set<string>;
};

export function normalizeWorkOrderReportLines(payload: any): NormalizedWorkOrderReportLine[] {
  const normalized = (source: unknown): NormalizedWorkOrderReportLine[] =>
    Array.isArray(source)
      ? source.map((line) => ({
          serviceName: normalizeText((line as any)?.serviceName, '(без названия)'),
          qty: Math.max(0, toNumber((line as any)?.qty)),
          amountRub: Math.max(0, toNumber((line as any)?.amountRub)),
        }))
      : [];

  const grouped = Array.isArray(payload?.workGroups)
    ? payload.workGroups.flatMap((group: any) => normalized(group?.lines))
    : [];
  const free = normalized(payload?.freeWorks);
  const combined = [...grouped, ...free];
  if (combined.length > 0) return combined;

  const legacyWorks = normalized(payload?.works);
  if (legacyWorks.length > 0) return legacyWorks;

  const fallbackName = normalizeText(payload?.partName, '');
  if (!fallbackName) return [];
  return [
    {
      serviceName: fallbackName,
      qty: 1,
      amountRub: Math.max(0, toNumber(payload?.totalAmountRub)),
    },
  ];
}

export function normalizeWorkOrderReportCrew(
  payload: any,
  personnelByEmployeeId?: Map<string, string>,
): NormalizedWorkOrderReportCrewMember[] {
  const payoutFallbackByKey = new Map<string, { employeeName: string; ktu: number; payoutRub: number }>();
  if (Array.isArray(payload?.payouts)) {
    for (const item of payload.payouts) {
      const employeeId = normalizeText(item?.employeeId, '');
      const employeeName = normalizeText(item?.employeeName, '');
      const key = employeeId || employeeName.toLowerCase();
      if (!key) continue;
      payoutFallbackByKey.set(key, {
        employeeName,
        ktu: Math.max(0.01, toNumber(item?.ktu) || 1),
        payoutRub: Math.max(0, toNumber(item?.amountRub)),
      });
    }
  }

  if (Array.isArray(payload?.crew) && payload.crew.length > 0) {
    return payload.crew
      .map((member: any) => {
        const employeeId = normalizeText(member?.employeeId, '');
        const employeeName = normalizeText(member?.employeeName, '');
        const key = employeeId || employeeName.toLowerCase();
        const fallback = key ? payoutFallbackByKey.get(key) : undefined;
        const payoutRub = Math.max(
          0,
          toNumber(
            member?.payoutFrozen
              ? member?.manualPayoutRub ?? member?.payoutRub ?? fallback?.payoutRub
              : member?.payoutRub ?? fallback?.payoutRub,
          ),
        );
        const personnelNumber = employeeId && personnelByEmployeeId?.has(employeeId)
          ? personnelByEmployeeId.get(employeeId)!
          : '';
        return {
          employeeId,
          employeeName: employeeName || fallback?.employeeName || '(не указан)',
          personnelNumber,
          ktu: Math.max(0.01, toNumber(member?.ktu) || fallback?.ktu || 1),
          payoutRub,
        } satisfies NormalizedWorkOrderReportCrewMember;
      })
      .filter((member: any) => member.employeeId || member.employeeName !== '(не указан)');
  }

  return Array.isArray(payload?.payouts)
    ? payload.payouts
        .map((item: any) => ({
          employeeId: normalizeText(item?.employeeId, ''),
          employeeName: normalizeText(item?.employeeName, '(не указан)'),
          personnelNumber: item?.employeeId && personnelByEmployeeId?.has(item.employeeId)
            ? personnelByEmployeeId.get(item.employeeId)!
            : '',
          ktu: Math.max(0.01, toNumber(item?.ktu) || 1),
          payoutRub: Math.max(0, toNumber(item?.amountRub)),
        }))
        .filter((member: any) => member.employeeId || member.employeeName !== '(не указан)')
    : [];
}

export function resolveWorkOrderTargetLabel(payload: any): string {
  const direct = normalizeText(payload?.partName, '');
  if (direct) return direct;
  const partNames = Array.isArray(payload?.workGroups)
    ? payload.workGroups
        .map((group: any) => normalizeText(group?.partName, ''))
        .filter(Boolean)
    : [];
  if (partNames.length === 0) return '';
  return Array.from(new Set(partNames)).join(', ');
}

export async function buildWorkOrderCostsReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const brandFilter = asArray(filters?.brandIds);
  const employeeFilter = asArray(filters?.employeeIds);
  const snapshot = await loadSnapshot(db);
  const brandOptions = new Map(buildOptions(snapshot, 'engine_brand').map((o) => [o.value, o.label] as const));
  const rows: Array<Record<string, ReportCellValue>> = [];
  const sourceOps = await db
    .select()
    .from(operations)
    .where(and(isNull(operations.deletedAt), eq(operations.operationType, 'work_order'), lte(operations.createdAt, period.endMs)))
    .limit(120_000);
  for (const op of sourceOps as any[]) {
    const payload = safeJsonParse(String(op.metaJson ?? '')) as any;
    if (!payload || payload.kind !== 'work_order') continue;
    const orderDate = Number(payload.orderDate ?? op.performedAt ?? op.createdAt ?? 0);
    if (period.startMs != null && orderDate < period.startMs) continue;
    if (orderDate > period.endMs) continue;
    const normalizedCrew = normalizeWorkOrderReportCrew(payload);
    const crewIds = normalizedCrew.map((member) => member.employeeId).filter(Boolean);
    if (employeeFilter.length > 0 && !crewIds.some((id: string) => employeeFilter.includes(id))) continue;
    const partId = normalizeText(payload.partId ?? op.engineEntityId, '');
    const partAttrs = partId ? snapshot.attrsByEntity.get(partId) : undefined;
    const brandId = normalizeText(partAttrs?.engine_brand_id, '');
    if (brandFilter.length > 0 && (!brandId || !brandFilter.includes(brandId))) continue;
    const works = normalizeWorkOrderReportLines(payload);
    const fallbackWorkLabel = resolveWorkOrderTargetLabel(payload);
    const normalizedWorks = works.length > 0 ? works : [{ serviceName: fallbackWorkLabel || '(без названия)', qty: 1, amountRub: Math.max(0, toNumber(payload.totalAmountRub)) }];
    const crewLabel = normalizedCrew.map((member) => member.employeeName).filter(Boolean).join(', ');
    for (const work of normalizedWorks) {
      rows.push({
        workOrderNumber: toNumber(payload.workOrderNumber),
        engineNumber: fallbackWorkLabel,
        engineBrand: brandOptions.get(brandId) ?? normalizeText(partAttrs?.engine_brand, brandId),
        orderDate,
        workLabel: normalizeText(work?.serviceName, '(без названия)'),
        qty: Math.max(0, toNumber(work?.qty)),
        amountRub: Math.max(0, toNumber(work?.amountRub)),
        crewLabel,
      });
    }
  }
  rows.sort((a, b) => toNumber(b.orderDate) - toNumber(a.orderDate));
  const preset = getPreset('work_order_costs');
  return {
    ok: true,
    presetId: 'work_order_costs',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    totals: {
      lines: rows.length,
      workOrders: new Set(rows.map((r) => String(r.workOrderNumber))).size,
      amountRub: rows.reduce((acc, row) => acc + toNumber(row.amountRub), 0),
    },
    generatedAt: Date.now(),
  };
}

export async function buildWorkOrdersReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const now = Date.now();
  const issuedStart = asNumberOrNull(filters?.issuedStartMs);
  const issuedEnd = asNumberOrNull(filters?.issuedEndMs);
  const dueStart = asNumberOrNull(filters?.dueStartMs);
  const dueEnd = asNumberOrNull(filters?.dueEndMs);
  const completedStart = asNumberOrNull(filters?.completedStartMs);
  const completedEnd = asNumberOrNull(filters?.completedEndMs);
  const statusCodes = new Set(asArray(filters?.statusCodes));
  const kinds = new Set(asArray(filters?.kinds));
  const responsibleFilter = asArray(filters?.responsibleIds);
  const brandFilter = asArray(filters?.brandIds);
  const counterpartyFilter = asArray(filters?.counterpartyIds);
  const numberQuery = normalizeText(filters?.numberQuery, '').trim();
  const engineNumberQuery = normalizeText(filters?.engineNumberQuery, '').trim();
  const workTypeQuery = normalizeText(filters?.workTypeQuery, '').trim();
  const columnKeys = asArray(filters?.columns);
  const sortBy = normalizeText(filters?.sortBy, 'orderDate') as WorkOrdersReportSortBy;
  const sortDir = normalizeText(filters?.sortDir, 'desc') === 'asc' ? 'asc' : 'desc';
  const summaryByBrand = filters?.summaryByBrand === true;

  const snapshot = await loadSnapshot(db);
  const employeeNames = new Map(buildOptions(snapshot, 'employee').map((o) => [o.value, o.label] as const));
  const brandNames = new Map(buildOptions(snapshot, 'engine_brand').map((o) => [o.value, o.label] as const));
  const counterpartyNames = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));
  const brandFilterNamesLc = new Set(
    brandFilter.map((id) => String(brandNames.get(id) ?? '').trim().toLowerCase()).filter(Boolean),
  );

  // Контрагент наряда: двигатель строки → его контракт/заказчик → контрагент (кратк. имя, иначе полное).
  const resolveCounterparty = (engineId: string): { id: string; label: string } => {
    if (!engineId) return { id: '', label: '' };
    const eAttrs = snapshot.attrsByEntity.get(engineId) ?? {};
    let customerId = normalizeText(eAttrs.customer_id, '');
    const contractId = normalizeText(eAttrs.contract_id, '');
    if (!customerId && contractId) customerId = normalizeText(snapshot.attrsByEntity.get(contractId)?.customer_id, '');
    if (!customerId) return { id: '', label: '' };
    const cAttrs = snapshot.attrsByEntity.get(customerId) ?? {};
    const label = normalizeText(cAttrs.short_name, '') || normalizeText(cAttrs.name, '') || relatedEntityLabel(snapshot, customerId);
    return { id: customerId, label };
  };

  const sourceOps = await db
    .select()
    .from(operations)
    .where(and(isNull(operations.deletedAt), eq(operations.operationType, 'work_order')))
    .limit(120_000);

  const rows: WorkOrdersReportRow[] = [];
  for (const op of sourceOps as any[]) {
    const payload = safeJsonParse(String(op.metaJson ?? '')) as any;
    if (!payload || payload.kind !== 'work_order') continue;

    const orderDate = Number(payload.orderDate ?? op.createdAt ?? 0);
    if (issuedStart != null && orderDate < issuedStart) continue;
    if (issuedEnd != null && orderDate > issuedEnd) continue;

    // Срок-диапазон сужает только наряды, У КОТОРЫХ срок задан; наряды без срока им не
    // отсекаются (иначе дефолтный «текущий месяц» из buildDefaultFilters обнулял бы отчёт,
    // т.к. у большинства нарядов dueDate отсутствует).
    const dueDate = payload.dueDate != null && Number(payload.dueDate) > 0 ? Number(payload.dueDate) : null;
    if (dueDate != null && dueStart != null && dueDate < dueStart) continue;
    if (dueDate != null && dueEnd != null && dueDate > dueEnd) continue;

    const opStatus = String(op.status ?? 'open');
    const operatorCompleted =
      payload.completedDate != null && Number(payload.completedDate) > 0 ? Number(payload.completedDate) : null;
    // Эффективная дата выполнения: оператор-заданная дата, иначе время закрытия (для закрытых).
    const completedEffective = operatorCompleted ?? (opStatus === 'closed' ? Number(op.updatedAt ?? 0) || null : null);
    if (completedEffective != null && completedStart != null && completedEffective < completedStart) continue;
    if (completedEffective != null && completedEnd != null && completedEffective > completedEnd) continue;

    const code: WorkOrderStatusCode = deriveWorkOrderStatusCode({
      operationStatus: opStatus,
      dueDate,
      completedAt: opStatus === 'closed' ? completedEffective : null,
      completedDate: operatorCompleted,
      withdrawnAt: workOrderWithdrawnAt(payload),
      now,
    });
    if (statusCodes.size > 0 && !statusCodes.has(code)) continue;

    const kind = String(payload.workOrderKind ?? 'regular');
    if (kinds.size > 0 && !kinds.has(kind)) continue;

    let engineBrand = '';
    let engineBrandId = '';
    let engineNumber = '';
    let engineInternalNumber = '';
    let engineId = '';
    let firstWorkType = '';
    const lines = collectWorkOrderWorkLines(payload);
    for (const l of lines) {
      if (!engineBrand) engineBrand = String(l?.engineBrandName ?? '').trim();
      if (!engineBrandId) engineBrandId = String(l?.engineBrandId ?? '').trim();
      if (!engineNumber) engineNumber = String(l?.engineNumber ?? '').trim();
      if (!engineInternalNumber) engineInternalNumber = String((l as { engineInternalNumber?: unknown })?.engineInternalNumber ?? '').trim();
      if (!engineId) engineId = String(l?.engineId ?? '').trim();
      if (!firstWorkType) firstWorkType = String(l?.serviceName ?? '').trim();
    }
    // Наряд после #133 несёт двигатель в шапке (payload.assemblyEngineId), построчные
    // штампы могут отсутствовать — резолвим номер/марку из справочника, как список/печать.
    if (!engineId) engineId = String(resolveAssemblyEngineId(payload) ?? '').trim();
    if (engineId && (!engineNumber || !engineBrand || !engineBrandId || !engineInternalNumber)) {
      const eAttrs = snapshot.attrsByEntity.get(engineId) ?? {};
      if (!engineNumber) engineNumber = normalizeText(eAttrs.engine_number ?? eAttrs.number, '');
      // Старые наряды снимка внутреннего номера не несут — дотягиваем из карточки двигателя.
      if (!engineInternalNumber) {
        engineInternalNumber = formatEngineInternalNumber(
          normalizeText(eAttrs[ENGINE_INTERNAL_NUMBER_CODE], ''),
          eAttrs[ENGINE_INTERNAL_NUMBER_YEAR_CODE],
        );
      }
      if (!engineBrandId) engineBrandId = normalizeText(eAttrs.engine_brand_id, '');
      if (!engineBrand && engineBrandId) {
        engineBrand = normalizeText(brandNames.get(engineBrandId), '') || normalizeText(snapshot.attrsByEntity.get(engineBrandId)?.name, '');
      }
    }
    if (brandFilter.length > 0) {
      const matchId = engineBrandId !== '' && brandFilter.includes(engineBrandId);
      const matchName = engineBrand !== '' && brandFilterNamesLc.has(engineBrand.toLowerCase());
      if (!matchId && !matchName) continue;
    }
    const { id: counterpartyId, label: counterparty } = resolveCounterparty(engineId);
    if (counterpartyFilter.length > 0 && (!counterpartyId || !counterpartyFilter.includes(counterpartyId))) continue;
    // «Отгружен»: дата отправки двигателя заказчику + флаги для сводки подвала.
    const engineAttrsForShipping = engineId ? (snapshot.attrsByEntity.get(engineId) ?? {}) : {};
    const shippingState = resolveEngineShippingState(engineAttrsForShipping as Record<string, unknown>);
    const workType = firstWorkType || resolveWorkOrderTargetLabel(payload) || '';
    const workOrderNumber = toNumber(payload.workOrderNumber);

    if (numberQuery && !String(workOrderNumber).toLowerCase().includes(numberQuery.toLowerCase())) continue;
    if (engineNumberQuery && !engineNumber.toLowerCase().includes(engineNumberQuery.toLowerCase())) continue;
    if (workTypeQuery && !workType.toLowerCase().includes(workTypeQuery.toLowerCase())) continue;

    const respSlots = findWorkOrderSignatureSlots(payload.signatureBlocks, 'issue');
    const responsibleId = respSlots.map((s) => String(s.employeeId ?? '').trim()).find(Boolean) ?? '';
    if (responsibleFilter.length > 0 && !responsibleFilter.includes(responsibleId)) continue;
    const responsible = responsibleId ? normalizeText(employeeNames.get(responsibleId), '') : '';

    const crew = Array.isArray(payload.crew) ? payload.crew : [];
    const performers = crew
      .map((m: any) => String(m?.employeeName ?? '').trim() || normalizeText(employeeNames.get(String(m?.employeeId ?? '')), ''))
      .filter(Boolean)
      .join(', ');

    rows.push({
      orderDate,
      workOrderNumber,
      kindLabel: WORK_ORDER_KIND_LABELS[kind as keyof typeof WORK_ORDER_KIND_LABELS] ?? kind,
      statusCode: code,
      statusLabel: WORK_ORDER_STATUS_LABELS[code],
      startDate: payload.startDate != null && Number(payload.startDate) > 0 ? Number(payload.startDate) : null,
      dueDate: dueDate ?? null,
      completedDate: completedEffective ?? null,
      workType,
      engineBrand,
      engineNumber,
      engineInternalNumber,
      counterparty,
      performers,
      crewCount: crew.length,
      responsible,
      amountRub: Math.max(0, toNumber(payload.totalAmountRub)),
      shippedDate: shippingState.shippingDate ?? null,
      customerSent: shippingState.customerSent,
      customerAccepted: shippingState.customerAccepted,
    });
  }

  const sorted = sortWorkOrdersReportRows(rows, sortBy, sortDir);
  const columns = selectWorkOrdersReportColumns(columnKeys);
  const preset = getPreset('work_orders_report');
  const chips = buildWorkOrdersReportChips({
    issuedStart,
    issuedEnd,
    dueStart,
    dueEnd,
    completedStart,
    completedEnd,
    statusCodes,
    kinds,
    responsibleFilter,
    brandFilter,
    counterpartyFilter,
    numberQuery,
    engineNumberQuery,
    workTypeQuery,
    sortBy,
    sortDir,
    employeeNames,
    brandNames,
    counterpartyNames,
    now,
  });

  return {
    ok: true,
    presetId: 'work_orders_report',
    title: preset.title,
    subtitle: chips.join(' | '),
    columns,
    rows: sorted,
    totals: {
      orders: sorted.length,
      amountRub: sorted.reduce((acc, row) => acc + toNumber(row.amountRub), 0),
    },
    workOrdersStatusSummary: computeWorkOrdersStatusSummary(sorted, { byBrand: summaryByBrand }),
    generatedAt: Date.now(),
  };
}

/** Чипы-сводка активных фильтров/сортировки для подзаголовка печатной формы отчёта по нарядам. */
export function buildWorkOrdersReportChips(a: {
  issuedStart: number | null;
  issuedEnd: number | null;
  dueStart: number | null;
  dueEnd: number | null;
  completedStart: number | null;
  completedEnd: number | null;
  statusCodes: Set<string>;
  kinds: Set<string>;
  responsibleFilter: string[];
  brandFilter: string[];
  counterpartyFilter: string[];
  numberQuery: string;
  engineNumberQuery: string;
  workTypeQuery: string;
  sortBy: string;
  sortDir: 'asc' | 'desc';
  employeeNames: Map<string, string>;
  brandNames: Map<string, string>;
  counterpartyNames: Map<string, string>;
  now: number;
}): string[] {
  const chips: string[] = [];
  const rangeChip = (label: string, s: number | null, e: number | null) => {
    if (s == null && e == null) return;
    if (s != null && e != null) chips.push(`${label}: ${formatMoscowDate(s)}–${formatMoscowDate(e)}`);
    else if (s != null) chips.push(`${label}: от ${formatMoscowDate(s)}`);
    else if (e != null) chips.push(`${label}: до ${formatMoscowDate(e)}`);
  };
  rangeChip('Выдан', a.issuedStart, a.issuedEnd);
  rangeChip('Срок', a.dueStart, a.dueEnd);
  rangeChip('Выполнен', a.completedStart, a.completedEnd);
  const statusLabels = [...a.statusCodes].map((c) => WORK_ORDER_STATUS_LABELS[c as WorkOrderStatusCode] ?? c);
  if (statusLabels.length) chips.push(`Статус: ${statusLabels.join(', ')}`);
  const kindLabels = [...a.kinds].map((k) => WORK_ORDER_KIND_LABELS[k as keyof typeof WORK_ORDER_KIND_LABELS] ?? k);
  if (kindLabels.length) chips.push(`Тип: ${kindLabels.join(', ')}`);
  if (a.responsibleFilter.length) {
    const names = a.responsibleFilter.map((id) => a.employeeNames.get(id) ?? '').filter(Boolean);
    chips.push(`Ответственный: ${names.length ? names.join(', ') : `${a.responsibleFilter.length} выбрано`}`);
  }
  if (a.brandFilter.length) {
    const names = a.brandFilter.map((id) => a.brandNames.get(id) ?? '').filter(Boolean);
    chips.push(`Марки: ${names.length ? names.join(', ') : `${a.brandFilter.length} выбрано`}`);
  }
  if (a.counterpartyFilter.length) {
    const names = a.counterpartyFilter.map((id) => a.counterpartyNames.get(id) ?? '').filter(Boolean);
    chips.push(`Контрагент: ${names.length ? names.join(', ') : `${a.counterpartyFilter.length} выбрано`}`);
  }
  if (a.numberQuery) chips.push(`№ наряда: ${a.numberQuery}`);
  if (a.engineNumberQuery) chips.push(`№ дв.: ${a.engineNumberQuery}`);
  if (a.workTypeQuery) chips.push(`Виды работ: ${a.workTypeQuery}`);
  const SORT_LABELS: Record<string, string> = {
    orderDate: 'по дате выдачи',
    status: 'по статусу',
    workOrderNumber: 'по № наряда',
    dueDate: 'по сроку',
    completedDate: 'по дате выполнения',
    engineBrand: 'по марке',
    amountRub: 'по сумме',
  };
  chips.push(`Сортировка: ${SORT_LABELS[a.sortBy] ?? a.sortBy} ${a.sortDir === 'asc' ? '↑' : '↓'}`);
  chips.push(`Сформировано: ${formatMoscowDate(a.now)}`);
  return chips;
}

export async function buildWorkOrderPayrollReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const employeeFilter = asArray(filters?.employeeIds);
  const snapshot = await loadSnapshot(db);
  const personnelByEmployeeId = new Map<string, string>();
  for (const employeeId of getIdsByType(snapshot, 'employee')) {
    const attrs = snapshot.attrsByEntity.get(employeeId) ?? {};
    const pn = normalizeText(attrs.personnel_number, '');
    if (pn) personnelByEmployeeId.set(employeeId, pn);
  }
  const sourceOps = await db
    .select()
    .from(operations)
    .where(and(isNull(operations.deletedAt), eq(operations.operationType, 'work_order'), lte(operations.createdAt, period.endMs)))
    .limit(120_000);

  const rows: Array<Record<string, ReportCellValue>> = [];
  const totalsByEmployee = new Map<string, { employeeName: string; personnelNumber: string; workOrders: number; amountRub: number }>();
  const seenEmployeeWorkOrderKeys = new Set<string>();
  const totalWorkOrderKeys = new Set<string>();
  const crewEmployeeIds = new Set<string>();

  for (const op of sourceOps as any[]) {
    const payload = safeJsonParse(String(op.metaJson ?? '')) as any;
    if (!payload || payload.kind !== 'work_order') continue;
    const orderDate = Number(payload.orderDate ?? op.performedAt ?? op.createdAt ?? 0);
    if (period.startMs != null && orderDate < period.startMs) continue;
    if (orderDate > period.endMs) continue;

    const crew = normalizeWorkOrderReportCrew(payload, personnelByEmployeeId);
    if (crew.length === 0) continue;
    const workOrderKey = String(op.id ?? payload.operationId ?? `${payload.workOrderNumber ?? 'work-order'}-${orderDate}`);

    for (const member of crew) {
      if (employeeFilter.length > 0 && (!member.employeeId || !employeeFilter.includes(member.employeeId))) continue;
      if (member.employeeId) crewEmployeeIds.add(member.employeeId);
      const employeeKey = member.employeeId || `name:${member.employeeName.toLowerCase()}`;
      const employeeLabel = member.employeeName || '(не указан)';
      const amountRub = Math.max(0, toNumber(member.payoutRub));
      rows.push({
        employeeName: employeeLabel,
        personnelNumber: member.personnelNumber || null,
        workOrderNumber: toNumber(payload.workOrderNumber) || null,
        orderDate,
        ktu: Math.max(0.01, toNumber(member.ktu) || 1),
        amountRub,
      });
      const employeeTotals = totalsByEmployee.get(employeeKey) ?? { employeeName: employeeLabel, personnelNumber: member.personnelNumber, workOrders: 0, amountRub: 0 };
      if (!employeeTotals.employeeName || employeeTotals.employeeName === '(не указан)') employeeTotals.employeeName = employeeLabel;
      if (!employeeTotals.personnelNumber && member.personnelNumber) employeeTotals.personnelNumber = member.personnelNumber;
      employeeTotals.amountRub += amountRub;
      const employeeWorkOrderKey = `${employeeKey}::${workOrderKey}`;
      if (!seenEmployeeWorkOrderKeys.has(employeeWorkOrderKey)) {
        employeeTotals.workOrders += 1;
        seenEmployeeWorkOrderKeys.add(employeeWorkOrderKey);
      }
      totalsByEmployee.set(employeeKey, employeeTotals);
      totalWorkOrderKeys.add(workOrderKey);
    }
  }

  rows.sort(
    (a, b) =>
      String(a.employeeName ?? '').localeCompare(String(b.employeeName ?? ''), 'ru') ||
      toNumber(b.orderDate) - toNumber(a.orderDate) ||
      toNumber(b.workOrderNumber) - toNumber(a.workOrderNumber),
  );

  const payrollAccrualTotalRub = Math.round(rows.reduce((acc, row) => acc + toNumber(row.amountRub), 0) * 100) / 100;

  const payrollWorkLines: Array<{
    orderDateMs: number;
    workOrderNumber: number | null;
    workLabel: string;
    qty: number;
    priceRub: number;
    amountRub: number;
  }> = [];
  const seenWorkLineOps = new Set<string>();

  for (const op of sourceOps as any[]) {
    const payload = safeJsonParse(String(op.metaJson ?? '')) as any;
    if (!payload || payload.kind !== 'work_order') continue;
    const orderDate = Number(payload.orderDate ?? op.performedAt ?? op.createdAt ?? 0);
    if (period.startMs != null && orderDate < period.startMs) continue;
    if (orderDate > period.endMs) continue;

    const crew = normalizeWorkOrderReportCrew(payload, personnelByEmployeeId);
    if (crew.length === 0) continue;
    const hasIncludedMember = crew.some(
      (member) => employeeFilter.length === 0 || (member.employeeId && employeeFilter.includes(member.employeeId)),
    );
    if (!hasIncludedMember) continue;

    const opKey = String(op.id ?? payload.operationId ?? `${payload.workOrderNumber ?? 'wo'}-${orderDate}`);
    if (seenWorkLineOps.has(opKey)) continue;
    seenWorkLineOps.add(opKey);

    const works = normalizeWorkOrderReportLines(payload);
    const fallbackWorkLabel = resolveWorkOrderTargetLabel(payload);
    const normalizedWorks =
      works.length > 0
        ? works
        : [
            {
              serviceName: fallbackWorkLabel || '(без названия)',
              qty: 1,
              amountRub: Math.max(0, toNumber(payload.totalAmountRub)),
            },
          ];

    const woNum = toNumber(payload.workOrderNumber) || null;
    for (const work of normalizedWorks) {
      const qty = Math.max(0, toNumber(work.qty));
      const amountRub = Math.max(0, toNumber(work.amountRub));
      const priceRub = qty > 0 ? amountRub / qty : 0;
      payrollWorkLines.push({
        orderDateMs: orderDate,
        workOrderNumber: woNum,
        workLabel: normalizeText(work?.serviceName, '(без названия)'),
        qty,
        priceRub,
        amountRub,
      });
    }
  }

  payrollWorkLines.sort(
    (a, b) =>
      b.orderDateMs - a.orderDateMs ||
      (b.workOrderNumber ?? 0) - (a.workOrderNumber ?? 0) ||
      String(a.workLabel).localeCompare(String(b.workLabel), 'ru'),
  );

  // Подписи: бригада (все участники нарядов периода) + 3 роли по должности из справочника
  // сотрудников. resolveWorkOrderSignatureDecryptions сам выводит «Фамилия И.О.» из full_name.
  const signatureEmployees: WorkOrderSignatureEmployee[] = getIdsByType(snapshot, 'employee').map((employeeId) => {
    const attrs = snapshot.attrsByEntity.get(employeeId) ?? {};
    return {
      id: employeeId,
      fullName: normalizeText(attrs.full_name, '') || null,
      position: normalizeText(attrs.position ?? attrs.role, '') || null,
      employmentStatus: normalizeText(attrs.employment_status, '') || null,
    };
  });
  const payrollSignatures = resolveWorkOrderSignatureDecryptions({
    crewEmployeeIds: Array.from(crewEmployeeIds),
    employees: signatureEmployees,
  });

  const preset = getPreset('work_order_payroll');
  return {
    ok: true,
    presetId: 'work_order_payroll',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    payrollWorkLines,
    payrollAccrualTotalRub,
    payrollSignatures,
    totals: {
      employees: totalsByEmployee.size,
      workOrders: totalWorkOrderKeys.size,
      amountRub: payrollAccrualTotalRub,
    },
    totalsByGroup: Array.from(totalsByEmployee.entries())
      .map(([, totals]) => ({
        group: totals.employeeName || '(не указан)',
        totals: {
          workOrders: totals.workOrders,
          amountRub: Math.round(totals.amountRub * 100) / 100,
        },
      }))
      .sort((a, b) => String(a.group).localeCompare(String(b.group), 'ru')),
    generatedAt: Date.now(),
  };
}

export async function buildWorkOrderPayrollSummaryReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const employeeFilter = asArray(filters?.employeeIds);
  const departmentFilter = asArray(filters?.departmentIds);
  const snapshot = await loadSnapshot(db);
  const departmentOptions = new Map(buildOptions(snapshot, 'department').map((o) => [o.value, o.label] as const));
  const employeeMetaById = new Map<string, { employeeName: string; personnelNumber: string; departmentId: string; departmentName: string }>();

  for (const employeeId of getIdsByType(snapshot, 'employee')) {
    const attrs = snapshot.attrsByEntity.get(employeeId) ?? {};
    const departmentId = normalizeText(attrs.department_id, '');
    const departmentName = departmentOptions.get(departmentId) ?? normalizeText(attrs.department, departmentId || '(не указано)');
    const employeeName = normalizeText(
      attrs.full_name,
      [normalizeText(attrs.last_name, ''), normalizeText(attrs.first_name, ''), normalizeText(attrs.middle_name, '')]
        .filter(Boolean)
        .join(' ')
        .trim() || employeeId,
    );
    const personnelNumber = normalizeText(attrs.personnel_number, '');
    employeeMetaById.set(employeeId, { employeeName, personnelNumber, departmentId, departmentName });
  }

  const personnelByEmployeeId = new Map<string, string>();
  for (const [eid, meta] of employeeMetaById) {
    if (meta.personnelNumber) personnelByEmployeeId.set(eid, meta.personnelNumber);
  }

  const sourceOps = await db
    .select()
    .from(operations)
    .where(and(isNull(operations.deletedAt), eq(operations.operationType, 'work_order'), lte(operations.createdAt, period.endMs)))
    .limit(120_000);

  const totalWorkOrderKeys = new Set<string>();
  const buckets = new Map<string, PayrollSummaryBucket>();

  for (const op of sourceOps as any[]) {
    const payload = safeJsonParse(String(op.metaJson ?? '')) as any;
    if (!payload || payload.kind !== 'work_order') continue;
    const orderDate = Number(payload.orderDate ?? op.performedAt ?? op.createdAt ?? 0);
    if (period.startMs != null && orderDate < period.startMs) continue;
    if (orderDate > period.endMs) continue;

    const crew = normalizeWorkOrderReportCrew(payload, personnelByEmployeeId);
    if (crew.length === 0) continue;
    const workOrderKey = String(op.id ?? payload.operationId ?? `${payload.workOrderNumber ?? 'work-order'}-${orderDate}`);

    for (const member of crew) {
      if (employeeFilter.length > 0 && (!member.employeeId || !employeeFilter.includes(member.employeeId))) continue;
      const meta = member.employeeId ? employeeMetaById.get(member.employeeId) : undefined;
      const departmentId = meta?.departmentId ?? '';
      if (departmentFilter.length > 0 && (!departmentId || !departmentFilter.includes(departmentId))) continue;

      const departmentName = meta?.departmentName || '(не указано)';
      const employeeName = normalizeText(member.employeeName, meta?.employeeName || '(не указан)');
      const personnelNumber = member.personnelNumber || meta?.personnelNumber || '';
      const employeeKey = member.employeeId || `name:${employeeName.toLowerCase()}`;
      const bucketKey = `${departmentName}::${employeeKey}`;
      const bucket = buckets.get(bucketKey) ?? {
        employeeName,
        personnelNumber,
        departmentName,
        lines: 0,
        totalKtu: 0,
        amountRub: 0,
        workOrderKeys: new Set<string>(),
      };
      if (!bucket.personnelNumber && personnelNumber) bucket.personnelNumber = personnelNumber;
      bucket.lines += 1;
      bucket.totalKtu += Math.max(0.01, toNumber(member.ktu) || 1);
      bucket.amountRub += Math.max(0, toNumber(member.payoutRub));
      bucket.workOrderKeys.add(workOrderKey);
      buckets.set(bucketKey, bucket);
      totalWorkOrderKeys.add(workOrderKey);
    }
  }

  const rows: Array<Record<string, ReportCellValue>> = Array.from(buckets.values())
    .map((bucket) => {
      const workOrders = bucket.workOrderKeys.size;
      const amountRub = Math.round(bucket.amountRub * 100) / 100;
      const totalKtu = Math.round(bucket.totalKtu * 100) / 100;
      return {
        departmentName: bucket.departmentName || '(не указано)',
        employeeName: bucket.employeeName || '(не указан)',
        personnelNumber: bucket.personnelNumber || null,
        workOrders,
        lines: bucket.lines,
        totalKtu,
        avgKtu: bucket.lines > 0 ? Math.round((bucket.totalKtu / bucket.lines) * 100) / 100 : 0,
        amountRub,
        avgWorkOrderAmountRub: workOrders > 0 ? Math.round((bucket.amountRub / workOrders) * 100) / 100 : 0,
      };
    })
    .sort(
      (a, b) =>
        String(a.departmentName ?? '').localeCompare(String(b.departmentName ?? ''), 'ru') ||
        String(a.employeeName ?? '').localeCompare(String(b.employeeName ?? ''), 'ru'),
    );

  const totalsByDepartment = new Map<string, { employees: number; workOrders: number; amountRub: number }>();
  for (const row of rows) {
    const departmentName = normalizeText(row.departmentName, '(не указано)');
    const current = totalsByDepartment.get(departmentName) ?? { employees: 0, workOrders: 0, amountRub: 0 };
    current.employees += 1;
    current.workOrders += Math.max(0, toNumber(row.workOrders));
    current.amountRub += Math.max(0, toNumber(row.amountRub));
    totalsByDepartment.set(departmentName, current);
  }

  const preset = getPreset('work_order_payroll_summary');
  return {
    ok: true,
    presetId: 'work_order_payroll_summary',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    totals: {
      employees: rows.length,
      workOrders: totalWorkOrderKeys.size,
      lines: rows.reduce((acc, row) => acc + Math.max(0, toNumber(row.lines)), 0),
      totalKtu: Math.round(rows.reduce((acc, row) => acc + Math.max(0, toNumber(row.totalKtu)), 0) * 100) / 100,
      amountRub: Math.round(rows.reduce((acc, row) => acc + Math.max(0, toNumber(row.amountRub)), 0) * 100) / 100,
      avgWorkOrderAmountRub:
        totalWorkOrderKeys.size > 0
          ? Math.round(
              (rows.reduce((acc, row) => acc + Math.max(0, toNumber(row.amountRub)), 0) / totalWorkOrderKeys.size) * 100,
            ) / 100
          : 0,
    },
    totalsByGroup: Array.from(totalsByDepartment.entries())
      .map(([departmentName, totals]) => ({
        group: departmentName,
        totals: {
          employees: totals.employees,
          workOrders: totals.workOrders,
          amountRub: Math.round(totals.amountRub * 100) / 100,
        },
      }))
      .sort((a, b) => String(a.group).localeCompare(String(b.group), 'ru')),
    generatedAt: Date.now(),
  };
}

