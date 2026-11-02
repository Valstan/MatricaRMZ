/**
 * Приказ о СИЗ (Минтруд 767н): профессии, автоподбор норм по должности и личная
 * карточка СИЗ по форме приложения №3.
 *
 * Что здесь и зачем:
 *  - «профессия → норма» (раньше связи не было: `ppe_norm_sets.post_title` — свободный
 *    текст). Справочник `ppe_occupation_ref` + нормализованное сопоставление дают
 *    кладовщику кнопку «назначить нормы по должности» вместо ручного выбора набора;
 *  - личная карточка СИЗ (`ppe_employee_cards`) — форма приложения №3: реквизиты
 *    сотрудника и его размеры на дату выдачи. Это СНИМОК, а не ссылка на карточку
 *    сотрудника: приказ (п. 12) требует зафиксировать ФИО и должность так, как они
 *    были на дату выдачи, а карточка сотрудника может измениться задним числом.
 *
 * Подстановка: значения берутся из карточки сотрудника (EAV + строгая карточка
 * `erp_employee_cards` с атрибутами импорта ЗУП) и кладутся в строгую таблицу
 * личной карточки. Новых EAV-атрибутов не заводим (EAV-freeze, AGENTS.md §EAV):
 * недостающие размеры кладовщик дописывает в самой карточке СИЗ.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { normalizeLookupText } from '@matricarmz/shared';

import { db, pool } from '../database/db.js';
import {
  erpEmployeeCards,
  ppeEmployeeCards,
  ppeNormLineSpecs,
  ppeNormLines,
  ppeNormSets,
  ppeOccupationRef,
  ppePrintTemplates,
} from '../database/schema.js';
import { logInfo } from '../utils/logger.js';

/** Контракт ответа — как в `ppeService`: успех несёт поля прямо, провал — `error`. */
type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Синонимы должностей: в программе должность пишут как «Слесарь-ремонтник»,
 * в приказе — «Слесарь ремонтник», и наоборот. Без синонимов автоподбор молча
 * не нашёл бы норму сотруднику с той же должностью.
 */
const POST_SYNONYMS: ReadonlyArray<readonly [string, string]> = [
  ['слесарь ремонтник', 'слесарь-ремонтник'],
  ['слесарь монтажник', 'слесарь-монтажник'],
  ['слесарьсантехник', 'слесарь-сантехник'],
  ['электромонтер по ремонту электрооборудования', 'электромонтер по ремонту электрооборудования'],
  ['контролер водопроводного хозяйства', 'контролёр водопроводного хозяйства'],
];

/** Ключ должности: ё→е, дефис и пробелы не различаем, порядок слов сохраняем. */
export function postKey(value: string): string {
  const text = normalizeLookupText(value);
  const withDash = text.replace(/\s*-\s*/g, '-');
  for (const [from, to] of POST_SYNONYMS) {
    if (withDash === from) return to;
    if (withDash === to) return from;
  }
  return withDash;
}

/** Ключ без пробелов — для «Слесарь-ремонтник» и «Слесарь ремонтник». */
function postCompactKey(value: string): string {
  return postKey(value).replace(/[\s-]+/g, '');
}

export type PpeOccupation = {
  id: string;
  code: string;
  postTitle: string;
  tonKind: string;
  tonLabel: string | null;
  tonYear: number | null;
};

export async function listPpeOccupations(): Promise<PpeOccupation[]> {
  const rows = await db
    .select()
    .from(ppeOccupationRef)
    .where(and(isNull(ppeOccupationRef.deletedAt), eq(ppeOccupationRef.isActive, true)))
    .orderBy(asc(ppeOccupationRef.code));
  return rows.map((r) => ({
    id: String(r.id),
    code: String(r.code),
    postTitle: String(r.postTitle),
    tonKind: String(r.tonKind),
    tonLabel: r.tonLabel == null ? null : String(r.tonLabel),
    tonYear: r.tonYear == null ? null : Number(r.tonYear),
  }));
}

/**
 * Профессия по должности сотрудника. Сопоставление: сначала точное по нормализованному
 * ключу, затем по ключу без пробелов («Слесарь-ремонтник» = «Слесарь ремонтник»).
 * Несколько совпадений — ничего не выбираем: лучше спросить, чем назначить чужую норму.
 */
