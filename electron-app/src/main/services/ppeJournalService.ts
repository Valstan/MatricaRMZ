/**
 * Журнал приёмки СИЗ и отчёт «невыданное» — из клиентской реплики.
 *
 * Источник — те же таблицы `ppe_*` и `erp_employee_cards`, из которых строит выгрузка
 * для 1С: журнал — это те же факты выдачи, но с контекстом нормы и с раздельными
 * величинами (количество на год и срок носки стоят рядом, но не смешаны).
 *
 * Почему из реплики, а не с сервера: факты выдачи к клиенту и так доезжают по синк-ке,
 * а новая серверная таблица и новый контракт синхронизации — это лишний контрактный
 * риск ради выборки, которую реплика уже содержит.
 *
 * **База и размер.** Нормы приказа ссылаются на БАЗОВУЮ позицию, а выдача идёт по
 * конкретному размеру. Поэтому выдача сопоставляется с нормой по правилу: точное
 * совпадение номенклатуры → база размера → «вне нормы». Без этого позиция выданного
 * не находит свою норму (кол-во на год пустое, а срок — «не выдавалось»), и ведомость
 * врёт оператору ровно там, где он принимает решение: выдавать или заказывать.
 */
import { isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  buildAcceptanceJournal,
  buildUndeliveredReport,
  matchEmployeeSizePosition,
  nextIssueDates,
  PPE_SIZE_ATTRIBUTE_CODES,
  ppeKindOf,
  ppeResolvePositionId,
  ppeSizeKindForName,
  resolveEmployeeNorms,
  type PpeAcceptanceFact,
  type PpeEmployeeNormContext,
  type PpeJournalRow,
  type PpeKind,
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
import { sizeOfPositionName } from './ppeIssueCoverageService.js';
import { loadSnapshot } from './reports/context.js';

type EmployeeInfo = {
  personnelNo: string | null;
  fullName: string;
  postTitle: string | null;
  departmentName: string | null;
  sizeClothes: string | null;
  sizeShoes: string | null;
  height: string | null;
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

  const [employeeRows, nomRows, cardRows, entryRows, cardNormRows, lineRows, ppeCardRows, eav] = await Promise.all([
    db.select().from(erpEmployeeCards).where(isNull(erpEmployeeCards.deletedAt)).limit(50_000),
    db.select().from(erpNomenclature).where(isNull(erpNomenclature.deletedAt)).limit(100_000),
    db.select().from(ppeIssueCards).where(isNull(ppeIssueCards.deletedAt)).limit(50_000),
    db.select().from(ppeIssueEntries).where(isNull(ppeIssueEntries.deletedAt)).limit(200_000),
    db.select().from(ppeCardNorms).where(isNull(ppeCardNorms.deletedAt)).limit(100_000),
    db.select().from(ppeNormLines).where(isNull(ppeNormLines.deletedAt)).limit(200_000),
    db.select().from(ppeEmployeeCards).where(isNull(ppeEmployeeCards.deletedAt)).limit(50_000),
    loadSnapshot(db),
  ]);

  const employees = new Map<string, EmployeeInfo>();
  for (const e of employeeRows) {
    employees.set(String(e.id), {
      personnelNo: e.personnelNo == null ? null : String(e.personnelNo),
      fullName: String(e.fullName ?? ''),
      postTitle: null,
      departmentName: null,
      sizeClothes: null,
      sizeShoes: null,
      height: null,
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
  const parentById = new Map<string, string | null>();
  const childrenByBase = new Map<string, Array<{ id: string; name: string }>>();
  for (const n of nomRows) {
    const id = String(n.id);
    nomName.set(id, String(n.name ?? ''));
    const parentId = n.parentNomenclatureId == null ? null : String(n.parentNomenclatureId);
    parentById.set(id, parentId);
    if (parentId) {
      const list = childrenByBase.get(parentId) ?? [];
      list.push({ id, name: String(n.name ?? '') });
      childrenByBase.set(parentId, list);
    }
  }
  // Размеры сотрудника живут в EAV-карточке (те же коды, что регистрирует карточка).
  const employeeTypeId = eav.entityTypeIdByCode.get('employee');
  if (employeeTypeId) {
    const readAttr = (attrs: Record<string, unknown> | undefined, code: string): string | null => {
      const raw = attrs?.[code];
      if (raw == null || typeof raw === 'object') return null;
      const text = String(raw).trim();
      return text ? text : null;
    };
    for (const [entityId, entity] of eav.entitiesById) {
      if (entity.typeId !== employeeTypeId) continue;
      const info = employees.get(entityId);
      if (!info) continue;
      const attrs = eav.attrsByEntity.get(entityId) ?? {};
      info.sizeClothes = readAttr(attrs, PPE_SIZE_ATTRIBUTE_CODES.clothes);
      info.sizeShoes = readAttr(attrs, PPE_SIZE_ATTRIBUTE_CODES.shoes);
      info.height = readAttr(attrs, PPE_SIZE_ATTRIBUTE_CODES.height);
    }
  }

  // Карточка выдачи → сотрудник; наборы норм карточки → контекст нормы сотрудника.
  // Ключ — «сотрудник|вид»: у сотрудника две карточки (спецодежда и мыло), и нормы
  // разных видов не должны сливаться в один контекст (промты КАРМАНА #21/#26).
  const cardById = new Map<string, { employeeId: string; setIds: string[]; kind: PpeKind }>();
  const setsByEmployee = new Map<string, Set<string>>();
  for (const c of cardRows) {
    const id = String(c.id);
    const employeeId = String(c.employeeId);
    const kind = ppeKindOf(c.kind);
    const setIds = cardNormRows
      .filter((cn) => String(cn.cardId) === id)
      .map((cn) => String(cn.normSetId));
    cardById.set(id, { employeeId, setIds, kind });
    const employeeKey = `${employeeId}|${kind}`;
    const set = setsByEmployee.get(employeeKey) ?? new Set<string>();
    for (const s of setIds) set.add(s);
    setsByEmployee.set(employeeKey, set);
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
  for (const [employeeKey, setIds] of setsByEmployee) {
    const [employeeId, kind] = employeeKey.split('|') as [string, PpeKind];
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
    mergedByEmployee.set(employeeKey, merged);
    const info = employees.get(employeeId);
    for (const m of merged) {
      // Размер позиции сотрудника: у размерной позиции — свой, у базы — по карточке.
      const parentId = parentById.get(m.nomenclatureId) ?? null;
      let size: string | null = null;
      if (parentId) {
        size = sizeOfPositionName(nomName.get(m.nomenclatureId) ?? '');
      } else {
        const kind = ppeSizeKindForName(nomName.get(m.nomenclatureId) ?? '');
        const sizeValue =
          kind === 'shoes' ? info?.sizeShoes ?? null : kind === 'clothes' ? info?.sizeClothes ?? null : null;
        if (sizeValue) {
          const children = childrenByBase.get(m.nomenclatureId) ?? [];
          const matched = matchEmployeeSizePosition({ children, size: sizeValue, height: info?.height ?? null });
          const child = matched ? children.find((c) => c.id === matched) : null;
          size = (child ? sizeOfPositionName(child.name) : null) ?? sizeValue;
        }
      }
      contexts.push({
        employeeId,
        kind,
        nomenclatureId: m.nomenclatureId,
        qty: m.qty,
        wearKind: m.wearKind,
        wearMonths: m.wearMonths,
        itemName: nomName.get(m.nomenclatureId) ?? null,
        size,
      });
    }
  }

  // Факты выдачи: кладовщик выдаёт конкретный размер, а норма живёт на базовой позиции.
  const facts: PpeAcceptanceFact[] = [];
  const issuedByEmployeePosition: Array<{ employeeId: string; nomenclatureId: string; qty: number; kind: PpeKind }> = [];
  const historyByEmployee = new Map<string, Array<{ nomenclatureId: string; qty: number; issuedAt: number }>>();
  const positionIdsByEmployee = new Map<string, Set<string>>();
  for (const [employeeKey, merged] of mergedByEmployee) {
    positionIdsByEmployee.set(employeeKey, new Set(merged.map((m) => m.nomenclatureId)));
  }
  for (const entry of entryRows) {
    const card = cardById.get(String(entry.cardId));
    if (!card) continue;
    if (args.employeeId && card.employeeId !== args.employeeId) continue;
    const issuedAt = Number(entry.issuedAt);
    const info = employees.get(card.employeeId);
    if (!info) continue;
    const nomenclatureId = String(entry.nomenclatureId);
    const itemName = nomName.get(nomenclatureId) ?? '';
    const employeeKey = `${card.employeeId}|${card.kind}`;

    // Позиция нормы этой выдачи: точное совпадение → база размера → нет (выдано сверх нормы).
    const positionIds = positionIdsByEmployee.get(employeeKey) ?? new Set<string>();
    const parentId = parentById.get(nomenclatureId) ?? null;
    const positionId = ppeResolvePositionId({
      nomenclatureId,
      parentId: parentId === nomenclatureId ? null : parentId,
      positionIds,
    });

    const history = historyByEmployee.get(employeeKey) ?? [];
    history.push({ nomenclatureId: positionId ?? nomenclatureId, qty: Number(entry.qty), issuedAt });
    historyByEmployee.set(employeeKey, history);
    if (issuedAt < from || issuedAt > to) continue;
    if (positionId) {
      issuedByEmployeePosition.push({
        employeeId: card.employeeId,
        nomenclatureId: positionId,
        qty: Number(entry.qty),
        kind: card.kind,
      });
    }
    facts.push({
      issuedAt,
      employeeId: card.employeeId,
      kind: card.kind,
      personnelNo: info.personnelNo,
      fullName: info.fullName,
      postTitle: info.postTitle,
      departmentName: info.departmentName,
      nomenclatureId: positionId ?? nomenclatureId,
      itemName,
      size: sizeOfPositionName(itemName) || null,
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
  for (const [employeeKey, merged] of mergedByEmployee) {
    const items = nextIssueDates(merged, historyByEmployee.get(employeeKey) ?? [], now);
    for (const item of items) {
      nextDueAt.set(`${employeeKey}|${item.nomenclatureId}`, item.nextDueAt);
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
