import { isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  StockMovementType,
  nextIssueDates,
  resolveEmployeeNorms,
  resolveGroupNorms,
  reversalMovementType,
  upcomingIssues,
  type PpeAbsenceInput,
  type ReportCellValue,
  type ReportPresetFilters,
  type ReportPresetPreviewResult,
} from '@matricarmz/shared';

import {
  erpDocumentHeaders,
  erpEmployeeCards,
  erpNomenclature,
  erpRegStockBalance,
  erpRegStockMovements,
  ppeAbsences,
  ppeCardNorms,
  ppeGroupMembers,
  ppeGroupNorms,
  ppeGroups,
  ppeIssueCards,
  ppeIssueEntries,
  ppeNormLines,
  ppeNormSets,
} from '../../../database/schema.js';
import { getPreset, getWarehouseLocationsForReport, loadSnapshot, type ReportBuildContext } from '../context.js';
import { readPeriod } from '../format.js';
import { movementTypeLabel } from './warehouse.js';

const HUMAN_DASH = '—';
const REQUEST_HORIZON_DAYS = 90;

const STATUS_RU: Record<string, string> = {
  overdue: 'просрочено',
  dueSoon: 'скоро выдавать',
  ok: 'в сроке',
  neverIssued: 'не выдавалось',
};

type PpeSnapshot = {
  nomName: Map<string, string>;
  nomParent: Map<string, string | null>;
  nomCategory: Map<string, string>;
  empName: Map<string, string>;
  sets: Array<{ id: string; name: string; postTitle: string | null }>;
  linesBySet: Map<string, Array<{ nomenclatureId: string; qty: number; wearMonths: number }>>;
  cards: Array<{ id: string; employeeId: string; closedAt: number | null }>;
  normsByCard: Map<string, string[]>;
  entriesByCard: Map<string, Array<{ nomenclatureId: string; qty: number; issuedAt: number; documentId: string | null }>>;
  groupIdsByEmployee: Map<string, string[]>;
  groupNormSetIdsByGroup: Map<string, string[]>;
  absencesByEmployee: Map<string, PpeAbsenceInput[]>;
};

