import type { EngineListItem } from '../ipc/types.js';
import type { StatusCode } from './contract.js';

/**
 * «Где двигатель на заводе» — этап ремонта по данным карточки и ведомостей (владелец
 * 15.09.2026, вечер): отчёт по двигателям, которые числятся пришедшими и ещё не
 * отправленными, разбитый по группам движения.
 *
 * Правило одно: **побеждает самый поздний признак**, а не дата. Дата этапа — из строки списка
 * (`statusDates` для стадий карточки, `defectDate`, дата ведомости, приход). Утиль — отдельная группа
 * выше всех; дальше от позднего к раннему: Отремонтирован → последняя ведомость по виду
 * работ (обкатка / сборка / вал / укладка — порядок из справочника видов) → Дефектовка
 * сделана → Комплектовка сделана → Ремонт начат → Пришёл, ремонт не начат.
 *
 * Виды работ — динамический справочник: их ранги строятся по `sortOrder` вида, новый вид
 * появится в отчёте сам. Ведомость неизвестного (архивного) вида получает базовый ранг
 * ведомостей и подпись из самой строки.
 */
export type EngineFactoryStage = {
  /** Ключ группы: `scrap` / `repaired` / `sheet:<code>` / `defect_act` / `completeness_act` / `repair_started` / `arrived`. */
  key: string;
  label: string;
  /** Чем больше — тем позже этап; по нему и сортируются группы. */
  rank: number;
  /** Дата этапа, когда она есть у строки списка (приход, дефектовка, ведомость). */
  at: number | null;
};

export type EngineFactoryStageTypeRef = { code: string; name: string; sortOrder?: number };

export const ENGINE_FACTORY_STAGE_RANK = {
  arrived: 0,
  repairStarted: 1,
  completenessAct: 2,
  defectAct: 3,
  /** База для ведомостей: `10 + индекс вида по sortOrder`. */
  sheetBase: 10,
  repaired: 100,
  scrap: 1000,
} as const;

export const ENGINE_FACTORY_STAGE_LABELS = {
  arrived: 'Пришёл, ремонт не начат',
  repairStarted: 'Ремонт начат',
  completenessAct: 'Комплектовка сделана',
  defectAct: 'Дефектовка сделана',
  repaired: 'Отремонтирован',
  scrap: 'Утиль',
} as const;

function dateMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function norm(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/** Пришёл и ещё не отгружен: дата прихода есть, даты отгрузки нет. */
export function isEngineAtPlant(e: Pick<EngineListItem, 'arrivalDate' | 'shippingDate'>): boolean {
  return dateMs(e.arrivalDate) != null && dateMs(e.shippingDate) == null;
}

/** Виды работ по порядку справочника — ранг ведомости растёт с индексом. */
function orderedTypes(types: readonly EngineFactoryStageTypeRef[] | undefined): EngineFactoryStageTypeRef[] {
  return [...(types ?? [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, 'ru'));
}

function sheetStage(
  e: Pick<EngineListItem, 'lastSheetNode' | 'lastSheetAt' | 'lastSheetTypeCode'>,
  types: readonly EngineFactoryStageTypeRef[] | undefined,
): EngineFactoryStage | null {
  const node = String(e.lastSheetNode ?? '').trim();
  const code = String(e.lastSheetTypeCode ?? '').trim();
  if (!node && !code) return null;
  const ordered = orderedTypes(types);
  // Сначала по коду (он заморожен), потом по имени без регистра — старые строки кода не несут.
  let idx = code ? ordered.findIndex((t) => t.code === code) : -1;
  if (idx < 0 && node) idx = ordered.findIndex((t) => norm(t.name) === norm(node));
  const type = idx >= 0 ? ordered[idx]! : null;
  return {
    key: `sheet:${type?.code || code || norm(node)}`,
    label: type?.name || node || code,
    rank: ENGINE_FACTORY_STAGE_RANK.sheetBase + Math.max(0, idx),
    at: dateMs(e.lastSheetAt),
  };
}

/** Дата стадии карточки из строки списка (`status_<code>_date`); нет — `null`. */
export function engineStatusDate(e: Pick<EngineListItem, 'statusDates'>, code: StatusCode): number | null {
  return dateMs(e.statusDates?.[code]);
}

/** Дата утиля — по той же паре меток, что и `isScrapEngine`; забракованный без них — дата брака. */
export function engineScrapDate(e: Pick<EngineListItem, 'statusDates'>): number | null {
  return engineStatusDate(e, 'status_scrap_confirmed') ?? engineStatusDate(e, 'status_rework_sent') ?? engineStatusDate(e, 'status_rejected');
}

export function engineFactoryStage(e: EngineListItem, types?: readonly EngineFactoryStageTypeRef[]): EngineFactoryStage {
  const flags = e.statusFlags ?? {};
  if (e.isScrap === true) {
    return { key: 'scrap', label: ENGINE_FACTORY_STAGE_LABELS.scrap, rank: ENGINE_FACTORY_STAGE_RANK.scrap, at: engineScrapDate(e) };
  }
  if (flags.status_repaired === true) {
    return { key: 'repaired', label: ENGINE_FACTORY_STAGE_LABELS.repaired, rank: ENGINE_FACTORY_STAGE_RANK.repaired, at: engineStatusDate(e, 'status_repaired') };
  }
  const sheet = sheetStage(e, types);
  if (sheet) return sheet;
  if (e.hasDefectAct === true) {
    return { key: 'defect_act', label: ENGINE_FACTORY_STAGE_LABELS.defectAct, rank: ENGINE_FACTORY_STAGE_RANK.defectAct, at: dateMs(e.defectDate) };
  }
  if (e.hasCompletenessAct === true) {
    return { key: 'completeness_act', label: ENGINE_FACTORY_STAGE_LABELS.completenessAct, rank: ENGINE_FACTORY_STAGE_RANK.completenessAct, at: null };
  }
  if (flags.status_repair_started === true) {
    return { key: 'repair_started', label: ENGINE_FACTORY_STAGE_LABELS.repairStarted, rank: ENGINE_FACTORY_STAGE_RANK.repairStarted, at: engineStatusDate(e, 'status_repair_started') };
  }
  return { key: 'arrived', label: ENGINE_FACTORY_STAGE_LABELS.arrived, rank: ENGINE_FACTORY_STAGE_RANK.arrived, at: dateMs(e.arrivalDate) };
}

/**
 * Полный ряд групп отчёта от позднего к раннему (для порядка групп и пустых групп в шапке):
 * утиль, отремонтирован, ведомости по видам (поздние выше), дефектовка, комплектовка,
 * ремонт начат, пришёл.
 */
export function engineFactoryStageOrder(types?: readonly EngineFactoryStageTypeRef[]): Array<Pick<EngineFactoryStage, 'key' | 'label' | 'rank'>> {
  const sheets = orderedTypes(types).map((t, idx) => ({ key: `sheet:${t.code}`, label: t.name, rank: ENGINE_FACTORY_STAGE_RANK.sheetBase + idx }));
  return [
    { key: 'scrap', label: ENGINE_FACTORY_STAGE_LABELS.scrap, rank: ENGINE_FACTORY_STAGE_RANK.scrap },
    { key: 'repaired', label: ENGINE_FACTORY_STAGE_LABELS.repaired, rank: ENGINE_FACTORY_STAGE_RANK.repaired },
    ...sheets.reverse(),
    { key: 'defect_act', label: ENGINE_FACTORY_STAGE_LABELS.defectAct, rank: ENGINE_FACTORY_STAGE_RANK.defectAct },
    { key: 'completeness_act', label: ENGINE_FACTORY_STAGE_LABELS.completenessAct, rank: ENGINE_FACTORY_STAGE_RANK.completenessAct },
    { key: 'repair_started', label: ENGINE_FACTORY_STAGE_LABELS.repairStarted, rank: ENGINE_FACTORY_STAGE_RANK.repairStarted },
    { key: 'arrived', label: ENGINE_FACTORY_STAGE_LABELS.arrived, rank: ENGINE_FACTORY_STAGE_RANK.arrived },
  ];
}