export async function findOccupationByPost(postTitle: string): Promise<PpeOccupation | null> {
  const wanted = postKey(postTitle);
  if (!wanted) return null;
  const all = await listPpeOccupations();
  const exact = all.filter((o) => postKey(o.postTitle) === wanted);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;
  const compact = wanted.replace(/[\s-]+/g, '');
  const loose = all.filter((o) => postCompactKey(o.postTitle) === compact);
  return loose.length === 1 ? loose[0]! : null;
}

/** Наборы норм профессии: основной и зимний (766н). */
export async function listNormSetsByOccupation(occupationId: string): Promise<
  Array<{
    id: string;
    name: string;
    sourceKind: string | null;
    sourceLabel: string | null;
    season: string | null;
    gender: string | null;
  }>
> {
  const rows = await db
    .select()
    .from(ppeNormSets)
    .where(and(isNull(ppeNormSets.deletedAt), eq(ppeNormSets.occupationId, occupationId as never)))
    .orderBy(asc(ppeNormSets.validFrom));
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    sourceKind: r.sourceKind == null ? null : String(r.sourceKind),
    sourceLabel: r.sourceLabel == null ? null : String(r.sourceLabel),
    season: r.season == null ? null : String(r.season),
    gender: r.gender == null ? null : String(r.gender),
  }));
}

/**
 * Назначение норм по должности: профессия сотрудника → наборы норм.
 * Возвращает и найденные наборы, и предупреждение, если профессию опознать не удалось —
 * кладовщик должен видеть, ПОЧЕМУ норма не подобралась, а не просто пустой список.
 */
export async function resolveNormsByPost(args: {
  postTitle: string;
  gender?: string | null;
  season?: string | null;
}): Promise<
  Result<{
    occupation: PpeOccupation | null;
    normSetIds: string[];
    normSets: Array<{ id: string; name: string; sourceKind: string | null; sourceLabel: string | null; season: string | null }>;
    warning: string | null;
  }>