async function loadPpeSnapshot(db: BetterSQLite3Database): Promise<PpeSnapshot> {
  const [noms, emps, sets, lines, cards, cardNorms, entries, groupRows, members, groupNorms, absences] = await Promise.all([
    db.select().from(erpNomenclature).where(isNull(erpNomenclature.deletedAt)).limit(60_000),
    db.select().from(erpEmployeeCards).where(isNull(erpEmployeeCards.deletedAt)).limit(20_000),
    db.select().from(ppeNormSets).where(isNull(ppeNormSets.deletedAt)).limit(5_000),
    db.select().from(ppeNormLines).where(isNull(ppeNormLines.deletedAt)).limit(60_000),
    db.select().from(ppeIssueCards).where(isNull(ppeIssueCards.deletedAt)).limit(20_000),
    db.select().from(ppeCardNorms).where(isNull(ppeCardNorms.deletedAt)).limit(20_000),
    db.select().from(ppeIssueEntries).where(isNull(ppeIssueEntries.deletedAt)).limit(200_000),
    db.select().from(ppeGroups).where(isNull(ppeGroups.deletedAt)).limit(5_000),
    db.select().from(ppeGroupMembers).where(isNull(ppeGroupMembers.deletedAt)).limit(50_000),
    db.select().from(ppeGroupNorms).where(isNull(ppeGroupNorms.deletedAt)).limit(20_000),
    db.select().from(ppeAbsences).where(isNull(ppeAbsences.deletedAt)).limit(50_000),
  ]);
  const nomName = new Map<string, string>();
  const nomParent = new Map<string, string | null>();
  const nomCategory = new Map<string, string>();
  for (const n of noms as any[]) {
    nomName.set(String(n.id), String(n.name ?? n.id));
    nomParent.set(String(n.id), n.parentNomenclatureId == null ? null : String(n.parentNomenclatureId));
    nomCategory.set(String(n.id), String(n.category ?? ''));
  }
  const empName = new Map<string, string>();
  for (const e of emps as any[]) empName.set(String(e.id), String(e.fullName ?? e.id));
  const linesBySet = new Map<string, Array<{ nomenclatureId: string; qty: number; wearMonths: number }>>();
  for (const l of lines as any[]) {
    const arr = linesBySet.get(String(l.normSetId)) ?? [];
    arr.push({ nomenclatureId: String(l.nomenclatureId), qty: Number(l.qty), wearMonths: Number(l.wearMonths) });
    linesBySet.set(String(l.normSetId), arr);
  }
  const normsByCard = new Map<string, string[]>();
  for (const cn of cardNorms as any[]) {
    const arr = normsByCard.get(String(cn.cardId)) ?? [];
    arr.push(String(cn.normSetId));
    normsByCard.set(String(cn.cardId), arr);
  }
  const entriesByCard = new Map<string, Array<{ nomenclatureId: string; qty: number; issuedAt: number; documentId: string | null }>>();
  for (const v of entries as any[]) {
    const arr = entriesByCard.get(String(v.cardId)) ?? [];
    arr.push({
      nomenclatureId: String(v.nomenclatureId),
      qty: Number(v.qty),
      issuedAt: Number(v.issuedAt),
      documentId: v.documentId == null ? null : String(v.documentId),
    });
    entriesByCard.set(String(v.cardId), arr);
  }
  const activeGroupIds = new Set((groupRows as any[]).map((g) => String(g.id)));
  const groupIdsByEmployee = new Map<string, string[]>();
  for (const m of members as any[]) {
    const groupId = String(m.groupId);
    if (!activeGroupIds.has(groupId)) continue;
    const employeeId = String(m.employeeId);
    groupIdsByEmployee.set(employeeId, [...(groupIdsByEmployee.get(employeeId) ?? []), groupId]);
  }
  const groupNormSetIdsByGroup = new Map<string, string[]>();
  for (const gn of groupNorms as any[]) {
    const groupId = String(gn.groupId);
    if (!activeGroupIds.has(groupId)) continue;
    groupNormSetIdsByGroup.set(groupId, [...(groupNormSetIdsByGroup.get(groupId) ?? []), String(gn.normSetId)]);
  }
  const absencesByEmployee = new Map<string, PpeAbsenceInput[]>();
  for (const a of absences as any[]) {
    const employeeId = String(a.employeeId);
    absencesByEmployee.set(employeeId, [
      ...(absencesByEmployee.get(employeeId) ?? []),
      { fromMs: Number(a.fromMs), toMs: Number(a.toMs) },
    ]);
  }
  return {
    nomName,
    nomParent,
    nomCategory,
    empName,
    sets: (sets as any[]).map((s) => ({ id: String(s.id), name: String(s.name), postTitle: s.postTitle == null ? null : String(s.postTitle) })),
    linesBySet,
    cards: (cards as any[]).map((c) => ({ id: String(c.id), employeeId: String(c.employeeId), closedAt: c.closedAt == null ? null : Number(c.closedAt) })),
    normsByCard,
    entriesByCard,
    groupIdsByEmployee,
    groupNormSetIdsByGroup,
    absencesByEmployee,
  };
}

/**
 * Наборы карточки с учётом групп: личные ∪ нормы групп сотрудника (фаза 2, транзитивная модель —
 * отзыв у группы отзывает у людей, поэтому отчёты обязаны видеть те же нормы, что карточка).
 */
function normSetIdsForCard(snap: PpeSnapshot, card: { id: string; employeeId: string }): string[] {
  const groupIds = snap.groupIdsByEmployee.get(card.employeeId) ?? [];
  const groupNorms: Array<{ groupId: string; normSetId: string }> = [];
  for (const groupId of groupIds) {
    for (const normSetId of snap.groupNormSetIdsByGroup.get(groupId) ?? []) groupNorms.push({ groupId, normSetId });
  }
  return resolveGroupNorms({
    personalNormSetIds: snap.normsByCard.get(card.id) ?? [],
    memberGroupIds: groupIds,
    groupNorms,
  });
}

function cardNormLines(snap: PpeSnapshot, card: { id: string; employeeId: string }) {
  const out: Array<{ normSetId: string; nomenclatureId: string; qty: number; wearMonths: number }> = [];
  for (const setId of normSetIdsForCard(snap, card)) {
    for (const l of snap.linesBySet.get(setId) ?? []) out.push({ normSetId: setId, ...l });
  }
  return out;
}

