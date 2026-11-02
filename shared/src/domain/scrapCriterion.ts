/**
 * Признак «эта деталь уводит двигатель в утиль» — глобальная метка детали
 * (решение владельца 02.11.2026).
 *
 * До этого признак был зашит на слово «картер»: любая деталь с «картер» в
 * имени, ушедшая в утиль по акту дефектовки, делала двигатель утильным
 * (D-#9). Теперь критерий задаётся меткой на карточке детали: владелец сам
 * помечает «Блок цилиндров» — и любой двигатель, у которого эта деталь ушла
 * в утиль, считается утильным везде (список, фильтр, отчёты, этапы на
 * заводе).
 *
 * Здесь только правило: где живёт метка, как выглядит набор критериев и как
 * строка акта сопоставляется с набором. Чтение набора и применение — в
 * `electron-app/src/main/services/scrapCriterionService.ts`.
 */

import { isScrapResolvedFor } from './engineRepairHistory.js';

/**
 * Признак «утильный двигатель» — приоритет источников:
 * 1. карточка детали помечена «уводит двигатель в утиль» (глобальная метка);
 * 2. картер в утиле — историческое правило D-#9, живёт до переноса картера в галку.
 */
export const SCRAP_CRITERION_ATTR_CODE = 'scrap_criterion';

/** Название атрибута в карточке детали. */
export const SCRAP_CRITERION_ATTR_NAME = 'Уводит двигатель в утиль';

/** Ссылка на деталь из строки списка деталей двигателя. */
export type ScrapCriterionPartRef = {
  /** id детали (номенклатурной позиции или детали справочника — как пришло из строки акта). */
  partId?: string | null;
  /** Имя детали из строки акта (снимок на момент заполнения). */
  partName?: string | null;
};

/** Помеченная деталь — для списка и сухого прогона. */
export type ScrapCriterionPartInfo = {
  /** id детали справочника (карточка детали). */
  partId: string;
  /** Имя детали. */
  name: string;
  /** Номенклатурные позиции этой детали — на них ссылаются строки актов. */
  nomenclatureIds: string[];
};

/**
 * Набор деталей-критериев. Держим оба пространства id (деталь справочника и
 * номенклатурная позиция): строки актов ссылаются на номенклатуру, а метка
 * живёт на карточке детали. Совпадение по имени — запасной путь для старых
 * строк, где id не записан.
 */
export type ScrapCriterionSet = {
  /** id деталей-критериев (оба пространства). */
  partIds: ReadonlySet<string>;
  /** Нормализованные имена деталей-критериев. */
  names: ReadonlySet<string>;
};

/** Пустой набор: ни одна деталь не помечена. */
export const EMPTY_SCRAP_CRITERION_SET: ScrapCriterionSet = {
  partIds: new Set<string>(),
  names: new Set<string>(),
};

/**
 * Имя детали для сопоставления: без краёв, в нижнем регистре, пробелы
 * схлопнуты. «Картер  верхний » и «картер верхний» — одна деталь.
 */
export function normalizeScrapPartName(name: string | null | undefined): string {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Старое правило D-#9: картер в утиле уводил двигатель в утиль. Живёт, пока
 * картер не переведён в галку на карточке детали — иначе релиз тихо снял бы
 * прежнее поведение. Убирается одним флагом, когда владелец подтвердит
 * перенос.
 */
/**
 * Старое правило D-#9 как страховка: картер в утиле уводит двигатель в утиль
 * даже если деталь не заведена в наборе критериев (строка акта без id и с
 * названием, которого нет в справочнике).
 *
 * Картерные детали перенесены в набор (наполнение при первом запуске клиента),
 * поэтому правило срабатывает для них по общему механизму — по id детали.
 * Эта страховка включается одной константой, когда парк подтвердит, что
 * набор покрывает все картерные строки.
 */
export const LEGACY_CRANKCASE_FALLBACK = true;

/**
 * Имя детали-критерия по умолчанию: картер (перенесён в набор критериев).
 */
export function isLegacyCrankcaseName(name: string | null | undefined): boolean {
  return normalizeScrapPartName(name).includes('картер');
}

/** Собирает набор критериев из помеченных деталей. */
export function createScrapCriterionSet(partIds: Iterable<string>, names: Iterable<string>): ScrapCriterionSet {
  const ids = new Set<string>();
  for (const raw of partIds) {
    const id = String(raw ?? '').trim();
    if (id) ids.add(id);
  }
  const normNames = new Set<string>();
  for (const raw of names) {
    const name = normalizeScrapPartName(raw);
    if (name) normNames.add(name);
  }
  return { partIds: ids, names: normNames };
}

export type ScrapCriterionMatchOptions = {
  /**
   * Учитывать старое правило «картер» (D-#9). По умолчанию — да: релиз не
   * должен молча менять прежнее поведение. Выключается, когда картер
   * переведён в галку на карточке детали.
   */
  legacyCrankcase?: boolean;
};

/**
 * Является ли деталь признаком утиля двигателя.
 *
 * Порядок: сначала id (точный признак), потом имя (запасной путь для строк
 * актов без id), потом старое правило «картер».
 */
export function matchesScrapCriterion(
  ref: ScrapCriterionPartRef | null | undefined,
  set: ScrapCriterionSet,
  opts?: ScrapCriterionMatchOptions,
): boolean {
  if (!ref) return false;
  const id = String(ref.partId ?? '').trim();
  if (id && set.partIds.has(id)) return true;
  const name = normalizeScrapPartName(ref.partName);
  if (!name) return false;
  if (set.names.has(name)) return true;
  if (opts?.legacyCrankcase === false) return false;
  return LEGACY_CRANKCASE_FALLBACK ? isLegacyCrankcaseName(name) : false;
}

/**
 * Какая деталь из строк списка уводит двигатель в утиль. `null` — ни одна.
 * Возвращаем саму деталь, чтобы след («почему двигатель утильный») был виден.
 */
export function findScrapCriterionHit(
  refs: ReadonlyArray<ScrapCriterionPartRef> | null | undefined,
  set: ScrapCriterionSet,
  opts?: ScrapCriterionMatchOptions,
): ScrapCriterionPartRef | null {
  if (!Array.isArray(refs)) return null;
  for (const ref of refs) {
    if (matchesScrapCriterion(ref, set, opts)) return ref;
  }
  return null;
}

/**
 * Утилен ли двигатель ПО ДЕТАЛЯМ: в списке его деталей есть деталь-критерий,
 * ушедшая в утиль, и снятия утиля (ремонт/замена детали) не было.
 *
 * Единая формула для списка двигателей, гейта наряда и отчётов: расходиться
 * им нельзя — иначе один и тот же двигатель в списке утильный, а в наряде
 * доступный.
 *
 * `sourceAt` — момент источника утиля (дата дефектовки). Снятие гасит утиль,
 * только если оно не старше источника; при неизвестном моменте снятие побеждает
 * (см. `isScrapResolvedFor`).
 */
export function isScrapCriterionEngineUtil(
  parts: ReadonlyArray<ScrapCriterionPartRef> | null | undefined,
  set: ScrapCriterionSet,
  opts?: ScrapCriterionMatchOptions & { scrapResolvedAt?: number | null; sourceAt?: number | null },
): boolean {
  const hit = findScrapCriterionHit(parts, set, opts);
  if (!hit) return false;
  // Снятие утиля — ровно та же формула, что и у карточных меток
  // (`isScrapResolvedFor`): снятие гасит утиль того же или более раннего момента.
  return !isScrapResolvedFor(opts?.scrapResolvedAt ?? null, opts?.sourceAt ?? null);
}