> {
  try {
    const occupation = await findOccupationByPost(args.postTitle);
    if (!occupation) {
      return {
        ok: true,
        occupation: null,
        normSetIds: [],
        normSets: [],
        warning: `Профессия «${args.postTitle}» не найдена в справочнике приказа — норму выберите вручную`,
      };
    }
    const all = await listNormSetsByOccupation(occupation.id);
    // Пол и сезон набора режут так же, как в существующем ядре (NULL = подходит всем):
    // приказ (п. 11) различает нормы по полу и сезону. Зимний набор 766н — по сезону.
    const gender = args.gender ?? null;
    const season = args.season ?? null;
    const kept = all.filter((s) => {
      if (s.gender != null && gender != null && s.gender !== gender) return false;
      if (s.season != null && season != null && s.season !== season) return false;
      return true;
    });
    // Если сезон/пол отсеяли всё — берём наборы без условий: лучше лишний набор,
    // чем норма не назначена вовсе (и кладовщик увидит предупреждение).
    const normSets = kept.length > 0 ? kept : all.filter((s) => s.gender == null && s.season == null);
    return {
      ok: true,
      occupation,
      normSetIds: normSets.map((s) => s.id),
      normSets,
      warning:
        normSets.length === 0 ? `По профессии «${occupation.postTitle}» наборы норм не заведены` : null,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── Личная карточка СИЗ (форма приложения №3) ─────────────────────────────────

type AttrRow = { code: string | null; value_json: string | null };

function parseEav(raw: string | null): string {
  if (raw == null) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed == null) return '';
    return typeof parsed === 'string' ? parsed : String(parsed);
  } catch {
    return String(raw);
  }
}

/**
 * Реквизиты сотрудника для подстановки в личную карточку СИЗ.
 * Три источника: EAV-карточка (ФИО, табельный, должность, подразделение, даты,
 * размеры одежды/обуви и рост), строгая карточка `erp_employee_cards` (атрибуты
 * импорта ЗУП: пол, дата приёма) и нормы приказа (профессия по должности).
 */
export type EmployeeRequisites = {
  fullName: string;
  lastName: string;
  firstName: string;
  middleName: string;
  personnelNo: string;
  departmentId: string | null;
  departmentName: string;
  postTitle: string;
  occupationId: string | null;
  gender: string | null;
  height: string;
  sizeClothes: string;
  sizeShoes: string;
  hireDate: number | null;
  positionChangedDate: number | null;
  employeeCardId: string;
};

async function loadEmployeeRequisites(employeeId: string): Promise<EmployeeRequisites | null> {
  const cardRows = await db
    .select()
    .from(erpEmployeeCards)
    .where(and(isNull(erpEmployeeCards.deletedAt), eq(erpEmployeeCards.id, employeeId as never)))
    .limit(1);
  const card = cardRows[0];
  if (!card) return null;

  const attrs = new Map<string, string>();
  if (card.entityId) {
    const rows = await pool.query<AttrRow>(
      `select d.code as code, v.value_json as value_json
         from attribute_values v
         join attribute_defs d on d.id = v.attribute_def_id and d.deleted_at is null
        where v.entity_id = $1 and v.deleted_at is null`,
      [String(card.entityId)],
    );
    for (const r of rows.rows) {
      if (r.code) attrs.set(r.code, parseEav(r.value_json));
    }
  }

  // Атрибуты импорта ЗУП лежат в attrs_json строгой карточки: пол и даты приёма.
  let importAttrs: Record<string, unknown> = {};
  if (card.attrsJson) {
    try {
      const parsed = JSON.parse(String(card.attrsJson));
      if (parsed && typeof parsed === 'object') importAttrs = parsed as Record<string, unknown>;
    } catch {
      importAttrs = {};
    }
  }

  const lastName = (attrs.get('last_name') ?? '').trim();
  const firstName = (attrs.get('first_name') ?? '').trim();
  const middleName = (attrs.get('middle_name') ?? '').trim();
  const fullName =
    [lastName, firstName, middleName].filter(Boolean).join(' ') || String(card.fullName ?? '').trim();

  const postTitle = (attrs.get('role') ?? '').trim() || String(card.roleCode ?? '').trim();
  const occupation = postTitle ? await findOccupationByPost(postTitle) : null;

  const departmentId = (attrs.get('department_id') ?? '').trim() || null;
  const departmentName = String(importAttrs['department'] ?? '').trim();

  const hireDate = parseDateLike(attrs.get('hire_date')) ?? parseDateLike(importAttrs['hireDate']);

  // Дата изменения профессии (должности) или перевода — последний перевод по должности.
  const positionChangedDate = lastPositionTransfer(attrs.get('transfers') ?? null);

  return {
    fullName,
    lastName,
    firstName,
    middleName,
    personnelNo: (attrs.get('personnel_number') ?? '').trim() || String(card.personnelNo ?? '').trim(),
    departmentId,
    departmentName,
    postTitle,
    occupationId: occupation?.id ?? null,
    gender: normalizeGender(importAttrs['gender']) ?? normalizeGender(attrs.get('gender') ?? null),
    height: (attrs.get('ppe_height') ?? '').trim(),
    sizeClothes: (attrs.get('ppe_size_clothes') ?? '').trim(),
    sizeShoes: (attrs.get('ppe_size_shoes') ?? '').trim(),
    hireDate,
    positionChangedDate,
    employeeCardId: String(card.id),
  };
}

/** Дата вида «2026-01-31» или «31.01.2026» → epoch-мс. */
function parseDateLike(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 1e12 ? raw : null;
  const text = String(raw).trim();
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const ru = text.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (ru) return Date.UTC(Number(ru[3]), Number(ru[2]) - 1, Number(ru[1]));
  return null;
}

/** Пол в виде «М»/«F» (как ждёт норма) из «м»/«ж»/«M»/«F». */
export function normalizeGender(raw: unknown): string | null {
  const text = normalizeLookupText(String(raw ?? ''));
  if (!text) return null;
  if (text === 'м' || text === 'муж' || text === 'мужской' || text === 'm') return 'M';
  if (text === 'ж' || text === 'жен' || text === 'женский' || text === 'f') return 'F';
  return null;
}

/**
 * Последний перевод по должности из массива переводов карточки сотрудника.
 * Формат перевода — {kind, date, value}; kind 'position' — смена должности.
 */
function lastPositionTransfer(raw: string | null): number | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  let best: number | null = null;
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as { kind?: unknown; date?: unknown };
    if (String(rec.kind ?? '') !== 'position') continue;
    const at = parseDateLike(rec.date);
    if (at != null && (best == null || at > best)) best = at;
  }
  return best;
}