function absenceSpans(snap: PpeSnapshot, employeeId: string): PpeAbsenceInput[] {
  return snap.absencesByEmployee.get(employeeId) ?? [];
}

function matchQuery(haystack: string, q: string): boolean {
  return !q || haystack.toLowerCase().includes(q);
}

export async function buildPpeSummarySheetReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const snap = await loadPpeSnapshot(db);
  const q = String((filters as any)?.nameQuery ?? '').trim().toLowerCase();
  const now = Date.now();
  const rows: Array<Record<string, ReportCellValue>> = [];
  for (const card of snap.cards) {
    const employee = snap.empName.get(card.employeeId) ?? HUMAN_DASH;
    const merged = resolveEmployeeNorms(cardNormLines(snap, card));
    const plan = nextIssueDates(merged, snap.entriesByCard.get(card.id) ?? [], now, undefined, absenceSpans(snap, card.employeeId));
    const issuedByNom = new Map<string, number>();
    for (const e of snap.entriesByCard.get(card.id) ?? []) {
      issuedByNom.set(e.nomenclatureId, (issuedByNom.get(e.nomenclatureId) ?? 0) + e.qty);
    }
    for (const p of plan) {
      const nom = snap.nomName.get(p.nomenclatureId) ?? HUMAN_DASH;
      if (!matchQuery(`${employee} ${nom}`, q)) continue;
      rows.push({
        employee,
        nomenclature: nom,
        normQty: p.qty,
        wearMonths: p.wearMonths,
        issuedQty: issuedByNom.get(p.nomenclatureId) ?? 0,
        lastIssued: p.lastIssuedAt ?? HUMAN_DASH,
        nextDue: p.nextDueAt ?? HUMAN_DASH,
        status: STATUS_RU[p.status] ?? p.status,
      });
    }
  }
  rows.sort((a, b) => String(a.employee).localeCompare(String(b.employee), 'ru') || String(a.nomenclature).localeCompare(String(b.nomenclature), 'ru'));
  const preset = getPreset('ppe_summary_sheet');
  return {
    ok: true,
    presetId: 'ppe_summary_sheet',
    title: preset.title,
    subtitle: `Сотрудников с карточками: ${snap.cards.length}`,
    columns: [
      { key: 'employee', label: 'Сотрудник' },
      { key: 'nomenclature', label: 'Позиция СИЗ' },
      { key: 'normQty', label: 'Норма (шт)', kind: 'number', align: 'right' },
      { key: 'wearMonths', label: 'Носка (мес)', kind: 'number', align: 'right' },
      { key: 'issuedQty', label: 'Выдано всего (шт)', kind: 'number', align: 'right' },
      { key: 'lastIssued', label: 'Последняя выдача', kind: 'date' },
      { key: 'nextDue', label: 'Следующая выдача', kind: 'date' },
      { key: 'status', label: 'Состояние' },
    ],
    rows,
    totals: { lines: rows.length, employees: snap.cards.length },
    generatedAt: Date.now(),
  };
}

export async function buildPpeBySizeReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const snap = await loadPpeSnapshot(db);
  const q = String((filters as any)?.nameQuery ?? '').trim().toLowerCase();
  const needByNom = new Map<string, Set<string>>();
  for (const card of snap.cards) {
    for (const l of cardNormLines(snap, card)) {
      let set = needByNom.get(l.nomenclatureId);
      if (!set) {
        set = new Set();
        needByNom.set(l.nomenclatureId, set);
      }
      set.add(card.employeeId);
    }
  }
  const issuedByNom = new Map<string, number>();
  for (const list of snap.entriesByCard.values()) {
    for (const e of list) issuedByNom.set(e.nomenclatureId, (issuedByNom.get(e.nomenclatureId) ?? 0) + e.qty);
  }
  const rows: Array<Record<string, ReportCellValue>> = [];
  for (const [nomId, employees] of needByNom) {
    const known = snap.nomName.get(nomId);
    const parentId = snap.nomParent.get(nomId);
    const base = known == null ? HUMAN_DASH : parentId ? (snap.nomName.get(parentId) ?? HUMAN_DASH) : known;
    const size = known == null ? HUMAN_DASH : parentId ? known : HUMAN_DASH;
    if (!matchQuery(`${base} ${size}`, q)) continue;
    rows.push({
      base,
      size,
      employeesCount: employees.size,
      issuedQty: issuedByNom.get(nomId) ?? 0,
    });
  }
  rows.sort((a, b) => String(a.base).localeCompare(String(b.base), 'ru') || String(a.size).localeCompare(String(b.size), 'ru'));
  const preset = getPreset('ppe_by_size');
  return {
    ok: true,
    presetId: 'ppe_by_size',
    title: preset.title,
    subtitle: `Позиций в нормах: ${rows.length}`,
    columns: [
      { key: 'base', label: 'Модель' },
      { key: 'size', label: 'Размер' },
      { key: 'employeesCount', label: 'Сотрудников', kind: 'number', align: 'right' },
      { key: 'issuedQty', label: 'Выдано всего (шт)', kind: 'number', align: 'right' },
    ],
    rows,
    totals: { lines: rows.length },
    generatedAt: Date.now(),
  };
}

