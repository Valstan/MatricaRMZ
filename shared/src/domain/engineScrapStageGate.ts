/**
 * ГЕЙТ «УТИЛЬНЫЙ ДВИГАТЕЛЬ НЕ НАЧИНАЕТ РЕМОНТ» (промт КАРМАНА #170).
 *
 * Зачитка владельца 26.11.2026: «ремонт не начинаем, пока деталь не отремонтирована».
 * Утильный двигатель (красная строка в списке) не должен получать этап ремонта: сначала
 * оператор снимает утиль — «деталь отремонтирована» (след в истории, деталь в ремонтный
 * фонд) — и только потом этап заводится.
 *
 * Здесь живёт ПРАВИЛО, а не ввод: где гейт стоит (воронка записи этапа) и по каким
 * признакам движок утильный. Правило одно на все места — иначе список, гейт и отчёт
 * разойдутся (как уже разошлись с признаком утиля по детали, см. `scrapCriterion.ts`).
 *
 * ТРИ ПРАВИЛА, КОТОРЫЕ НЕЛЬЗЯ РАЗВОДИТЬ:
 *
 * 1. **Блокирует только утиль.** Неглавная утильная деталь (маслонасос) ремонту не
 *    мешает: оператору показывается подсказка «в дефектовке есть утильная деталь».
 * 2. **Конфликт считается по текущему заезду.** Утиль прошлого заезда (движок вернулся
 *    по рекламации или повторно) текущую работу не блокирует — иначе второй заезд
 *    отремонтированного движка был бы невозможен.
 * 3. **Решение — в истории.** Постановка, снятие и восстановление детали остаются следами
 *    в истории двигателя (см. `engineRepairHistory.ts`).
 *
 * Источники истины: глобальный утиль — статус карточки «Признан утильным» с датой;
 * утиль по детали — метка на карточке детали (`scrapCriterion.ts`); текущий заезд —
 * `engineCurrentPass.ts` (последняя приёмка на завод отделяет заезды).
 */

import { currentVisitStartAt } from './engineCurrentPass.js';
import type { EngineStageEntry } from '../ipc/types.js';

/**
 * Этапы, с которых начинается ремонт двигателя.
 *
 * Граница — не «любой этап после дефектовки», а именно ремонтный цикл: «Ремонт деталей»
 * → укладка вала → фаза → сборка → обкатка → выходной контроль. Приёмка, входной контроль
 * и разборка — до ремонта (движок ещё не ремонтируют), отгрузка и приёмка заказчиком —
 * после (движок уходит с завода, и утильный в том числе).
 *
 * Список явный, а не «по рангу»: линейку этапов владелец переставляет (drag&drop в «Карте
 * этапов»), и гейт не должен молча переехать вместе с ней.
 */
export const SCRAP_GATE_REPAIR_STAGE_CODES: readonly string[] = [
  'parts_repair',
  'ukladka',
  'faza',
  'sborka',
  'obkatka',
  'otk',
];

/** Этот этап — из ремонтного цикла (его блокирует утильный движок). */
export function isScrapGateRepairStage(code: string | null | undefined): boolean {
  return SCRAP_GATE_REPAIR_STAGE_CODES.includes(String(code ?? '').trim().toLowerCase());
}

/** Подсказка оператору: в дефектовке есть утильная деталь (сама по себе она ремонту не мешает). */
export const SCRAP_PART_HINT = 'В дефектовке есть утильная деталь';

/**
 * Причины снятия утиля (промт КАРМАНА #170, пункт 10): программа спрашивает, почему
 * сняли пометку, — и ответ попадает в историю двигателя вместе с решением.
 *
 * Список открытый: «Иное» — для случаев, которых в трёх строках нет; свой текст оператор
 * вводит в поле примечания.
 */
export const SCRAP_RESOLVE_REASONS: readonly string[] = ['Ремонт', 'Закупка', 'Иное'];

