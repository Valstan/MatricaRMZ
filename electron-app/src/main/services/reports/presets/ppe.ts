import { isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  nextIssueDates,
  resolveEmployeeNorms,
  type ReportCellValue,
  type ReportPresetFilters,
  type ReportPresetPreviewResult,
} from '@matricarmz/shared';

import {
  erpEmployeeCards,
  erpNomenclature,
  erpRegStockBalance,
  ppeCardNorms,
  ppeIssueCards,
  ppeIssueEntries,
  ppeNormLines,
  ppeNormSets,
} from '../../../database/schema.js';
import { getPreset, getWarehouseLocationsForReport, type ReportBuildContext } from '../context.js';

const HUMAN_DASH = '—';

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
  entriesByCard: Map<string, Array<{ nomenclatureId: string; qty: number; issuedAt: number }>>;
};

async function loadPpeSnapshot(db: BetterSQLite3Database): Promise<PpeSnapshot> {
  const [noms, emps, sets, lines, cards, cardNorms, entries] = await Promise.all([
    db.select().from(erpNomenclature).where(isNull(erpNomenclature.deletedAt)).limit(60_000),
    db.select().from(erpEmployeeCards).where(isNull(erpEmployeeCards.deletedAt)).limit(20_000),
    db.select().from(ppeNormSets).where(isNull(ppeNormSets.deletedAt)).limit(5_000),
    db.select().from(ppeNormLines).where(isNull(ppeNormLines.deletedAt)).limit(60_000),
    db.select().from(ppeIssueCards).where(isNull(ppeIssueCards.deletedAt)).limit(20_000),
    db.select().from(ppeCardNorms).where(isNull(ppeCardNorms.deletedAt)).limit(20_000),
    db.select().from(ppeIssueEntries).where(isNull(ppeIssueEntries.deletedAt)).limit(200_000),
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
  const entriesByCard = new Map<string, Array<{ nomenclatureId: string; qty: number; issuedAt: number }>>();
  for (const v of entries as any[]) {
    const arr = entriesByCard.get(String(v.cardId)) ?? [];
    arr.push({ nomenclatureId: String(v.nomenclatureId), qty: Number(v.qty), issuedAt: Number(v.issuedAt) });
    entriesByCard.set(String(v.cardId), arr);
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
  };
}

function cardNormLines(snap: PpeSnapshot, cardId: string) {
  const out: Array<{ normSetId: string; nomenclatureId: string; qty: number; wearMonths: number }> = [];
  for (const setId of snap.normsByCard.get(cardId) ?? []) {
    for (const l of snap.linesBySet.get(setId) ?? []) out.push({ normSetId: setId, ...l });
  }
  return out;
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
    const merged = resolveEmployeeNorms(cardNormLines(snap, card.id));
    const plan = nextIssueDates(merged, snap.entriesByCard.get(card.id) ?? [], now);
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
    for (const l of cardNormLines(snap, card.id)) {
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
    const merged = resolveEmployeeNorms(cardNormLines(snap, card.id));
    for (const p of nextIssueDates(merged, snap.entriesByCard.get(card.id) ?? [], now)) {
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