export async function buildPpeUnissuedReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const snap = await loadPpeSnapshot(db);
  const q = String((filters as any)?.nameQuery ?? '').trim().toLowerCase();
  const onlyOverdue = Boolean((filters as any)?.onlyOverdue ?? true);
  const now = Date.now();
  const rows: Array<Record<string, ReportCellValue>> = [];
  for (const card of snap.cards) {
    if (card.closedAt != null) continue;
    const employee = snap.empName.get(card.employeeId) ?? HUMAN_DASH;
    const merged = resolveEmployeeNorms(cardNormLines(snap, card));
    for (const p of nextIssueDates(merged, snap.entriesByCard.get(card.id) ?? [], now, undefined, absenceSpans(snap, card.employeeId))) {
      if (onlyOverdue && p.status !== 'overdue' && p.status !== 'neverIssued') continue;
      const nom = snap.nomName.get(p.nomenclatureId) ?? HUMAN_DASH;
      if (!matchQuery(`${employee} ${nom}`, q)) continue;
      rows.push({
        employee,
        nomenclature: nom,
        normQty: p.qty,
        lastIssued: p.lastIssuedAt ?? HUMAN_DASH,
        nextDue: p.nextDueAt ?? HUMAN_DASH,
        overdueDays: p.nextDueAt == null ? HUMAN_DASH : Math.max(0, Math.floor((now - p.nextDueAt) / 86_400_000)),
        status: STATUS_RU[p.status] ?? p.status,
      });
    }
  }
  rows.sort((a, b) => String(a.employee).localeCompare(String(b.employee), 'ru') || String(a.nomenclature).localeCompare(String(b.nomenclature), 'ru'));
  const preset = getPreset('ppe_unissued');
  return {
    ok: true,
    presetId: 'ppe_unissued',
    title: preset.title,
    subtitle: `Невыданного позиций: ${rows.length}`,
    columns: [
      { key: 'employee', label: 'Сотрудник' },
      { key: 'nomenclature', label: 'Позиция СИЗ' },
      { key: 'normQty', label: 'Норма (шт)', kind: 'number', align: 'right' },
      { key: 'lastIssued', label: 'Последняя выдача', kind: 'date' },
      { key: 'nextDue', label: 'Срок выдачи', kind: 'date' },
      { key: 'overdueDays', label: 'Дней просрочки', kind: 'number', align: 'right' },
      { key: 'status', label: 'Состояние' },
    ],
    rows,
    totals: { lines: rows.length },
    generatedAt: Date.now(),
  };
}