/**
 * Состояние двигателя, нужное гейту. Собирается в main (там, где база) и приходит в
 * домен уже разобранным: домен не ходит в базу.
 */
export type EngineScrapGateState = {
  /** Двигатель утильный СЕЙЧАС (тот самый красный статус, что виден везде). */
  isScrap: boolean;
  /** Момент источника утиля (дата статуса / дата акта дефектовки / дата боковой ветки). */
  scrapAt: number | null;
  /** Подпись утильной детали — её называет окно. */
  partLabel: string | null;
  /** id утильной детали (номенклатурная позиция) — по нему деталь возвращается в ремонтный фонд. */
  partId?: string | null;
  /** Все утильные детали дефектовки — из них берётся подсказка и имя детали для окна. */
  scrapPartLabels: readonly string[];
  /** Номер двигателя — окно называет и его. */
  engineNumber?: string | null;
};

/** Решение гейта: заводить этап или показать окно. */
export type EngineScrapGateDecision =
  | { blocked: false; hint: string | null }
  | {
      blocked: true;
      /** Человеческое объяснение — его показывает окно. */
      error: string;
      /** Подпись утильной детали (может быть пустой — деталь названа в акте). */
      partLabel: string | null;
      /** id утильной детали — по нему деталь возвращается в ремонтный фонд. */
      partId: string | null;
      /** Номер двигателя. */
      engineNumber: string | null;
      /** Подпись этапа, который не удалось завести. */
      stageName: string;
    };

/**
 * Утиль принадлежит текущему заезду?
 *
 * Текущий заезд начинается с последней приёмки на завод (`currentVisitFrom`). Утиль,
 * признанный раньше этой приёмки, — утиль ПРОШЛОГО заезда: движок вернулся (рекламация
 * или повторный заезд) и сейчас ремонтируется заново — мешать нечему.
 *
 * Если начало заезда неизвестно (движок ещё не приезжал) или неизвестен момент утиля —
 * считаем утиль текущим: лучше перестраховаться, чем пропустить начало ремонта утильного
 * движка.
 */
export function isScrapInCurrentTrip(scrapAt: number | null, currentVisitFrom: number | null): boolean {
  if (typeof scrapAt !== 'number' || !Number.isFinite(scrapAt) || scrapAt <= 0) return true;
  if (typeof currentVisitFrom !== 'number' || !Number.isFinite(currentVisitFrom) || currentVisitFrom <= 0) return true;
  return scrapAt >= currentVisitFrom;
}

/**
 * Решение гейта для одного этапа.
 *
 * @param args.state состояние двигателя (утиль, детали, номер).
 * @param args.stageCode код этапа, который хотят завести.
 * @param args.stageName подпись этапа (для окна).
 * @param args.currentVisitFrom начало текущего заезда (null — заезда не было).
 */
export function evaluateScrapStageGate(args: {
  state: EngineScrapGateState;
  stageCode: string;
  stageName: string;
  currentVisitFrom: number | null;
}): EngineScrapGateDecision {
  // Не ремонтный этап — гейт молчит: приёмку, разборку и отгрузку утиль не держит.
  if (!isScrapGateRepairStage(args.stageCode)) return { blocked: false, hint: null };

  const state = args.state;
  if (!state.isScrap) {
    // Двигатель не утильный. Но в дефектовке может быть утильная НЕГЛАВНАЯ деталь
    // (маслонасос): этап заводится, но оператору говорим, что деталь в утиле.
    return { blocked: false, hint: state.scrapPartLabels.length > 0 ? SCRAP_PART_HINT : null };
  }

  // Утиль прошлого заезда текущую работу не блокирует (движок вернулся и ремонтируется).
  if (!isScrapInCurrentTrip(state.scrapAt, args.currentVisitFrom)) {
    return { blocked: false, hint: null };
  }

  const part = state.partLabel ? `«${state.partLabel}»` : 'деталь';
  return {
    blocked: true,
    error: `Двигатель утильный (${part}) — ремонт не начинаем, пока деталь не отремонтирована`,
    partLabel: state.partLabel,
    partId: state.partId ?? null,
    engineNumber: state.engineNumber ?? null,
    stageName: args.stageName,
  };
}

