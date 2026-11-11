/**
 * Журнал приёмки СИЗ и отчёт «невыданное» — из клиентской реплики.
 *
 * Источник — те же таблицы `ppe_*` и `erp_employee_cards`, из которых строит выгрузка
 * для 1С: журнал — это те же факты выдачи, но с контекстом нормы и с раздельными
 * величинами (количество на год и срок носки стоят рядом, но не смешаны).
 *
 * Почему из реплики, а не с сервера: факты выдачи к клиенту и так доезжают по синх-ке,
 * а новая серверная таблица и новый контракт синхронизации — это лишний контрактный
 * риск ради выборки, которую реплика уже содержит.
 */
import { isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  buildAcceptanceJournal,
  buildUndeliveredReport,
  nextIssueDates,
  resolveEmployeeNorms,
  type PpeAcceptanceFact,
  type PpeEmployeeNormContext,
  type PpeJournalRow,
  type PpeUndeliveredRow,
  type PpeWearKind,
} from '@matricarmz/shared';

import {
  erpEmployeeCards,
  erpNomenclature,
  ppeCardNorms,
  ppeEmployeeCards,
  ppeIssueCards,
  ppeIssueEntries,
  ppeNormLines,
} from '../database/schema.js';

/** Размер позиции вытаскиваем из названия: «Костюм зимний, р. 52» → «52». */
function sizeOf(name: string): string {
  const m = String(name ?? '').match(/р\.\s*([\dA-Za-z]+)/);
  return m ? (m[1] ?? '') : '';
}

type EmployeeInfo = {
  personnelNo: string | null;
  fullName: string;
  postTitle: string | null;
  departmentName: string | null;
};

export type PpeJournalResult = {
  rows: PpeJournalRow[];
  /** Отчёт «невыданное»: количество и срок считаются раздельно. */
  undelivered: PpeUndeliveredRow[];
  /** Строк выдачи за период — для заголовка печати. */
  totalIssued: number;
  from: number;
  to: number;
};

/**
 * Собирает журнал приёмки и отчёт «невыданное» по локальной реплике.
 *
 * `from`/`to` — период выдачи (мс). Количество в отчёте сравнивается с годовой нормой,
 * поэтому период количества должен быть годом; срок носки — свой, в месяцах.
 */