export async function buildPpeStockListReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
  ctx?: ReportBuildContext,
): Promise<ReportPresetPreviewResult> {
  const snap = await loadPpeSnapshot(db);
  const locations = await getWarehouseLocationsForReport(db, ctx);
  const q = String((filters as any)?.nameQuery ?? '').trim().toLowerCase();
  const warehouseIds = new Set((Array.isArray((filters as any)?.warehouseIds) ? (filters as any).warehouseIds : []).map(String));
  const balances = await db.select().from(erpRegStockBalance).limit(200_000);
  const rows: Array<Record<string, ReportCellValue>> = [];
  for (const b of balances as any[]) {
    const nomId = b.nomenclatureId == null ? null : String(b.nomenclatureId);
    if (!nomId) continue;
    if (snap.nomCategory.get(nomId) !== 'workwear') continue;
    const nom = snap.nomName.get(nomId);
    if (!nom) continue;
    const wh = b.warehouseLocationId == null ? null : String(b.warehouseLocationId);
    if (warehouseIds.size > 0 && (wh == null || !warehouseIds.has(wh))) continue;
    if (!matchQuery(nom, q)) continue;
    rows.push({
      nomenclature: nom,
      warehouse: wh == null ? HUMAN_DASH : (locations.get(wh)?.name ?? HUMAN_DASH),
      qty: Number(b.qty ?? 0),
      reservedQty: Number(b.reservedQty ?? 0),
    });
  }
  rows.sort((a, b) => String(a.nomenclature).localeCompare(String(b.nomenclature), 'ru') || String(a.warehouse).localeCompare(String(b.warehouse), 'ru'));
  const preset = getPreset('ppe_stock_list');
  return {
    ok: true,
    presetId: 'ppe_stock_list',
    title: preset.title,
    subtitle: `Позиций на складе: ${rows.length}`,
    columns: [
      { key: 'nomenclature', label: 'Позиция СИЗ' },
      { key: 'warehouse', label: 'Склад' },
      { key: 'qty', label: 'Остаток', kind: 'number', align: 'right' },
      { key: 'reservedQty', label: 'Резерв', kind: 'number', align: 'right' },
    ],
    rows,
    totals: { lines: rows.length, totalQty: rows.reduce((s, r) => s + Number(r.qty ?? 0), 0) },
    generatedAt: Date.now(),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

async function documentNoById(db: BetterSQLite3Database): Promise<Map<string, string>> {
  const headers = await db
    .select({ id: erpDocumentHeaders.id, docNo: erpDocumentHeaders.docNo })
    .from(erpDocumentHeaders)
    .limit(200_000);
  const map = new Map<string, string>();
  for (const row of headers as any[]) map.set(String(row.id), String(row.docNo ?? ''));
  return map;
}

/** Цена позиции — из EAV-атрибута `price`; нет цены — прочерк, не ноль (ноль врёт в бюджет). */
async function priceByNomenclature(db: BetterSQLite3Database): Promise<Map<string, number>> {
  const snapshot = await loadSnapshot(db);
  const out = new Map<string, number>();
  for (const [entityId, attrs] of snapshot.attrsByEntity) {
    const raw = (attrs as Record<string, unknown> | undefined)?.price;
    const price = Number(raw);
    if (Number.isFinite(price) && price > 0) out.set(entityId, price);
  }
  return out;
}

export async function buildPpeRequestSheetReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const snap = await loadPpeSnapshot(db);
  const q = String((filters as any)?.nameQuery ?? '').trim().toLowerCase();
  const warehouseIds = new Set((Array.isArray((filters as any)?.warehouseIds) ? (filters as any).warehouseIds : []).map(String));
  const now = Date.now();
  const needByNom = new Map<string, number>();
  for (const card of snap.cards) {
    if (card.closedAt != null) continue;
    const merged = resolveEmployeeNorms(cardNormLines(snap, card));
    const upcoming = upcomingIssues(merged, snap.entriesByCard.get(card.id) ?? [], now, REQUEST_HORIZON_DAYS);
    for (const p of upcoming) needByNom.set(p.nomenclatureId, (needByNom.get(p.nomenclatureId) ?? 0) + p.qty);
  }
  const stockByNom = new Map<string, number>();
  const balances = await db.select().from(erpRegStockBalance).limit(200_000);
  for (const b of balances as any[]) {
    const nomId = b.nomenclatureId == null ? null : String(b.nomenclatureId);
    if (!nomId || snap.nomCategory.get(nomId) !== 'workwear') continue;
    const wh = b.warehouseLocationId == null ? null : String(b.warehouseLocationId);
    if (warehouseIds.size > 0 && (wh == null || !warehouseIds.has(wh))) continue;
    const available = Math.max(0, Number(b.qty ?? 0) - Number(b.reservedQty ?? 0));
    stockByNom.set(nomId, (stockByNom.get(nomId) ?? 0) + available);
  }
  const prices = await priceByNomenclature(db);
  const rows: Array<Record<string, ReportCellValue>> = [];
  for (const [nomId, needQty] of needByNom) {
    const nom = snap.nomName.get(nomId) ?? HUMAN_DASH;
    if (!matchQuery(nom, q)) continue;
    const stockQty = stockByNom.get(nomId) ?? 0;
    const deficitQty = Math.max(0, needQty - stockQty);
    const price = prices.get(nomId) ?? null;
    rows.push({
      nomenclature: nom,
      needQty,
      stockQty,
      deficitQty,
      priceRub: price == null ? HUMAN_DASH : round2(price),
      amountRub: price == null ? HUMAN_DASH : round2(deficitQty * price),
    });
  }
  rows.sort((a, b) => String(a.nomenclature).localeCompare(String(b.nomenclature), 'ru'));
  const preset = getPreset('ppe_request_sheet');
  return {
    ok: true,
    presetId: 'ppe_request_sheet',
    title: preset.title,
    subtitle: `Позиций к закупке: ${rows.length} (горизонт ${REQUEST_HORIZON_DAYS} дней)`,
    columns: preset.columns,
    rows,
    totals: {
      lines: rows.length,
      deficitQty: rows.reduce((s, r) => s + Number(r.deficitQty ?? 0), 0),
      amountRub: round2(rows.reduce((s, r) => s + (typeof r.amountRub === 'number' ? r.amountRub : 0), 0)),
    },
    generatedAt: Date.now(),
  };
}

export async function buildPpeIssuedReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const snap = await loadPpeSnapshot(db);
  const period = readPeriod(filters);
  const q = String((filters as any)?.nameQuery ?? '').trim().toLowerCase();
  const employeeIds = new Set((Array.isArray((filters as any)?.employeeIds) ? (filters as any).employeeIds : []).map(String));
  const docs = await documentNoById(db);
  const employeeByCard = new Map(snap.cards.map((c) => [c.id, c.employeeId] as const));
  const rows: Array<Record<string, ReportCellValue>> = [];
  for (const [cardId, list] of snap.entriesByCard) {
    const employeeId = employeeByCard.get(cardId) ?? '';
    for (const e of list) {
      if (period.startMs != null && e.issuedAt < period.startMs) continue;
      if (e.issuedAt > period.endMs) continue;
      if (employeeIds.size > 0 && !employeeIds.has(employeeId)) continue;
      const employee = snap.empName.get(employeeId) ?? HUMAN_DASH;
      const nom = snap.nomName.get(e.nomenclatureId) ?? HUMAN_DASH;
      if (!matchQuery(`${employee} ${nom}`, q)) continue;
      rows.push({
        issuedAt: e.issuedAt,
        employee,
        nomenclature: nom,
        qty: e.qty,
        documentNo: e.documentId == null ? '' : docs.get(e.documentId) ?? '',
      });
    }
  }
  rows.sort((a, b) => Number(b.issuedAt ?? 0) - Number(a.issuedAt ?? 0));
  const preset = getPreset('ppe_issued');
  return {
    ok: true,
    presetId: 'ppe_issued',
    title: preset.title,
    subtitle: `Выдач: ${rows.length}`,
    columns: preset.columns,
    rows,
    totals: { lines: rows.length, totalQty: rows.reduce((s, r) => s + Number(r.qty ?? 0), 0) },
    generatedAt: Date.now(),
  };
}