/**
 * Состояние двигателя согласовано: в текущем заезде не может быть И этапа ремонта,
 * И статуса утиль.
 *
 * Проверка живых данных (промт КАРМАНА #170, пункт «держать состояние согласованным»):
 * расхождения бывают от прежних правок — их надо перебрать, а новых быть не должно.
 *
 * Этапы ПРОШЛЫХ заездов расхождением не считаются: движок мог пройти цикл, попасть в
 * утиль и вернуться — это законная история, а не противоречие.
 */
export function isScrapStageStateConsistent(args: {
  isScrap: boolean;
  scrapAt: number | null;
  currentVisitFrom: number | null;
  /** Даты этапов ремонта текущего заезда. */
  currentVisitRepairStageDates: readonly number[];
}): boolean {
  if (!args.isScrap) return true;
  if (!isScrapInCurrentTrip(args.scrapAt, args.currentVisitFrom)) return true;
  return args.currentVisitRepairStageDates.length === 0;
}

/** Расхождение: утильный двигатель с этапом ремонта в текущем заезде. */
export type ScrapStageInconsistency = {
  engineId: string;
  engineNumber: string | null;
  /** Момент источника утиля. */
  scrapAt: number | null;
  /** Код этапа ремонта текущего заезда. */
  stageCode: string;
  /** Дата этого этапа. */
  stageAt: number | null;
};

/** Минимальный срез строки списка, нужный проверке согласованности. */
export type ScrapStageInconsistencyRow = {
  id: string;
  engineNumber?: string | undefined;
  isScrap?: boolean | undefined;
  statusDates?: Record<string, number | undefined> | undefined;
  stageEntries?: Array<{ code: string; name?: string | undefined; at: number; pass?: number | undefined }> | undefined;
};

/**
 * Перебор расхождений по строкам списка двигателей.
 *
 * Считает по правилу «текущий заезд» (`currentVisitStartAt` — последняя приёмка на
 * завод): этапы прошлых заездов расхождением не считаются.
 */
export function findScrapStageInconsistencies(
  rows: readonly ScrapStageInconsistencyRow[],
  opts?: { scrapDateCodes?: readonly string[] },
): ScrapStageInconsistency[] {
  const codes = opts?.scrapDateCodes ?? ['status_scrap_confirmed', 'status_rework_sent', 'status_rejected'];
  const out: ScrapStageInconsistency[] = [];
  for (const row of rows ?? []) {
    if (row.isScrap !== true) continue;
    const entries = Array.isArray(row.stageEntries) ? row.stageEntries : [];
    const currentVisitFrom = currentVisitStartAt(entries as EngineStageEntry[]);
    const scrapAt = codes
      .map((code) => row.statusDates?.[code])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)
      .sort((a, b) => b - a)[0] ?? null;
    const repairStages = entries.filter(
      (entry) =>
        isScrapGateRepairStage(entry.code) &&
        typeof entry.at === 'number' &&
        entry.at > 0 &&
        (currentVisitFrom == null || entry.at >= currentVisitFrom),
    );
    const consistent = isScrapStageStateConsistent({
      isScrap: true,
      scrapAt,
      currentVisitFrom,
      currentVisitRepairStageDates: repairStages.map((entry) => entry.at),
    });
    if (consistent) continue;
    const first = repairStages[0];
    out.push({
      engineId: String(row.id ?? ''),
      engineNumber: String(row.engineNumber ?? '').trim() || null,
      scrapAt,
      stageCode: String(first?.code ?? ''),
      stageAt: typeof first?.at === 'number' ? first.at : null,
    });
  }
  return out;
}
