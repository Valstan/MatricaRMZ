import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  SCRAP_CRITERION_ATTR_CODE,
  SCRAP_CRITERION_ATTR_NAME,
  createScrapCriterionSet,
  isEavFlagSet,
  normalizeScrapPartName,
  type ScrapCriterionSet,
} from '@matricarmz/shared';

import { attributeDefs, attributeValues, entities, entityTypes, erpEngineInventoryLines, erpNomenclature } from '../database/schema.js';
import { setEntityAttribute } from './entityService.js';
import { SettingsKey, settingsGetString, settingsSetString } from './settingsStore.js';

/**
 * Набор деталей-критериев утиля — читается из локальной базы клиента.
 *
 * Метка живёт на карточке детали (справочник «Детали» → карточка детали →
 * атрибут `scrap_criterion`). Строки списка деталей двигателя ссылаются на
 * номенклатурные позиции, поэтому набор держит оба пространства id: id
 * детали справочника и id номенклатурной позиции, плюс нормализованные имена
 * для старых строк актов, где id не записан.
 *
 * Читается из локальной базы — значит, работает офлайн: признак утиля
 * двигателя не зависит от связи с сервером.
 */

/** Набор критериев + карта «номенклатурная позиция → деталь справочника». */
export type ScrapCriterionIndex = {
  /** Набор для правила (id обоих пространств + имена). */
  set: ScrapCriterionSet;
  /** Номенклатурный id → id детали справочника (нужен для строк актов по id). */
  nomenclatureToPart: Map<string, string>;
  /** Помеченные детали: id детали справочника, имя, номенклатурные id. */
  parts: Array<{ partId: string; name: string; nomenclatureIds: string[] }>;
  /** Подпись состояния набора — для кэша: меняется, когда метку поставили/сняли. */
  stamp: string;
};

type CachedIndex = { stamp: string; index: ScrapCriterionIndex };

let cached: CachedIndex | null = null;

/** Сбросить кэш набора (после смены метки на карточке детали). */
export function invalidateScrapCriterionIndex(): void {
  cached = null;
}

function parseJson(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function getPartTypeId(db: BetterSQLite3Database): Promise<string | null> {
  const rows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, 'part'), isNull(entityTypes.deletedAt)))
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

/** Сообщение об ошибке — один раз: полоса гонок и отчёты не должны сыпать лог. */
const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

/**
 * Наполняет набор критериями по умолчанию: детали, в названии которых есть
 * «картер» — историческое правило D-#9 (картер в утиле уводил двигатель в
 * утиль). Переносим его в глобальный набор, чтобы картер был обычной
 * деталью-критерием: метка стоит на карточке детали, видна в фильтре
 * «Только утильные детали» и считается сухим прогоном.
 *
 * Одноразово на базу клиента (флаг в настройках): снятую владельцем метку
 * наполнение не возвращает. Помеченные детали уезжают на сервер общим
 * каналом атрибутов — остальной парк подхватит их при следующем pull.
 */