async function buildPpeMovementsReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
  mode: 'writeoffs' | 'operations',
  ctx?: ReportBuildContext,
): Promise<ReportPresetPreviewResult> {
  const snap = await loadPpeSnapshot(db);
  const period = readPeriod(filters);
  const q = String((filters as any)?.nameQuery ?? '').trim().toLowerCase();
  const warehouseIds = new Set((Array.isArray((filters as any)?.warehouseIds) ? (filters as any).warehouseIds : []).map(String));
  const locations = await getWarehouseLocationsForReport(db, ctx);
  const docs = await documentNoById(db);
  const writeoffType = StockMovementType.Writeoff;
  const writeoffReversalType = reversalMovementType(StockMovementType.Writeoff);
  const movements = await db.select().from(erpRegStockMovements).limit(500_000);
  const rows: Array<Record<string, ReportCellValue>> = [];
  let netQty = 0;
  for (const raw of movements as any[]) {
    const movementType = String(raw.movementType ?? '');
    if (mode === 'writeoffs' && movementType !== writeoffType && movementType !== writeoffReversalType) continue;
    const performedAt = Number(raw.performedAt ?? 0);
    if (period.startMs != null && performedAt < period.startMs) continue;
    if (performedAt > period.endMs) continue;
    const nomId = String(raw.nomenclatureId ?? '');
    if (snap.nomCategory.get(nomId) !== 'workwear') continue;
    const nom = snap.nomName.get(nomId) ?? HUMAN_DASH;
    if (!matchQuery(nom, q)) continue;
    const wh = raw.warehouseLocationId == null ? '' : String(raw.warehouseLocationId);
    if (warehouseIds.size > 0 && !warehouseIds.has(wh)) continue;
    const direction = String(raw.direction ?? '');
    const sign = direction === 'out' ? 1 : -1;
    const qty = mode === 'writeoffs' ? sign * Number(raw.qty ?? 0) : Number(raw.qty ?? 0);
    const documentNo = docs.get(String(raw.documentHeaderId ?? '')) ?? '';
    const link = wh ? (locations.get(wh)?.name ?? HUMAN_DASH) : '';
    if (mode === 'writeoffs') {
      rows.push({
        performedAt,
        operation: movementTypeLabel(movementType),
        warehouse: link,
        nomenclature: nom,
        qty,
        documentNo,
        reason: raw.reason ? String(raw.reason) : '',
      });
    } else {
      rows.push({
        performedAt,
        operation: movementTypeLabel(movementType),
        direction: direction === 'in' ? 'Приход' : direction === 'out' ? 'Расход' : '',
        warehouse: link,
        nomenclature: nom,
        qty,
        documentNo,
      });
    }
    netQty += mode === 'writeoffs' ? qty : Number(raw.qty ?? 0);
  }
  rows.sort((a, b) => Number(b.performedAt ?? 0) - Number(a.performedAt ?? 0));
  const presetId = mode === 'writeoffs' ? 'ppe_writeoffs' : 'ppe_operations';
  const preset = getPreset(presetId);
  return {
    ok: true,
    presetId,
    title: preset.title,
    subtitle: `Записей: ${rows.length}`,
    columns: preset.columns,
    rows,
    totals: { lines: rows.length, totalQty: mode === 'writeoffs' ? round2(netQty) : netQty },
    generatedAt: Date.now(),
  };
}

