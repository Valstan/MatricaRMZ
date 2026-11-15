/**
 * Данные для ведомости по выдаче СИЗ и заявки на закупку — из клиентской реплики.
 *
 * Источник — те же таблицы `ppe_*` и `erp_*`, из которых строит журнал приёмки и
 * выгрузка для 1С: факты выдачи, нормы карточек и складские остатки уже доезжают
 * по синх-ке, а новая серверная таблица ради выборки — лишний контрактный риск.
 *
 * **База и размер.** Нормы приказа ссылаются на БАЗОВУЮ позицию (`СИЗ-018`),
 * а выдача идёт по конкретному размеру (`СИЗ-018-44`, «…, р. 44»). Поэтому выдача
 * сопоставляется с нормой по правилу: точное совпадение номенклатуры → база
 * размера → «вне нормы». Без этого позиция выданного никогда не сойдётся со своей
 * нормой, а её срок будет «не выдавалось» (нет выдачи в базе — нет и срока).
 *
 * **Период количества — год.** Норма приказа годовая, поэтому «выдано за год»
 * сравнивается с годовой нормой (то же правило, что в журнале приёмки).
 */
import { isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  matchEmployeeSizePosition,
  nextIssueDates,
  pickHumanText,
  PPE_SIZE_ATTRIBUTE_CODES,
  ppeResolvePositionId,
  ppeSizeKindForName,
  resolveEmployeeNorms,
  resolveGroupNorms,
  splitWorkwearSize,
  wearPeriodText,
  type PpeAbsenceInput,
  type PpeIssuedItem,
  type PpeSupplyItem,
  type PpeWearKind,
} from '@matricarmz/shared';

import {
  erpEmployeeCards,
  erpNomenclature,
  erpRegStockBalance,
  ppeAbsences,
  ppeCardNorms,
  ppeEmployeeCards,
  ppeGroupMembers,
  ppeGroupNorms,
  ppeGroups,
  ppeIssueCards,
  ppeIssueEntries,
  ppeNormLines,
} from '../database/schema.js';
import { loadSnapshot } from './reports/context.js';

/** Год — период сравнения выданного с годовой нормой. */
export const PPE_ISSUE_QTY_PERIOD_MS = 365 * 86_400_000;

/** Прочерк вместо названия: позиции может не быть в справочнике, а её id в отчёт попадать не должен. */
const HUMAN_DASH = '—';

export type PpeIssueCoverageData = {
  employees: Array<{
    employeeId: string;
    fullName: string;
    personnelNo: string | null;
    postTitle: string | null;
  }>;
  /** Позиции обеспечения по каждому сотруднику. */
  items: PpeSupplyItem[];
  /** Факты выдачи по размерам — «что именно выдано». */
  issued: PpeIssuedItem[];
  /** Остатки склада СИЗ по номенклатуре (доступный остаток). */
  stockByNomenclature: Map<string, number>;
  /** Цены номенклатуры из EAV. */
  prices: Map<string, number>;
};

/**
 * Размер позиции — из названия: «…, р. 44» → «44», «… (96-100/170-176)» → «96-100/170-176».
 * Отдельной величиной размер не хранится — он есть в названии номенклатуры.
 */
export function sizeOfPositionName(name: string): string | null {
  const text = String(name ?? '').trim();
  if (!text) return null;
  const rp = text.match(/р\.\s*([0-9A-Za-zА-Яа-я][0-9A-Za-zА-Яа-я\-/]*)/);
  if (rp && rp[1]) return rp[1];
  const split = splitWorkwearSize(text);
  return split.size ? split.size : null;
}

type NomRow = { id: string; name: string; parentId: string | null; category: string };

/**
 * Собирает всё, что нужно ведомости по сотрудникам и заявке на закупку.
 */