export async function seedScrapCriterionParts(
  db: BetterSQLite3Database,
): Promise<{ ok: true; marked: number; parts: Array<{ partId: string; name: string }>; skipped?: 'already-seeded' } | { ok: false; error: string }> {
  try {
    const seeded = (await settingsGetString(db, SettingsKey.ScrapCriterionSeeded).catch(() => null)) ?? '';
    if (String(seeded).trim() === '1') return { ok: true, marked: 0, parts: [], skipped: 'already-seeded' };

    const partTypeId = await getPartTypeId(db);
    if (!partTypeId) return { ok: false, error: 'Не найден тип справочника «детали»' };
    const defId = await ensureScrapCriterionDef(db, partTypeId);
    if (!defId) return { ok: false, error: 'Не удалось завести атрибут «уводит двигатель в утиль»' };

    // Детали-картеры: номенклатурные позиции деталей с «картер» в названии.
    const nomRows = await db
      .select({ id: erpNomenclature.id, name: erpNomenclature.name, refId: erpNomenclature.directoryRefId })
      .from(erpNomenclature)
      .where(and(eq(erpNomenclature.directoryKind, 'part'), isNull(erpNomenclature.deletedAt)));

    const candidates = new Map<string, string>();
    for (const row of nomRows) {
      const name = String(row.name ?? '').trim();
      if (!name || !isCrankcaseCriterionName(name)) continue;
      const partId = String(row.refId ?? '').trim() || String(row.id ?? '').trim();
      if (partId) candidates.set(partId, name);
    }

    const marked: Array<{ partId: string; name: string }> = [];
    for (const [partId, name] of candidates) {
      if (await readCriterionEnabled(db, partId)) continue;
      const written = await setScrapCriterionFlag(db, partId, true);
      if (written.ok) marked.push({ partId, name });
    }
    await settingsSetString(db, SettingsKey.ScrapCriterionSeeded, '1');
    invalidateScrapCriterionIndex();
    return { ok: true, marked: marked.length, parts: marked };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Имя детали-критерия по умолчанию: картер. Подстрока, а не точное имя —
 * картеры заводят и как «Картер верхний», и как «Картер блока цилиндров».
 */
export function isCrankcaseCriterionName(name: string | null | undefined): boolean {
  return normalizeScrapPartName(name).includes('картер');
}

/**
 * Набор критериев из локальной базы. Кэш держится по подписи состояния
 * (сколько меток и когда менялись): переставил галку — подпись сменилась,
 * набор пересобран, а не «протух по таймеру».
 */
export async function loadScrapCriterionIndex(db: BetterSQLite3Database): Promise<ScrapCriterionIndex> {
  try {
    const index = await readScrapCriterionIndex(db);
    // Набор пуст — наполняем его картерными деталями (одноразово на базу).
    // Так картер работает по общему правилу, а не по подстроке в имени строки.
    if (index.parts.length === 0) {
      const seeded = await seedScrapCriterionParts(db);
      if (seeded.ok && seeded.marked > 0) return await readScrapCriterionIndex(db);
    }
    return index;
  } catch (e) {
    // Набор критериев — дополнение к признаку утиля, а не условие его работы:
    // нет таблиц (старая база, тестовая фикстура) — признак просто не применяется.
    warnOnce(`scrap criterion index unavailable: ${String(e)}`);
    return emptyIndex();
  }
}

async function readScrapCriterionIndex(db: BetterSQLite3Database): Promise<ScrapCriterionIndex> {
  const partTypeId = await getPartTypeId(db);
  if (!partTypeId) return emptyIndex();

  const defRows = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(
      and(
        eq(attributeDefs.entityTypeId, partTypeId),
        eq(attributeDefs.code, SCRAP_CRITERION_ATTR_CODE),
        isNull(attributeDefs.deletedAt),
      ),
    )
    .limit(1);
  const defId = defRows[0]?.id ? String(defRows[0].id) : null;
  if (!defId) return emptyIndex();

  const valueRows = await db
    .select({
      entityId: attributeValues.entityId,
      valueJson: attributeValues.valueJson,
      updatedAt: attributeValues.updatedAt,
    })
    .from(attributeValues)
    .where(and(eq(attributeValues.attributeDefId, defId), isNull(attributeValues.deletedAt)));

  const partIds: string[] = [];
  let maxUpdatedAt = 0;
  for (const row of valueRows) {
    if (!isEavFlagSet(parseJson(row.valueJson))) continue;
    const id = String(row.entityId ?? '').trim();
    if (!id) continue;
    partIds.push(id);
    const updatedAt = Number(row.updatedAt ?? 0);
    if (Number.isFinite(updatedAt) && updatedAt > maxUpdatedAt) maxUpdatedAt = updatedAt;
  }
  const stamp = `${partIds.length}:${maxUpdatedAt}`;
  if (cached && cached.stamp === stamp) return cached.index;
  if (partIds.length === 0) {
    cached = { stamp, index: emptyIndex(stamp) };
    return cached.index;
  }

  // Имена деталей — из их карточек (EAV): номенклатурная позиция может ещё
  // не быть заведена, а имя нужно для сопоставления старых строк актов.
  const nameByPart = await readPartNames(db, partTypeId, partIds);
  const nomRows = await db
    .select({ id: erpNomenclature.id, name: erpNomenclature.name, refId: erpNomenclature.directoryRefId })
    .from(erpNomenclature)
    .where(
      and(
        eq(erpNomenclature.directoryKind, 'part'),
        inArray(erpNomenclature.directoryRefId, partIds),
        isNull(erpNomenclature.deletedAt),
      ),
    );

  const nomenclatureToPart = new Map<string, string>();
  const nomIdsByPart = new Map<string, string[]>();
  const names: string[] = [];
  for (const partId of partIds) {
    const name = nameByPart.get(partId) ?? '';
    if (name) names.push(name);
  }
  for (const row of nomRows) {
    const partId = String(row.refId ?? '').trim();
    if (!partId) continue;
    const nomId = String(row.id ?? '').trim();
    if (!nomId) continue;
    nomenclatureToPart.set(nomId, partId);
    const list = nomIdsByPart.get(partId) ?? [];
    list.push(nomId);
    nomIdsByPart.set(partId, list);
    const name = String(row.name ?? '').trim();
    if (name && !names.includes(name)) names.push(name);
  }

  const allIds: string[] = [...partIds];
  for (const nomId of nomenclatureToPart.keys()) allIds.push(nomId);
  const set = createScrapCriterionSet(allIds, names);
  const parts = partIds.map((partId) => ({
    partId,
    name: nameByPart.get(partId) ?? '',
    nomenclatureIds: nomIdsByPart.get(partId) ?? [],
  }));

  const index: ScrapCriterionIndex = { set, nomenclatureToPart, parts, stamp };
  cached = { stamp, index };
  return index;
}

function emptyIndex(stamp = '0:0'): ScrapCriterionIndex {
  return {
    set: createScrapCriterionSet([], []),
    nomenclatureToPart: new Map(),
    parts: [],
    stamp,
  };
}

/**
 * Имена деталей из их карточек (EAV). Номенклатурная позиция может ещё не быть
 * заведена, а имя нужно для сопоставления старых строк актов, где id не записан.
 */
async function readPartNames(
  db: BetterSQLite3Database,
  partTypeId: string,
  partIds: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (partIds.length === 0) return out;
  const nameDefRows = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(
      and(
        eq(attributeDefs.entityTypeId, partTypeId),
        eq(attributeDefs.code, 'name'),
        isNull(attributeDefs.deletedAt),
      ),
    )
    .limit(1);
  const nameDefId = nameDefRows[0]?.id ? String(nameDefRows[0].id) : null;
  if (!nameDefId) return out;
  const nameRows = await db
    .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(
      and(
        eq(attributeValues.attributeDefId, nameDefId),
        inArray(attributeValues.entityId, [...partIds]),
        isNull(attributeValues.deletedAt),
      ),
    );
  for (const row of nameRows) {
    const name = String(parseJson(row.valueJson) ?? '').trim();
    if (name) out.set(String(row.entityId ?? ''), name);
  }
  return out;
}

/**
 * Детали для сухого прогона: имя и номенклатурные позиции. Работает и для
 * деталей, которых ещё нет в наборе, — иначе «сколько двигателей затронет»
 * нельзя было бы узнать до включения метки.
 */
export async function resolveCriterionParts(
  db: BetterSQLite3Database,
  partIds: ReadonlyArray<string>,
): Promise<Array<{ partId: string; name: string; nomenclatureIds: string[] }>> {
  const ids = [...new Set(partIds.map((id) => String(id ?? '').trim()).filter(Boolean))];
  if (ids.length === 0) return [];
  const partTypeId = await getPartTypeId(db);
  const nameByPart = partTypeId ? await readPartNames(db, partTypeId, ids) : new Map<string, string>();
  const nomRows = await db
    .select({ id: erpNomenclature.id, name: erpNomenclature.name, refId: erpNomenclature.directoryRefId })
    .from(erpNomenclature)
    .where(
      and(
        eq(erpNomenclature.directoryKind, 'part'),
        inArray(erpNomenclature.directoryRefId, ids),
        isNull(erpNomenclature.deletedAt),
      ),
    );
  const nomIdsByPart = new Map<string, string[]>();
  const nomNameByPart = new Map<string, string>();
  for (const row of nomRows) {
    const partId = String(row.refId ?? '').trim();
    if (!partId) continue;
    const nomId = String(row.id ?? '').trim();
    if (!nomId) continue;
    const list = nomIdsByPart.get(partId) ?? [];
    list.push(nomId);
    nomIdsByPart.set(partId, list);
    const name = String(row.name ?? '').trim();
    if (name && !nomNameByPart.has(partId)) nomNameByPart.set(partId, name);
  }
  return ids.map((partId) => ({
    partId,
    name: nameByPart.get(partId) ?? nomNameByPart.get(partId) ?? '',
    nomenclatureIds: nomIdsByPart.get(partId) ?? [],
  }));
}

/** Текущее состояние метки по детали — для карточки детали. */
export async function getScrapCriterionState(
  db: BetterSQLite3Database,
  partIdInput: string,
): Promise<
  | { ok: true; enabled: boolean; partId: string | null; name: string; engines: number; lines: number }
  | { ok: false; error: string }
> {
  const partId = await resolvePartEntityId(db, partIdInput);
  if (!partId) return { ok: false, error: 'Деталь не найдена' };
  const enabled = await readCriterionEnabled(db, partId);
  const parts = await resolveCriterionParts(db, [partId]);
  const impact = await countEnginesAffectedByCriterion(db, parts);
  return { ok: true, enabled, partId, name: parts[0]?.name ?? '', ...impact };
}

/** Стоит ли метка на детали (значение атрибута — три представления «нет» учтены). */
async function readCriterionEnabled(db: BetterSQLite3Database, partId: string): Promise<boolean> {
  const partTypeId = await getPartTypeId(db);
  if (!partTypeId) return false;
  const defRows = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(
      and(
        eq(attributeDefs.entityTypeId, partTypeId),
        eq(attributeDefs.code, SCRAP_CRITERION_ATTR_CODE),
        isNull(attributeDefs.deletedAt),
      ),
    )
    .limit(1);
  const defId = defRows[0]?.id ? String(defRows[0].id) : null;
  if (!defId) return false;
  const valueRows = await db
    .select({ valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(
      and(
        eq(attributeValues.entityId, partId),
        eq(attributeValues.attributeDefId, defId),
        isNull(attributeValues.deletedAt),
      ),
    )
    .orderBy(desc(attributeValues.updatedAt))
    .limit(1);
  if (!valueRows[0]) return false;
  return isEavFlagSet(parseJson(valueRows[0].valueJson));
}

/**
 * Ставит/снимает метку на детали. Метка — атрибут EAV детали (`scrap_criterion`),
 * он же синхронизируется на сервер общим каналом атрибутов.
 */
export async function setScrapCriterionFlag(
  db: BetterSQLite3Database,
  partIdInput: string,
  enabled: boolean,
): Promise<{ ok: true; parts: Array<{ partId: string; name: string; nomenclatureIds: string[] }> } | { ok: false; error: string }> {
  const partId = await resolvePartEntityId(db, partIdInput);
  if (!partId) return { ok: false, error: 'Деталь не найдена' };
  const partTypeId = await getPartTypeId(db);
  if (!partTypeId) return { ok: false, error: 'Не найден тип справочника «детали»' };
  const defId = await ensureScrapCriterionDef(db, partTypeId);
  if (!defId) return { ok: false, error: 'Не удалось завести атрибут «уводит двигатель в утиль»' };
  const written = await setEntityAttribute(db, partId, SCRAP_CRITERION_ATTR_CODE, enabled, partTypeId);
  if (!written.ok) return { ok: false, error: written.error };
  invalidateScrapCriterionIndex();
  const parts = await resolveCriterionParts(db, [partId]);
  return { ok: true, parts };
}

/**
 * id детали справочника. Обычно он совпадает с id номенклатурной позиции
 * (часть → номенклатура, Variant A), но на всякий случай ищем по зеркалу.
 */
async function resolvePartEntityId(db: BetterSQLite3Database, id: string): Promise<string | null> {
  const trimmed = String(id ?? '').trim();
  if (!trimmed) return null;
  const partTypeId = await getPartTypeId(db);
  const entityRows = await db
    .select({ id: entities.id, typeId: entities.typeId })
    .from(entities)
    .where(eq(entities.id, trimmed))
    .limit(1);
  if (entityRows[0] && (!partTypeId || String(entityRows[0].typeId) === partTypeId)) return trimmed;
  const nomRows = await db
    .select({ refId: erpNomenclature.directoryRefId })
    .from(erpNomenclature)
    .where(and(eq(erpNomenclature.id, trimmed), isNull(erpNomenclature.deletedAt)))
    .limit(1);
  const refId = String(nomRows[0]?.refId ?? '').trim();
  return refId || trimmed;
}

/** Заводит атрибут «уводит двигатель в утиль» для типа «детали» (если ещё нет). */
async function ensureScrapCriterionDef(db: BetterSQLite3Database, partTypeId: string): Promise<string | null> {
  const found = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(
      and(
        eq(attributeDefs.entityTypeId, partTypeId),
        eq(attributeDefs.code, SCRAP_CRITERION_ATTR_CODE),
        isNull(attributeDefs.deletedAt),
      ),
    )
    .limit(1);
  if (found[0]?.id) return String(found[0].id);
  const ts = Date.now();
  const id = randomUUID();
  await db.insert(attributeDefs).values({
    id,
    entityTypeId: partTypeId,
    code: SCRAP_CRITERION_ATTR_CODE,
    name: SCRAP_CRITERION_ATTR_NAME,
    dataType: 'boolean',
    isRequired: false,
    sortOrder: 900,
    metaJson: null,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'pending',
  });
  return id;
}

/**
 * Сухой прогон: сколько двигателей получат признак утиля, если эти детали
 * войдут в набор. Считаем по реплике списка деталей — там лежат и id, и имена.
 *
 * Возвращает отдельно «двигателей» и «строк»: одно и то же дело может
 * встретиться в нескольких актах.
 */
export async function countEnginesAffectedByCriterion(
  db: BetterSQLite3Database,
  parts: ReadonlyArray<{ partId: string; name?: string | null; nomenclatureIds?: ReadonlyArray<string> }>,
): Promise<{ engines: number; lines: number }> {
  if (parts.length === 0) return { engines: 0, lines: 0 };
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const part of parts) {
    const partId = String(part.partId ?? '').trim();
    if (partId) ids.add(partId);
    for (const nomId of part.nomenclatureIds ?? []) {
      const id = String(nomId ?? '').trim();
      if (id) ids.add(id);
    }
    const name = normalizeScrapPartName(part.name);
    if (name) names.add(name);
  }
  const idList = [...ids];
  const nameList = [...names];

  const conditions = [];
  if (idList.length > 0) conditions.push(inArray(erpEngineInventoryLines.partId, idList));
  if (nameList.length > 0) {
    conditions.push(
      sql`lower(${erpEngineInventoryLines.partName}) in (${sql.join(nameList.map((n) => sql`${n}`))})`,
    );
  }
  if (conditions.length === 0) return { engines: 0, lines: 0 };

  const rows = await db
    .select({ engineId: erpEngineInventoryLines.engineEntityId })
    .from(erpEngineInventoryLines)
    .where(
      and(
        or(...conditions),
        sql`${erpEngineInventoryLines.scrapQty} > 0`,
        isNull(erpEngineInventoryLines.deletedAt),
      ),
    );
  const engines = new Set<string>();
  for (const row of rows) {
    const id = String(row.engineId ?? '').trim();
    if (id) engines.add(id);
  }
  return { engines: engines.size, lines: rows.length };
}