export async function buildPpeWriteoffsReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
  ctx?: ReportBuildContext,
): Promise<ReportPresetPreviewResult> {
  return buildPpeMovementsReport(db, filters, 'writeoffs', ctx);
}

export async function buildPpeOperationsReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
  ctx?: ReportBuildContext,
): Promise<ReportPresetPreviewResult> {
  return buildPpeMovementsReport(db, filters, 'operations', ctx);
}

export async function buildPpeRecipientsReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const snap = await loadPpeSnapshot(db);
  const period = readPeriod(filters);
  const q = String((filters as any)?.nameQuery ?? '').trim().toLowerCase();
  const employeeByCard = new Map(snap.cards.map((c) => [c.id, c.employeeId] as const));
  const byEmployee = new Map<string, { entries: number; noms: Set<string>; qty: number }>();
  for (const [cardId, list] of snap.entriesByCard) {
    const employeeId = employeeByCard.get(cardId) ?? '';
    for (const e of list) {
      if (period.startMs != null && e.issuedAt < period.startMs) continue;
      if (e.issuedAt > period.endMs) continue;
      const agg = byEmployee.get(employeeId) ?? { entries: 0, noms: new Set<string>(), qty: 0 };
      agg.entries += 1;
      agg.noms.add(e.nomenclatureId);
      agg.qty += e.qty;
      byEmployee.set(employeeId, agg);
    }
  }
  const rows: Array<Record<string, ReportCellValue>> = [];
  for (const [employeeId, agg] of byEmployee) {
    const employee = snap.empName.get(employeeId) ?? HUMAN_DASH;
    if (!matchQuery(employee, q)) continue;
    rows.push({ employee, entriesCount: agg.entries, nomenclaturesCount: agg.noms.size, totalQty: agg.qty });
  }
  rows.sort((a, b) => String(a.employee).localeCompare(String(b.employee), 'ru'));
  const preset = getPreset('ppe_recipients');
  return {
    ok: true,
    presetId: 'ppe_recipients',
    title: preset.title,
    subtitle: `Сотрудников: ${rows.length}`,
    columns: preset.columns,
    rows,
    totals: { lines: rows.length, totalQty: rows.reduce((s, r) => s + Number(r.totalQty ?? 0), 0) },
    generatedAt: Date.now(),
  };
}