export async function buildPpeIssueCoverage(
  db: BetterSQLite3Database,
  args: { now?: number; warehouseIds?: string[] } = {},
): Promise<PpeIssueCoverageData> {
  const now = Number(args.now ?? Date.now());
  const periodStart = now - PPE_ISSUE_QTY_PERIOD_MS;
  const warehouseIds = new Set((args.warehouseIds ?? []).map(String).filter((x) => x.length > 0));

  const [nomRows, empRows, ppeCardRows, lineRows, cardRows, cardNormRows, entryRows, groupRows, memberRows, groupNormRows, absenceRows, eav] =
    await Promise.all([
      db.select().from(erpNomenclature).where(isNull(erpNomenclature.deletedAt)).limit(100_000),
      db.select().from(erpEmployeeCards).where(isNull(erpEmployeeCards.deletedAt)).limit(50_000),
      db.select().from(ppeEmployeeCards).where(isNull(ppeEmployeeCards.deletedAt)).limit(50_000),
      db.select().from(ppeNormLines).where(isNull(ppeNormLines.deletedAt)).limit(200_000),
      db.select().from(ppeIssueCards).where(isNull(ppeIssueCards.deletedAt)).limit(50_000),
      db.select().from(ppeCardNorms).where(isNull(ppeCardNorms.deletedAt)).limit(100_000),
      db.select().from(ppeIssueEntries).where(isNull(ppeIssueEntries.deletedAt)).limit(200_000),
      db.select().from(ppeGroups).where(isNull(ppeGroups.deletedAt)).limit(5_000),
      db.select().from(ppeGroupMembers).where(isNull(ppeGroupMembers.deletedAt)).limit(50_000),
      db.select().from(ppeGroupNorms).where(isNull(ppeGroupNorms.deletedAt)).limit(50_000),
      db.select().from(ppeAbsences).where(isNull(ppeAbsences.deletedAt)).limit(50_000),
      loadSnapshot(db),
    ]);

  // ── Номенклатура: имена, база/размер, дерево размерных позиций ──────────────
  const noms = new Map<string, NomRow>();
  for (const n of nomRows as any[]) {
    const id = String(n.id);
    noms.set(id, {
      id,
      name: String(n.name ?? id),
      parentId: n.parentNomenclatureId == null ? null : String(n.parentNomenclatureId),
      category: String(n.category ?? ''),
    });
  }
  const baseOf = (nomenclatureId: string): string => noms.get(nomenclatureId)?.parentId ?? nomenclatureId;
  const childrenByBase = new Map<string, Array<{ id: string; name: string }>>();
  for (const nom of noms.values()) {
    if (!nom.parentId) continue;
    const list = childrenByBase.get(nom.parentId) ?? [];
    list.push({ id: nom.id, name: nom.name });
    childrenByBase.set(nom.parentId, list);
  }

  // ── Сотрудники: ФИО, табельный номер, должность, размеры ──────────────────
  type EmpInfo = {
    employeeId: string;
    fullName: string;
    personnelNo: string | null;
    postTitle: string | null;
    sizeClothes: string | null;
    sizeShoes: string | null;
    height: string | null;
  };
  const employees = new Map<string, EmpInfo>();
  for (const e of empRows as any[]) {
    const id = String(e.id);
    const name = pickHumanText(e.fullName);
    employees.set(id, {
      employeeId: id,
      fullName: name || String(e.fullName ?? ''),
      personnelNo: e.personnelNo == null ? null : String(e.personnelNo),
      postTitle: null,
      sizeClothes: null,
      sizeShoes: null,
      height: null,
    });
  }
  for (const c of ppeCardRows as any[]) {
    const info = employees.get(String(c.employeeId));
    if (info && c.postTitle) info.postTitle = String(c.postTitle);
  }
  // Имена и размеры сотрудника могут жить только в EAV-карточке (карточка заводится на клиенте).
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
      const attrs = eav.attrsByEntity.get(entityId) ?? {};
      const parts = [attrs.last_name, attrs.first_name, attrs.middle_name]
        .map((part) => (part == null ? '' : String(part).trim()))
        .filter(Boolean)
        .join(' ');
      const name = pickHumanText(attrs.full_name, parts);
      // Карточка сотрудника может жить только в EAV — тогда её нет в `erp_employee_cards`.
      const info: EmpInfo = employees.get(entityId) ?? {
        employeeId: entityId,
        fullName: '',
        personnelNo: null,
        postTitle: null,
        sizeClothes: null,
        sizeShoes: null,
        height: null,
      };
      if (name) info.fullName = name;
      info.sizeClothes = readAttr(attrs, PPE_SIZE_ATTRIBUTE_CODES.clothes);
      info.sizeShoes = readAttr(attrs, PPE_SIZE_ATTRIBUTE_CODES.shoes);
      info.height = readAttr(attrs, PPE_SIZE_ATTRIBUTE_CODES.height);
      employees.set(entityId, info);
    }
  }

  // ── Нормы: наборы карточек + нормы групп ──────────────────────────────────
  const setIdsByEmployee = new Map<string, Set<string>>();
  for (const c of cardRows as any[]) {
    const employeeId = String(c.employeeId);
    const set = setIdsByEmployee.get(employeeId) ?? new Set<string>();
    for (const cn of cardNormRows as any[]) {
      if (String(cn.cardId) === String(c.id)) set.add(String(cn.normSetId));
    }
    setIdsByEmployee.set(employeeId, set);
  }
  const activeGroupIds = new Set((groupRows as any[]).map((g) => String(g.id)));
  const groupIdsByEmployee = new Map<string, string[]>();
  for (const m of memberRows as any[]) {
    const groupId = String(m.groupId);
    if (!activeGroupIds.has(groupId)) continue;
    const employeeId = String(m.employeeId);
    groupIdsByEmployee.set(employeeId, [...(groupIdsByEmployee.get(employeeId) ?? []), groupId]);
  }
  const groupNormSetIdsByGroup = new Map<string, string[]>();
  for (const gn of groupNormRows as any[]) {
    const groupId = String(gn.groupId);
    if (!activeGroupIds.has(groupId)) continue;
    groupNormSetIdsByGroup.set(groupId, [...(groupNormSetIdsByGroup.get(groupId) ?? []), String(gn.normSetId)]);
  }
  const linesBySet = new Map<string, any[]>();
  for (const l of lineRows as any[]) {
    const key = String(l.normSetId);
    const list = linesBySet.get(key) ?? [];
    list.push(l);
    linesBySet.set(key, list);
  }
  const absencesByEmployee = new Map<string, PpeAbsenceInput[]>();
  for (const a of absenceRows as any[]) {
    const employeeId = String(a.employeeId);
    absencesByEmployee.set(employeeId, [
      ...(absencesByEmployee.get(employeeId) ?? []),
      { fromMs: Number(a.fromMs), toMs: Number(a.toMs) },
    ]);
  }

  // ── Выдачи: по карточкам сотрудника ───────────────────────────────────────
  const cardEmployee = new Map<string, string>();
  for (const c of cardRows as any[]) cardEmployee.set(String(c.id), String(c.employeeId));
  type EntryFact = {
    employeeId: string;
    nomenclatureId: string;
    qty: number;
    issuedAt: number;
    returnedAt: number | null;
  };
  const entriesByEmployee = new Map<string, EntryFact[]>();
  for (const e of entryRows as any[]) {
    const employeeId = cardEmployee.get(String(e.cardId));
    if (!employeeId) continue;
    const fact: EntryFact = {
      employeeId,
      nomenclatureId: String(e.nomenclatureId),
      qty: Number(e.qty),
      issuedAt: Number(e.issuedAt),
      returnedAt: e.returnedAt == null ? null : Number(e.returnedAt),
    };
    entriesByEmployee.set(employeeId, [...(entriesByEmployee.get(employeeId) ?? []), fact]);
  }

  // ── Позиции обеспечения по сотрудникам ─────────────────────────────────────
  const items: PpeSupplyItem[] = [];
  const issued: PpeIssuedItem[] = [];
  for (const [employeeId, info] of employees) {
    const setIds = setIdsByEmployee.get(employeeId) ?? new Set<string>();
    const groupIds = groupIdsByEmployee.get(employeeId) ?? [];
    const groupNorms: Array<{ groupId: string; normSetId: string }> = [];
    for (const groupId of groupIds) {
      for (const normSetId of groupNormSetIdsByGroup.get(groupId) ?? []) groupNorms.push({ groupId, normSetId });
    }
    const allSetIds = resolveGroupNorms({
      personalNormSetIds: [...setIds],
      memberGroupIds: groupIds,
      groupNorms,
    });
    const input = [];
    for (const setId of allSetIds) {
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
    const facts = entriesByEmployee.get(employeeId) ?? [];

    // Сопоставление выдачи с нормой: точное совпадение → база размера → вне нормы.
    const normIds = new Set(merged.map((m) => m.nomenclatureId));
    const attributed = new Map<string, EntryFact[]>();
    const outOfNorm: EntryFact[] = [];
    for (const fact of facts) {
      const target = ppeResolvePositionId({
        nomenclatureId: fact.nomenclatureId,
        parentId: baseOf(fact.nomenclatureId) === fact.nomenclatureId ? null : baseOf(fact.nomenclatureId),
        positionIds: normIds,
      });
      if (!target) {
        outOfNorm.push(fact);
        continue;
      }
      attributed.set(target, [...(attributed.get(target) ?? []), fact]);
    }

    const statusEntries = [...attributed.entries()].flatMap(([positionId, list]) =>
      list.map((f) => ({
        nomenclatureId: positionId,
        qty: f.qty,
        issuedAt: f.issuedAt,
        returnedAt: f.returnedAt,
      })),
    );
    const plan = nextIssueDates(merged, statusEntries, now, undefined, absencesByEmployee.get(employeeId) ?? []);
    const statusByPosition = new Map(plan.map((p) => [p.nomenclatureId, p] as const));

    for (const position of merged) {
      const positionId = position.nomenclatureId;
      const name = noms.get(positionId)?.name ?? HUMAN_DASH;
      const positionFacts = attributed.get(positionId) ?? [];
      const issuedInPeriod = positionFacts
        .filter((f) => f.issuedAt >= periodStart)
        .reduce((s, f) => s + f.qty, 0);
      const issuedTotal = positionFacts.reduce((s, f) => s + f.qty, 0);

      // Размер: у позиции-размера он свой, у базы — размер сотрудника из карточки.
      const nom = noms.get(positionId);
      let size: string | null = null;
      let sizeId: string | null = null;
      if (nom?.parentId) {
        size = sizeOfPositionName(nom.name);
        sizeId = positionId;
      } else {
        const kind = ppeSizeKindForName(name);
        const sizeValue = kind === 'shoes' ? info.sizeShoes : kind === 'clothes' ? info.sizeClothes : null;
        const children = childrenByBase.get(positionId) ?? [];
        const matchedChildId = sizeValue
          ? matchEmployeeSizePosition({ children, size: sizeValue, height: info.height })
          : null;
        const matchedChild = matchedChildId ? children.find((c) => c.id === matchedChildId) ?? null : null;
        size = (matchedChild ? sizeOfPositionName(matchedChild.name) : null) ?? sizeValue;
        sizeId = matchedChild ? matchedChild.id : null;
      }

      items.push({
        employeeId,
        positionId,
        name,
        size,
        sizeId,
        normQty: position.qty,
        issuedInPeriod,
        issuedTotal,
        status: statusByPosition.get(positionId)?.status ?? 'neverIssued',
        wearText: wearPeriodText(position.wearKind, position.wearMonths),
        nextDueAt: statusByPosition.get(positionId)?.nextDueAt ?? null,
      });
    }

    // Что выдано — по размерам, с привязкой к позиции нормы.
    for (const [positionId, list] of attributed) {
      const positionName = noms.get(positionId)?.name ?? HUMAN_DASH;
      for (const fact of list) {
        issued.push({
          employeeId,
          positionId,
          name: positionName,
          size: sizeOfPositionName(noms.get(fact.nomenclatureId)?.name ?? ''),
          sizeId: fact.nomenclatureId,
          qty: fact.qty,
        });
      }
    }
    // Выдано вне нормы — тоже видно: подпись в получении есть.
    for (const fact of outOfNorm) {
      const ownName = noms.get(fact.nomenclatureId)?.name ?? HUMAN_DASH;
      issued.push({
        employeeId,
        positionId: fact.nomenclatureId,
        name: ownName,
        size: sizeOfPositionName(ownName),
        sizeId: fact.nomenclatureId,
        qty: fact.qty,
      });
    }
  }

  // ── Остатки склада СИЗ и цены ─────────────────────────────────────────────
  const stockByNomenclature = new Map<string, number>();
  const balances = await db.select().from(erpRegStockBalance).limit(200_000);
  for (const b of balances as any[]) {
    const nomId = b.nomenclatureId == null ? null : String(b.nomenclatureId);
    if (!nomId) continue;
    if (noms.get(nomId)?.category !== 'workwear') continue;
    const wh = b.warehouseLocationId == null ? null : String(b.warehouseLocationId);
    if (warehouseIds.size > 0 && (wh == null || !warehouseIds.has(wh))) continue;
    const available = Math.max(0, Number(b.qty ?? 0) - Number(b.reservedQty ?? 0));
    stockByNomenclature.set(nomId, (stockByNomenclature.get(nomId) ?? 0) + available);
  }
  const prices = new Map<string, number>();
  for (const [entityId, attrs] of eav.attrsByEntity) {
    const raw = (attrs as Record<string, unknown> | undefined)?.price;
    const price = Number(raw);
    if (Number.isFinite(price) && price > 0) prices.set(entityId, price);
  }

  return {
    employees: [...employees.values()].map((e) => ({
      employeeId: e.employeeId,
      fullName: e.fullName,
      personnelNo: e.personnelNo,
      postTitle: e.postTitle,
    })),
    items,
    issued,
    stockByNomenclature,
    prices,
  };
}