export async function buildPpeJournal(
  db: BetterSQLite3Database,
  args: { fromMs: number | undefined; toMs: number | undefined; employeeId?: string | null | undefined; now?: number | undefined },
): Promise<PpeJournalResult> {
  const from = Number(args.fromMs ?? 0);
  const to = Number(args.toMs ?? Number.MAX_SAFE_INTEGER);
  const now = Number(args.now ?? Date.now());

  const [employeeRows, nomRows, cardRows, entryRows, cardNormRows, lineRows, ppeCardRows] =
    await Promise.all([
      db.select().from(erpEmployeeCards).where(isNull(erpEmployeeCards.deletedAt)).limit(50_000),
      db.select().from(erpNomenclature).where(isNull(erpNomenclature.deletedAt)).limit(100_000),
      db.select().from(ppeIssueCards).where(isNull(ppeIssueCards.deletedAt)).limit(50_000),
      db.select().from(ppeIssueEntries).where(isNull(ppeIssueEntries.deletedAt)).limit(200_000),
      db.select().from(ppeCardNorms).where(isNull(ppeCardNorms.deletedAt)).limit(100_000),
      db.select().from(ppeNormLines).where(isNull(ppeNormLines.deletedAt)).limit(200_000),
      db.select().from(ppeEmployeeCards).where(isNull(ppeEmployeeCards.deletedAt)).limit(50_000),
    ]);

  const employees = new Map<string, EmployeeInfo>();
  for (const e of employeeRows) {
    employees.set(String(e.id), {
      personnelNo: e.personnelNo == null ? null : String(e.personnelNo),
      fullName: String(e.fullName ?? ''),
      postTitle: null,
      departmentName: null,
    });
  }
  // Должность и подразделение — из личной карточки СИЗ (снимок на момент), как в выгрузке 1С.
  for (const c of ppeCardRows) {
    const info = employees.get(String(c.employeeId));
    if (!info) continue;
    if (c.postTitle) info.postTitle = String(c.postTitle);
    if (c.departmentName) info.departmentName = String(c.departmentName);
  }
  const nomName = new Map<string, string>();
  for (const n of nomRows) nomName.set(String(n.id), String(n.name ?? ''));

  // Карточка выдачи → сотрудник; наборы норм карточки → контекст нормы сотрудника.
  const cardById = new Map<string, { employeeId: string; setIds: string[] }>();
  const setsByEmployee = new Map<string, Set<string>>();
  for (const c of cardRows) {
    const id = String(c.id);
    const employeeId = String(c.employeeId);
    const setIds = cardNormRows
      .filter((cn) => String(cn.cardId) === id)
      .map((cn) => String(cn.normSetId));
    cardById.set(id, { employeeId, setIds });
    const set = setsByEmployee.get(employeeId) ?? new Set<string>();
    for (const s of setIds) set.add(s);
    setsByEmployee.set(employeeId, set);
  }

  const linesBySet = new Map<string, typeof lineRows>();
  for (const l of lineRows) {
    const key = String(l.normSetId);
    const list = linesBySet.get(key) ?? [];
    list.push(l);
    linesBySet.set(key, list);
  }

  // Контекст нормы сотрудника: строки его наборов, слитые тем же ядром, что и карточка.
  const contexts: PpeEmployeeNormContext[] = [];
  const mergedByEmployee = new Map<string, ReturnType<typeof resolveEmployeeNorms>>();
  for (const [employeeId, setIds] of setsByEmployee) {
    const input = [];
    for (const setId of setIds) {
      for (const l of linesBySet.get(setId) ?? []) {
        input.push({
          normSetId: setId,
          nomenclatureId: String(l.nomenclatureId),
          qty: Number(l.qty),
          wearMonths: l.wearMonths == null ? null : Number(l.wearMonths),
          wearKind: (l.wearKind == null ? null : String(l.wearKind)) as PpeWearKind | null,
        });
      }
    }
    const merged = resolveEmployeeNorms(input);
    mergedByEmployee.set(employeeId, merged);
    for (const m of merged) {
      contexts.push({
        employeeId,
        nomenclatureId: m.nomenclatureId,
        qty: m.qty,
        wearKind: m.wearKind,
        wearMonths: m.wearMonths,
        itemName: nomName.get(m.nomenclatureId) ?? null,
      });
    }
  }

  // Факты выдачи за период.
  const facts: PpeAcceptanceFact[] = [];
  const issuedByEmployeePosition: Array<{ employeeId: string; nomenclatureId: string; qty: number }> = [];
  const historyByEmployee = new Map<string, Array<{ nomenclatureId: string; qty: number; issuedAt: number }>>();
  for (const entry of entryRows) {
    const card = cardById.get(String(entry.cardId));
    if (!card) continue;
    if (args.employeeId && card.employeeId !== args.employeeId) continue;
    const issuedAt = Number(entry.issuedAt);
    const info = employees.get(card.employeeId);
    if (!info) continue;
    const nomenclatureId = String(entry.nomenclatureId);
    const itemName = nomName.get(nomenclatureId) ?? '';
    const history = historyByEmployee.get(card.employeeId) ?? [];
    history.push({ nomenclatureId, qty: Number(entry.qty), issuedAt });
    historyByEmployee.set(card.employeeId, history);
    if (issuedAt < from || issuedAt > to) continue;
    issuedByEmployeePosition.push({
      employeeId: card.employeeId,
      nomenclatureId,
      qty: Number(entry.qty),
    });
    facts.push({
      issuedAt,
      employeeId: card.employeeId,
      personnelNo: info.personnelNo,
      fullName: info.fullName,
      postTitle: info.postTitle,
      departmentName: info.departmentName,
      nomenclatureId,
      itemName,
      size: sizeOf(itemName) || null,
      qty: Number(entry.qty),
      documentNo: null,
      // Возврат СИЗ (миграция 0126): дата «получил обратно» и процент износа едут
      // в ведомость отдельными величинами (решение владельца от 09.11).
      returnedAt: entry.returnedAt == null ? null : Number(entry.returnedAt),
      wearPercent: entry.wearPercent == null ? null : Number(entry.wearPercent),
    });
  }

  // Сроки следующей выдачи — тем же расчётом, что и в карточке.
  const nextDueAt = new Map<string, number | null>();
  for (const [employeeId, merged] of mergedByEmployee) {
    const items = nextIssueDates(merged, historyByEmployee.get(employeeId) ?? [], now);
    for (const item of items) {
      nextDueAt.set(`${employeeId}|${item.nomenclatureId}`, item.nextDueAt);
    }
  }

  const rows = buildAcceptanceJournal(facts, contexts);
  const undelivered = buildUndeliveredReport({
    contexts,
    issuedByEmployeePosition,
    employeeInfo: [...employees.entries()].map(([employeeId, info]) => ({ employeeId, ...info })),
    nextDueAt,
    now,
  });

  return { rows, undelivered, totalIssued: rows.length, from, to };
}