export type PpeEmployeeCardDto = {
  id: string;
  employeeId: string;
  fullName: string | null;
  lastName: string | null;
  firstName: string | null;
  middleName: string | null;
  personnelNo: string | null;
  departmentId: string | null;
  departmentName: string | null;
  occupationId: string | null;
  postTitle: string | null;
  gender: string | null;
  height: string | null;
  sizeClothes: string | null;
  sizeShoes: string | null;
  sizeGloves: string | null;
  sizeHeadgear: string | null;
  sizeRespirator: string | null;
  sizeOd: string | null;
  sizeHands: string | null;
  hireDate: number | null;
  positionChangedDate: number | null;
  occupationNotes: string | null;
  issuedBy: string | null;
  preparedBy: string | null;
  preparedAt: number | null;
};

function toDto(row: typeof ppeEmployeeCards.$inferSelect): PpeEmployeeCardDto {
  return {
    id: String(row.id),
    employeeId: String(row.employeeId),
    fullName: row.fullName == null ? null : String(row.fullName),
    lastName: row.lastName == null ? null : String(row.lastName),
    firstName: row.firstName == null ? null : String(row.firstName),
    middleName: row.middleName == null ? null : String(row.middleName),
    personnelNo: row.personnelNo == null ? null : String(row.personnelNo),
    departmentId: row.departmentId == null ? null : String(row.departmentId),
    departmentName: row.departmentName == null ? null : String(row.departmentName),
    occupationId: row.occupationId == null ? null : String(row.occupationId),
    postTitle: row.postTitle == null ? null : String(row.postTitle),
    gender: row.gender == null ? null : String(row.gender),
    height: row.height == null ? null : String(row.height),
    sizeClothes: row.sizeClothes == null ? null : String(row.sizeClothes),
    sizeShoes: row.sizeShoes == null ? null : String(row.sizeShoes),
    sizeGloves: row.sizeGloves == null ? null : String(row.sizeGloves),
    sizeHeadgear: row.sizeHeadgear == null ? null : String(row.sizeHeadgear),
    sizeRespirator: row.sizeRespirator == null ? null : String(row.sizeRespirator),
    sizeOd: row.sizeOd == null ? null : String(row.sizeOd),
    sizeHands: row.sizeHands == null ? null : String(row.sizeHands),
    hireDate: row.hireDate == null ? null : Number(row.hireDate),
    positionChangedDate: row.positionChangedDate == null ? null : Number(row.positionChangedDate),
    occupationNotes: row.occupationNotes == null ? null : String(row.occupationNotes),
    issuedBy: row.issuedBy == null ? null : String(row.issuedBy),
    preparedBy: row.preparedBy == null ? null : String(row.preparedBy),
    preparedAt: row.preparedAt == null ? null : Number(row.preparedAt),
  };
}

/**
 * Личная карточка СИЗ сотрудника. Если карточки нет — она заводится по факту
 * (первая выдача или назначение норм), как `ppe_issue_cards`.
 */
