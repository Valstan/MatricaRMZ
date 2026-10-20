/**
 * Список карточек СИЗ: строка на сотрудника, а не на карточку.
 *
 * Считать по одной карточке нельзя: половина людей ещё не имеет карточки, а кладовщику
 * нужен именно список «кто есть и что с ним» — иначе он снова ищет фамилию в пикере.
 * Поэтому источник строки — реплика сотрудников (`erp_employee_cards`), а данные карточки
 * подмешиваются сюда же.
 *
 * Сроки считает ядро `shared/ppe` (`resolveEmployeeNorms` + `nextIssueDates`) — то же,
 * что показывает карточка и отчёты. Свой второй калькулятор тут означал бы, что список
 * говорит «пора», а карточка «в сроке».
 */
import { and, inArray, isNull } from 'drizzle-orm';

import {
  nextIssueDates,
  resolveEmployeeNorms,
  type MergedPpeNorm,
  type PpeIssueStatus,
  type PpeNextIssue,
} from '@matricarmz/shared';

import { db, pool } from '../database/db.js';
import {
  ppeAbsences,
  ppeCardNorms,
  ppeGroupMembers,
  ppeGroupNorms,
  ppeIssueCards,
  ppeIssueEntries,
  ppeNormLines,
  ppeNormSets,
  erpEmployeeCards,
} from '../database/schema.js';
import { parseEavValue } from './ppeEmployeeMirror.js';

export type PpeEmployeeSizes = { clothes: string; shoes: string; height: string };

/** `noNorms` — норм нет вовсе, `neverIssued` — нормы есть, но ничего не выдавалось. */
export type PpeOverviewStatus = PpeIssueStatus | 'noNorms';

export type PpeOverviewRow = {
  employeeId: string;
  fullName: string;
  personnelNo: string | null;
  isActive: boolean;
  sizes: PpeEmployeeSizes;
  cardId: string | null;
  cardState: 'none' | 'open' | 'closed';
  cardOpenedAt: number | null;
  normSetCount: number;
  /** Позиций после слияния норм (личные + групповые) — их и показывает колонка «Норм». */
  normPositionCount: number;
  issueCount: number;
  lastIssuedAt: number | null;
  nextDueAt: number | null;
  status: PpeOverviewStatus;
  overdueCount: number;
  dueSoonCount: number;
  /** 5 признаков по 20 %: одежда, обувь, рост, нормы, выдачи. */
  fillPercent: number;
};

type EmployeeRow = {
  id: string;
  entityId: string | null;
  fullName: string;
  personnelNo: string | null;
  isActive: boolean;
};

type CardRow = { id: string; employeeId: string; openedAt: number; closedAt: number | null };
type EntryRow = { cardId: string; nomenclatureId: string; qty: number; issuedAt: number };
type AbsenceRow = { employeeId: string; fromMs: number; toMs: number };

export type OverviewSources = {
  employees: EmployeeRow[];
  sizes: Map<string, PpeEmployeeSizes>;
  cards: CardRow[];
  cardNorms: Array<{ cardId: string; normSetId: string }>;
  entries: EntryRow[];
  groupMembers: Array<{ groupId: string; employeeId: string }>;
  groupNorms: Array<{ groupId: string; normSetId: string }>;
  normLines: Array<{ normSetId: string; nomenclatureId: string; qty: number; wearMonths: number }>;
  absences: AbsenceRow[];
  now: number;
};

const EMPTY_SIZES: PpeEmployeeSizes = { clothes: '', shoes: '', height: '' };

function latestCard(cards: CardRow[]): CardRow | null {
  if (cards.length === 0) return null;
  const open = cards.find((c) => c.closedAt == null);
  if (open) return open;
  return cards.reduce((a, b) => (b.openedAt > a.openedAt ? b : a));
}