export async function buildPpeCoverageReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const snap = await loadPpeSnapshot(db);
  const q = String((filters as any)?.nameQuery ?? '').trim().toLowerCase();
  const now = Date.now();
  const rows: Array<Record<string, ReportCellValue>> = [];
  let covered = 0;
  for (const card of snap.cards) {
    if (card.closedAt != null) continue;
    const employee = snap.empName.get(card.employeeId) ?? HUMAN_DASH;
    if (!matchQuery(employee, q)) continue;
    const merged = resolveEmployeeNorms(cardNormLines(snap, card));
    const plan = nextIssueDates(merged, snap.entriesByCard.get(card.id) ?? [], now, undefined, absenceSpans(snap, card.employeeId));
    const overdueCount = plan.filter((p) => p.status === 'overdue' || p.status === 'neverIssued').length;
    const inTimeCount = plan.filter((p) => p.status === 'ok' || p.status === 'dueSoon').length;
    const ok = plan.length > 0 && overdueCount === 0;
    if (ok) covered += 1;
    rows.push({
      employee,
      normPositions: plan.length,
      inTimeCount,
      overdueCount,
      state: plan.length === 0 ? 'нет норм' : ok ? 'обеспечен' : 'не обеспечен',
    });
  }
  rows.sort((a, b) => String(a.employee).localeCompare(String(b.employee), 'ru'));
  const coveragePct = rows.length === 0 ? 0 : Math.round((covered / rows.length) * 100);
  const preset = getPreset('ppe_coverage');
  return {
    ok: true,
    presetId: 'ppe_coverage',
    title: preset.title,
    subtitle: `Сотрудников с карточками: ${rows.length}; обеспечены ${covered} (${coveragePct}%)`,
    columns: preset.columns,
    rows,
    totals: { lines: rows.length, employees: rows.length, covered, coveragePct },
    generatedAt: Date.now(),
  };
}

export async function buildPpeAnnualNeedReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const snap = await loadPpeSnapshot(db);
  const q = String((filters as any)?.nameQuery ?? '').trim().toLowerCase();
  const prices = await priceByNomenclature(db);
  const byNom = new Map<string, { employees: Set<string>; annualQty: number }>();
  for (const card of snap.cards) {
    if (card.closedAt != null) continue;
    const merged = resolveEmployeeNorms(cardNormLines(snap, card));
    for (const p of merged) {
      const annualQty = (p.qty * 12) / Math.max(1, p.wearMonths);
      const agg = byNom.get(p.nomenclatureId) ?? { employees: new Set<string>(), annualQty: 0 };
      agg.employees.add(card.employeeId);
      agg.annualQty += annualQty;
      byNom.set(p.nomenclatureId, agg);
    }
  }
  const rows: Array<Record<string, ReportCellValue>> = [];
  for (const [nomId, agg] of byNom) {
    const nom = snap.nomName.get(nomId) ?? HUMAN_DASH;
    if (!matchQuery(nom, q)) continue;
    const price = prices.get(nomId) ?? null;
    const annualQty = round2(agg.annualQty);
    rows.push({
      nomenclature: nom,
      employeesCount: agg.employees.size,
      perEmployeeQty: round2(agg.annualQty / Math.max(1, agg.employees.size)),
      annualQty,
      priceRub: price == null ? HUMAN_DASH : round2(price),
      annualAmountRub: price == null ? HUMAN_DASH : round2(annualQty * price),
    });
  }
  rows.sort((a, b) => String(a.nomenclature).localeCompare(String(b.nomenclature), 'ru'));
  const preset = getPreset('ppe_annual_need');
  return {
    ok: true,
    presetId: 'ppe_annual_need',
    title: preset.title,
    subtitle: `Позиций: ${rows.length}`,
    columns: preset.columns,
    rows,
    totals: {
      lines: rows.length,
      annualQty: round2(rows.reduce((s, r) => s + Number(r.annualQty ?? 0), 0)),
      annualAmountRub: round2(rows.reduce((s, r) => s + (typeof r.annualAmountRub === 'number' ? r.annualAmountRub : 0), 0)),
    },
    generatedAt: Date.now(),
  };
}