export async function getPpeEmployeeCard(
  employeeId: string,
): Promise<Result<{ card: PpeEmployeeCardDto; requisites: EmployeeRequisites | null }>> {
  try {
    const id = String(employeeId ?? '').trim();
    if (!id) return { ok: false, error: 'employeeId обязателен' };
    const rows = await db
      .select()
      .from(ppeEmployeeCards)
      .where(and(isNull(ppeEmployeeCards.deletedAt), eq(ppeEmployeeCards.employeeId, id as never)))
      .limit(1);
    const requisites = await loadEmployeeRequisites(id);
    if (!rows[0]) {
      if (!requisites) return { ok: false, error: 'Сотрудник не найден' };
      const created = await createEmployeeCard(requisites);
      return { ok: true, card: created, requisites };
    }
    const card = toDto(rows[0]);
    if (requisites) {
      card.postTitle = requisites.postTitle || null;
      card.departmentName = requisites.departmentName || null;
    }
    return { ok: true, card, requisites };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Заведение карточки по реквизитам сотрудника (значения — снимок на момент). */
async function createEmployeeCard(req: EmployeeRequisites): Promise<PpeEmployeeCardDto> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.insert(ppeEmployeeCards).values({
    id,
    employeeId: req.employeeCardId,
    fullName: req.fullName || null,
    lastName: req.lastName || null,
    firstName: req.firstName || null,
    middleName: req.middleName || null,
    personnelNo: req.personnelNo || null,
    departmentId: req.departmentId,
    departmentName: req.departmentName || null,
    postTitle: req.postTitle || null,
    occupationId: req.occupationId,
    gender: req.gender,
    height: req.height || null,
    sizeClothes: req.sizeClothes || null,
    sizeShoes: req.sizeShoes || null,
    hireDate: req.hireDate,
    positionChangedDate: req.positionChangedDate,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    syncStatus: 'pending',
  });
  return {
    id,
    employeeId: req.employeeCardId,
    fullName: req.fullName || null,
    lastName: req.lastName || null,
    firstName: req.firstName || null,
    middleName: req.middleName || null,
    personnelNo: req.personnelNo || null,
    departmentId: req.departmentId,
    departmentName: req.departmentName || null,
    occupationId: req.occupationId,
    postTitle: req.postTitle || null,
    gender: req.gender,
    height: req.height || null,
    sizeClothes: req.sizeClothes || null,
    sizeShoes: req.sizeShoes || null,
    sizeGloves: null,
    sizeHeadgear: null,
    sizeRespirator: null,
    sizeOd: null,
    sizeHands: null,
    hireDate: req.hireDate,
    positionChangedDate: req.positionChangedDate,
    occupationNotes: null,
    issuedBy: null,
    preparedBy: null,
    preparedAt: null,
  };
}

/**
 * Правка реквизитов личной карточки (размеры, примечания, подписи).
 * Поля — с `| undefined`: `exactOptionalPropertyTypes` в проекте, а zod отдаёт
 * отсутствующее поле именно как `undefined`.
 */
export type PpeEmployeeCardPatch = {
  fullName?: string | null | undefined;
  lastName?: string | null | undefined;
  firstName?: string | null | undefined;
  middleName?: string | null | undefined;
  personnelNo?: string | null | undefined;
  departmentId?: string | null | undefined;
  departmentName?: string | null | undefined;
  postTitle?: string | null | undefined;
  occupationId?: string | null | undefined;
  gender?: string | null | undefined;
  height?: string | null | undefined;
  sizeClothes?: string | null | undefined;
  sizeShoes?: string | null | undefined;
  sizeGloves?: string | null | undefined;
  sizeHeadgear?: string | null | undefined;
  sizeRespirator?: string | null | undefined;
  sizeOd?: string | null | undefined;
  sizeHands?: string | null | undefined;
  hireDate?: number | null | undefined;
  positionChangedDate?: number | null | undefined;
  occupationNotes?: string | null | undefined;
  issuedBy?: string | null | undefined;
  preparedBy?: string | null | undefined;
  preparedAt?: number | null | undefined;
};

export async function updatePpeEmployeeCard(
  id: string,
  patch: PpeEmployeeCardPatch,
): Promise<Result<{ card: PpeEmployeeCardDto }>> {
  try {
    const cardId = String(id ?? '').trim();
    if (!cardId) return { ok: false, error: 'id обязателен' };
    const values: Record<string, unknown> = { updatedAt: Date.now(), syncStatus: 'pending' };
    const set = <K extends string>(key: K, value: unknown) => {
      if (value !== undefined) values[key] = value;
    };
    set('fullName', patch.fullName);
    set('lastName', patch.lastName);
    set('firstName', patch.firstName);
    set('middleName', patch.middleName);
    set('personnelNo', patch.personnelNo);
    set('departmentId', patch.departmentId);
    set('departmentName', patch.departmentName);
    set('postTitle', patch.postTitle);
    set('occupationId', patch.occupationId);
    set('gender', patch.gender);
    set('height', patch.height);
    set('sizeClothes', patch.sizeClothes);
    set('sizeShoes', patch.sizeShoes);
    set('sizeGloves', patch.sizeGloves);
    set('sizeHeadgear', patch.sizeHeadgear);
    set('sizeRespirator', patch.sizeRespirator);
    set('sizeOd', patch.sizeOd);
    set('sizeHands', patch.sizeHands);
    set('hireDate', patch.hireDate);
    set('positionChangedDate', patch.positionChangedDate);
    set('occupationNotes', patch.occupationNotes);
    set('issuedBy', patch.issuedBy);
    set('preparedBy', patch.preparedBy);
    set('preparedAt', patch.preparedAt);
    const rows = await db
      .update(ppeEmployeeCards)
      .set(values as never)
      .where(eq(ppeEmployeeCards.id, cardId as never))
      .returning();
    if (!rows[0]) return { ok: false, error: 'Карточка не найдена' };
    return { ok: true, card: toDto(rows[0]) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Строки нормы для печати личной карточки: наименование СИЗ, пункт приказа, единица
 * измерения и количество на год — те самые четыре колонки формы приложения №3.
 *
 * Строка приказа (`ppe_norm_line_specs`) — источник правды по наименованию, пункту и
 * единице; количество и форма срока — из строки набора норм (`ppe_norm_lines`).
 */
export type PpeCardNormRow = {
  name: string;
  sourceLabel: string | null;
  unit: string | null;
  qty: number;
  wearKind: string | null;
  wearMonths: number | null;
  qtyText: string;
};

export async function listCardNormRows(normSetIds: string[]): Promise<PpeCardNormRow[]> {
  const ids = [...new Set((normSetIds ?? []).map((v) => String(v).trim()).filter(Boolean))];
  if (ids.length === 0) return [];
  const lines = await db
    .select()
    .from(ppeNormLines)
    .where(and(isNull(ppeNormLines.deletedAt), inArray(ppeNormLines.normSetId, ids as never[])));
  if (lines.length === 0) return [];

  const specIds = [...new Set(lines.map((l) => String(l.specId ?? '')).filter(Boolean))];
  const specs = new Map<string, typeof ppeNormLineSpecs.$inferSelect>();
  if (specIds.length > 0) {
    const specRows = await db
      .select()
      .from(ppeNormLineSpecs)
      .where(and(isNull(ppeNormLineSpecs.deletedAt), inArray(ppeNormLineSpecs.id, specIds as never[])));
    for (const s of specRows) specs.set(String(s.id), s);
  }
  const setIds = [...new Set(lines.map((l) => String(l.normSetId)))];
  const sets = new Map<string, typeof ppeNormSets.$inferSelect>();
  const setRows = await db
    .select()
    .from(ppeNormSets)
    .where(and(isNull(ppeNormSets.deletedAt), inArray(ppeNormSets.id, setIds as never[])));
  for (const s of setRows) sets.set(String(s.id), s);

  const out: PpeCardNormRow[] = [];
  for (const line of lines) {
    const spec = line.specId ? specs.get(String(line.specId)) : undefined;
    const set = sets.get(String(line.normSetId));
    const sourceLabel = spec?.sourceLabel ?? set?.sourceLabel ?? null;
    const qty = Number(line.qty);
    const wearKind = line.wearKind == null ? null : String(line.wearKind);
    const wearMonths = line.wearMonths == null ? null : Number(line.wearMonths);
    const unit = line.unit == null ? (spec?.unit ?? null) : String(line.unit);
    out.push({
      name: spec ? String(spec.name) : '',
      sourceLabel,
      unit,
      qty,
      wearKind,
      wearMonths,
      qtyText: formatQty(qty, unit, wearKind, wearMonths),
    });
  }
  return out;
}

/** «Количество на год» в приказной записи: «1 шт.», «12 пар», «до износа». */
function formatQty(qty: number, unit: string | null, wearKind: string | null, wearMonths: number | null): string {
  if (wearKind === 'until_wearout') return 'до износа';
  const base = `${qty} ${unit ?? 'шт.'}`;
  if (wearKind === 'by_manufacturer') return `${base} срок определяется документами изготовителя`;
  if (wearMonths == null) return base;
  const years = wearMonths / 12;
  if (!Number.isInteger(years)) return `${base} на ${wearMonths} мес.`;
  return `${base} на ${years} ${years === 1 ? 'год' : 'года'}`;
}

// ── Шаблоны печатных форм ────────────────────────────────────────────────────

export type PpePrintTemplateDto = {
  id: string;
  ownerId: string;
  formKey: string;
  name: string;
  layoutJson: string;
  isDefault: boolean;
  updatedAt: number;
  updatedBy: string | null;
};

/**
 * Шаблоны печатных форм: общий (`ownerId='shared'`) и личные. Личный перекрывает
 * общий по ключу формы — поэтому список отдаём в порядке «сначала личные».
 */
export async function listPpePrintTemplates(args: {
  formKey: string;
  ownerId: string;
}): Promise<PpePrintTemplateDto[]> {
  const formKey = String(args.formKey ?? '').trim();
  if (!formKey) return [];
  const rows = await db
    .select()
    .from(ppePrintTemplates)
    .where(and(isNull(ppePrintTemplates.deletedAt), eq(ppePrintTemplates.formKey, formKey)));
  const visible = rows.filter((r) => r.ownerId === 'shared' || r.ownerId === args.ownerId);
  return visible
    .map((r) => ({
      id: String(r.id),
      ownerId: String(r.ownerId),
      formKey: String(r.formKey),
      name: String(r.name),
      layoutJson: String(r.layoutJson),
      isDefault: r.isDefault === true,
      updatedAt: Number(r.updatedAt),
      updatedBy: r.updatedBy == null ? null : String(r.updatedBy),
    }))
    .sort((a, b) => (a.ownerId === 'shared' ? 1 : 0) - (b.ownerId === 'shared' ? 1 : 0));
}

export async function savePpePrintTemplate(input: {
  id?: string;
  ownerId: string;
  formKey: string;
  name: string;
  layoutJson: string;
  isDefault?: boolean;
  updatedBy?: string;
}): Promise<Result<{ id: string }>> {
  try {
    const formKey = String(input.formKey ?? '').trim();
    const name = String(input.name ?? '').trim();
    const ownerId = String(input.ownerId ?? 'shared').trim() || 'shared';
    if (!formKey) return { ok: false, error: 'formKey обязателен' };
    if (!name) return { ok: false, error: 'name обязателен' };
    const layoutJson = String(input.layoutJson ?? '').trim();
    if (!layoutJson) return { ok: false, error: 'layoutJson обязателен' };
    // Ломаный JSON не должен молча уронить шаблон — проверяем здесь, на двери.
    try {
      JSON.parse(layoutJson);
    } catch {
      return { ok: false, error: 'layoutJson — не корректный JSON' };
    }
    const now = Date.now();
    const id = String(input.id ?? '').trim() || crypto.randomUUID();
    const existing = await db
      .select({ id: ppePrintTemplates.id })
      .from(ppePrintTemplates)
      .where(eq(ppePrintTemplates.id, id as never))
      .limit(1);
    if (existing.length > 0) {
      await db
        .update(ppePrintTemplates)
        .set({
          name,
          layoutJson,
          isDefault: input.isDefault === true,
          updatedAt: now,
          updatedBy: input.updatedBy ?? null,
          syncStatus: 'pending',
          deletedAt: null,
        } as never)
        .where(eq(ppePrintTemplates.id, id as never));
    } else {
      await db.insert(ppePrintTemplates).values({
        id,
        ownerId,
        formKey,
        name,
        layoutJson,
        isDefault: input.isDefault === true,
        updatedAt: now,
        updatedBy: input.updatedBy ?? null,
        createdAt: now,
        deletedAt: null,
        syncStatus: 'pending',
      });
    }
    logInfo('ppe print template saved', { formKey, ownerId, name });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deletePpePrintTemplate(id: string): Promise<Result<{ deleted: true }>> {
  try {
    const templateId = String(id ?? '').trim();
    if (!templateId) return { ok: false, error: 'id обязателен' };
    const now = Date.now();
    await db
      .update(ppePrintTemplates)
      .set({ deletedAt: now, updatedAt: now, syncStatus: 'pending' } as never)
      .where(eq(ppePrintTemplates.id, templateId as never));
    return { ok: true, deleted: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