function statusOf(items: PpeNextIssue[]): {
  status: PpeOverviewStatus;
  nextDueAt: number | null;
  overdueCount: number;
  dueSoonCount: number;
} {
  if (items.length === 0) return { status: 'noNorms', nextDueAt: null, overdueCount: 0, dueSoonCount: 0 };
  const overdueCount = items.filter((i) => i.status === 'overdue').length;
  const dueSoonCount = items.filter((i) => i.status === 'dueSoon').length;
  const dated = items
    .map((i) => i.nextDueAt)
    .filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms > 0);
  const nextDueAt = dated.length > 0 ? Math.min(...dated) : null;
  if (overdueCount > 0) return { status: 'overdue', nextDueAt, overdueCount, dueSoonCount };
  if (dueSoonCount > 0) return { status: 'dueSoon', nextDueAt, overdueCount, dueSoonCount };
  if (items.every((i) => i.status === 'neverIssued')) {
    return { status: 'neverIssued', nextDueAt, overdueCount, dueSoonCount };
  }
  return { status: 'ok', nextDueAt, overdueCount, dueSoonCount };
}

/** Чистое ядро списка: источники → строки. Отделено от БД, чтобы правила держал тест. */
export function buildPpeCardsOverview(src: OverviewSources): PpeOverviewRow[] {
  const cardsByEmployee = new Map<string, CardRow[]>();
  for (const card of src.cards) {
    const list = cardsByEmployee.get(card.employeeId);
    if (list) list.push(card);
    else cardsByEmployee.set(card.employeeId, [card]);
  }

  const cardById = new Map(src.cards.map((c) => [c.id, c]));
  const normsByCard = new Map<string, string[]>();
  for (const link of src.cardNorms) {
    const list = normsByCard.get(link.cardId);
    if (list) list.push(link.normSetId);
    else normsByCard.set(link.cardId, [link.normSetId]);
  }

  const groupsByEmployee = new Map<string, string[]>();
  for (const member of src.groupMembers) {
    const list = groupsByEmployee.get(member.employeeId);
    if (list) list.push(member.groupId);
    else groupsByEmployee.set(member.employeeId, [member.groupId]);
  }
  const normSetsByGroup = new Map<string, string[]>();
  for (const link of src.groupNorms) {
    const list = normSetsByGroup.get(link.groupId);
    if (list) list.push(link.normSetId);
    else normSetsByGroup.set(link.groupId, [link.normSetId]);
  }

  const linesBySet = new Map<string, Array<{ nomenclatureId: string; qty: number; wearMonths: number }>>();
  for (const line of src.normLines) {
    const list = linesBySet.get(line.normSetId);
    const item = { nomenclatureId: line.nomenclatureId, qty: line.qty, wearMonths: line.wearMonths };
    if (list) list.push(item);
    else linesBySet.set(line.normSetId, [item]);
  }

  const entriesByEmployee = new Map<string, EntryRow[]>();
  for (const entry of src.entries) {
    const card = cardById.get(entry.cardId);
    if (!card) continue;
    const list = entriesByEmployee.get(card.employeeId);
    if (list) list.push(entry);
    else entriesByEmployee.set(card.employeeId, [entry]);
  }

  const absencesByEmployee = new Map<string, Array<{ fromMs: number; toMs: number }>>();
  for (const a of src.absences) {
    const list = absencesByEmployee.get(a.employeeId);
    const span = { fromMs: a.fromMs, toMs: a.toMs };
    if (list) list.push(span);
    else absencesByEmployee.set(a.employeeId, [span]);
  }

  return src.employees.map((employee) => {
    const cards = cardsByEmployee.get(employee.id) ?? [];
    const card = latestCard(cards);
    const personal = card ? (normsByCard.get(card.id) ?? []) : [];
    const groupIds = groupsByEmployee.get(employee.id) ?? [];
    const grouped = groupIds.flatMap((groupId) => normSetsByGroup.get(groupId) ?? []);
    const normSetIds = [...new Set([...personal, ...grouped])];

    const normLines = normSetIds.flatMap((setId) =>
      (linesBySet.get(setId) ?? []).map((line) => ({ normSetId: setId, ...line })),
    );
    const merged: MergedPpeNorm[] = resolveEmployeeNorms(normLines);
    const entries = entriesByEmployee.get(employee.id) ?? [];
    const items = nextIssueDates(merged, entries, src.now, undefined, absencesByEmployee.get(employee.id) ?? []);
    const { status, nextDueAt, overdueCount, dueSoonCount } = statusOf(items);

    const sizes = (employee.entityId ? src.sizes.get(employee.entityId) : undefined) ?? EMPTY_SIZES;
    const lastIssuedAt = entries.length > 0 ? Math.max(...entries.map((e) => e.issuedAt)) : null;
    const filled = [sizes.clothes, sizes.shoes, sizes.height].filter((v) => String(v ?? '').trim() !== '').length;
    const fillPercent = Math.round(((filled + (merged.length > 0 ? 1 : 0) + (entries.length > 0 ? 1 : 0)) / 5) * 100);

    return {
      employeeId: String(employee.id),
      fullName: String(employee.fullName ?? ''),
      personnelNo: employee.personnelNo == null ? null : String(employee.personnelNo),
      isActive: employee.isActive !== false,
      sizes,
      cardId: card ? String(card.id) : null,
      cardState: card == null ? 'none' : card.closedAt == null ? 'open' : 'closed',
      cardOpenedAt: card ? Number(card.openedAt) : null,
      normSetCount: normSetIds.length,
      normPositionCount: merged.length,
      issueCount: entries.length,
      lastIssuedAt,
      nextDueAt,
      status,
      overdueCount,
      dueSoonCount,
      fillPercent,
    };
  });
}

async function loadSizes(entityIds: string[]): Promise<Map<string, PpeEmployeeSizes>> {
  const out = new Map<string, PpeEmployeeSizes>();
  if (entityIds.length === 0) return out;
  const res = await pool.query<{ entity_id: string; code: string; value_json: string | null }>(
    `select v.entity_id::text as entity_id, d.code as code, v.value_json as value_json
       from attribute_values v
       join attribute_defs d on d.id = v.attribute_def_id and d.deleted_at is null
      where v.deleted_at is null
        and v.entity_id = any($1::uuid[])
        and d.code = any($2::text[])`,
    [entityIds, ['ppe_size_clothes', 'ppe_size_shoes', 'ppe_height']],
  );
  for (const row of res.rows) {
    const current = out.get(row.entity_id) ?? { ...EMPTY_SIZES };
    const value = parseEavValue(row.value_json).trim();
    if (row.code === 'ppe_size_clothes') current.clothes = value;
    else if (row.code === 'ppe_size_shoes') current.shoes = value;
    else if (row.code === 'ppe_height') current.height = value;
    out.set(row.entity_id, current);
  }
  return out;
}

export async function getPpeCardsOverview(): Promise<{ ok: true; rows: PpeOverviewRow[] } | { ok: false; error: string }> {
  try {
    const employees = await db
      .select({
        id: erpEmployeeCards.id,
        entityId: erpEmployeeCards.entityId,
        fullName: erpEmployeeCards.fullName,
        personnelNo: erpEmployeeCards.personnelNo,
        isActive: erpEmployeeCards.isActive,
      })
      .from(erpEmployeeCards)
      .where(isNull(erpEmployeeCards.deletedAt))
      .orderBy(erpEmployeeCards.fullName);

    const employeeRows: EmployeeRow[] = employees.map((e) => ({
      id: String(e.id),
      entityId: e.entityId == null ? null : String(e.entityId),
      fullName: String(e.fullName ?? ''),
      personnelNo: e.personnelNo == null ? null : String(e.personnelNo),
      isActive: e.isActive !== false,
    }));

    const employeeIds = employeeRows.map((e) => e.id);
    if (employeeIds.length === 0) return { ok: true, rows: [] };

    const [cards, cardNorms, entries, groupMembers, groupNorms, normSets, absences, sizes] = await Promise.all([
      db
        .select({
          id: ppeIssueCards.id,
          employeeId: ppeIssueCards.employeeId,
          openedAt: ppeIssueCards.openedAt,
          closedAt: ppeIssueCards.closedAt,
        })
        .from(ppeIssueCards)
        .where(isNull(ppeIssueCards.deletedAt)),
      db
        .select({ cardId: ppeCardNorms.cardId, normSetId: ppeCardNorms.normSetId })
        .from(ppeCardNorms)
        .where(isNull(ppeCardNorms.deletedAt)),
      db
        .select({
          cardId: ppeIssueEntries.cardId,
          nomenclatureId: ppeIssueEntries.nomenclatureId,
          qty: ppeIssueEntries.qty,
          issuedAt: ppeIssueEntries.issuedAt,
        })
        .from(ppeIssueEntries)
        .where(isNull(ppeIssueEntries.deletedAt)),
      db
        .select({ groupId: ppeGroupMembers.groupId, employeeId: ppeGroupMembers.employeeId })
        .from(ppeGroupMembers)
        .where(isNull(ppeGroupMembers.deletedAt)),
      db
        .select({ groupId: ppeGroupNorms.groupId, normSetId: ppeGroupNorms.normSetId })
        .from(ppeGroupNorms)
        .where(isNull(ppeGroupNorms.deletedAt)),
      db
        .select({ id: ppeNormSets.id })
        .from(ppeNormSets)
        .where(isNull(ppeNormSets.deletedAt)),
      db
        .select({ employeeId: ppeAbsences.employeeId, fromMs: ppeAbsences.fromMs, toMs: ppeAbsences.toMs })
        .from(ppeAbsences)
        .where(isNull(ppeAbsences.deletedAt)),
      loadSizes(employeeRows.map((e) => e.entityId).filter((id): id is string => Boolean(id))),
    ]);

    // Строки норм читаем только живых наборов: удалённый набор не должен тянуть позиции в список.
    const liveSetIds = normSets.map((s) => String(s.id));
    const normLines =
      liveSetIds.length === 0
        ? []
        : await db
            .select({
              normSetId: ppeNormLines.normSetId,
              nomenclatureId: ppeNormLines.nomenclatureId,
              qty: ppeNormLines.qty,
              wearMonths: ppeNormLines.wearMonths,
            })
            .from(ppeNormLines)
            .where(and(isNull(ppeNormLines.deletedAt), inArray(ppeNormLines.normSetId, liveSetIds)));

    const rows = buildPpeCardsOverview({
      employees: employeeRows,
      sizes,
      cards: cards.map((c) => ({
        id: String(c.id),
        employeeId: String(c.employeeId),
        openedAt: Number(c.openedAt),
        closedAt: c.closedAt == null ? null : Number(c.closedAt),
      })),
      cardNorms: cardNorms.map((n) => ({ cardId: String(n.cardId), normSetId: String(n.normSetId) })),
      entries: entries.map((e) => ({
        cardId: String(e.cardId),
        nomenclatureId: String(e.nomenclatureId),
        qty: Number(e.qty),
        issuedAt: Number(e.issuedAt),
      })),
      groupMembers: groupMembers.map((m) => ({ groupId: String(m.groupId), employeeId: String(m.employeeId) })),
      groupNorms: groupNorms.map((n) => ({ groupId: String(n.groupId), normSetId: String(n.normSetId) })),
      normLines: normLines.map((l) => ({
        normSetId: String(l.normSetId),
        nomenclatureId: String(l.nomenclatureId),
        qty: Number(l.qty),
        wearMonths: Number(l.wearMonths),
      })),
      absences: absences.map((a) => ({
        employeeId: String(a.employeeId),
        fromMs: Number(a.fromMs),
        toMs: Number(a.toMs),
      })),
      now: Date.now(),
    });

    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
