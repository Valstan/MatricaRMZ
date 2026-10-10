import { moscowDayKey } from './workSheetDuplicates.js';
import { compareStageRecency, repairStageTemplate, resolveStageCode } from './repairStages.js';

/**
 * Этапы, выведенные из акта (программа владельца, п.3: унификация актов, 10.10.2026).
 *
 * Проведение акта — единственная запись факта; этапы `arrival` и `disassembly_defect`
 * в едином списке выводятся из дат акта, а не хранятся вторыми строками. Дубль по
 * построению невозможен: один код + один московский день = одна запись.
 */

export const ACT_STAGE_CODES = ['arrival', 'disassembly_defect'] as const;
export type ActStageCode = (typeof ACT_STAGE_CODES)[number];

/** Даты акта из ответов листа `engine_inventory` (мс; остальное игнорируется). */
export type ActDates = {
  arrivalDate?: number | null;
  completenessInspectionDate?: number | null;
  defectStartDate?: number | null;
};

export type ActStageEntry = {
  code: ActStageCode;
  name: string;
  atMs: number;
  origin: 'act';
};

function asEventMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Даты акта из ответов листа `engine_inventory`: поля вида `{kind:'date', value}`.
 * Всё остальное (тексты, пусто, чужие kind) — не даты и игнорируются.
 * Форма uniform: все три ключа всегда на месте, отсутствующее — `null`.
 */
export function actDatesFromAnswers(answers: unknown): ActDates {
  const none: ActDates = { arrivalDate: null, completenessInspectionDate: null, defectStartDate: null };
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return none;
  const a = answers as Record<string, unknown>;
  const dateAnswer = (key: string): number | null => {
    const field = a[key];
    if (!field || typeof field !== 'object') return null;
    const o = field as Record<string, unknown>;
    if (o.kind !== 'date') return null;
    return asEventMs(o.value);
  };
  return {
    arrivalDate: dateAnswer('arrival_date'),
    completenessInspectionDate: dateAnswer('completeness_inspection_date'),
    defectStartDate: dateAnswer('defect_start_date'),
  };
}

/**
 * Этапы из дат акта: приёмка — по дате осмотра (запасной путь — дата прихода),
 * разборка/дефектовка — по дате начала. Без даты записи нет: этап-план не выводим.
 */
export function actStageEntries(dates: ActDates | null | undefined): ActStageEntry[] {
  if (!dates) return [];
  const out: ActStageEntry[] = [];
  const arrivalAt = asEventMs(dates.completenessInspectionDate) ?? asEventMs(dates.arrivalDate);
  if (arrivalAt != null) {
    out.push({ code: 'arrival', name: repairStageTemplate('arrival').name, atMs: arrivalAt, origin: 'act' });
  }
  const defectAt = asEventMs(dates.defectStartDate);
  if (defectAt != null) {
    out.push({
      code: 'disassembly_defect',
      name: repairStageTemplate('disassembly_defect').name,
      atMs: defectAt,
      origin: 'act',
    });
  }
  return out;
}

export type MergedActStage<T> = { origin: 'stored'; row: T } | { origin: 'act'; entry: ActStageEntry };

/**
 * Слияние хранимых строк с выведенными: stored-строка того же кода в тот же московский
 * день скрывается (акт — источник правды; снесённые коды сравниваются преемниками),
 * остальное проходит как было. Порядок: сначала хранимые, потом выведенные.
 */
export function mergeActStages<T extends { code: string; atMs: number | null }>(
  stored: readonly T[],
  derived: readonly ActStageEntry[],
): MergedActStage<T>[] {
  const derivedKeys = new Set(derived.map((d) => `${d.code}|${moscowDayKey(d.atMs)}`));
  const out: MergedActStage<T>[] = [];
  for (const row of stored) {
    const day = row.atMs == null ? '' : moscowDayKey(row.atMs);
    if (day !== '' && derivedKeys.has(`${resolveStageCode(row.code)}|${day}`)) continue;
    out.push({ origin: 'stored', row });
  }
  for (const entry of derived) out.push({ origin: 'act', entry });
  return out;
}

/** Лучший (текущий) этап в форме, достаточной для сравнения давности. */
export type ActStageBest = {
  code: string;
  name: string;
  at: number;
  pass: number;
};

/**
 * Коды для ступени «Есть этап»: объединение хранимых и выведенных (снесённые коды
 * считаются преемниками — `kitting_done` в базе и выведенная `arrival` не дублируются).
 */
export function actStageCodes(codes: readonly string[], derived: readonly ActStageEntry[]): string[] {
  const resolved = new Set(codes.map((c) => resolveStageCode(c)));
  const out = [...codes];
  for (const d of derived) {
    if (!resolved.has(d.code)) {
      resolved.add(d.code);
      out.push(d.code);
    }
  }
  return out;
}

/**
 * Лучший этап с учётом выведенных: более поздний днём (внутри дня — старшим приоритетом)
 * побеждает; при равенстве остаётся хранимый (у него бывают примечание и проход).
 */
export function actStageBest(best: ActStageBest | null, derived: readonly ActStageEntry[]): ActStageBest | null {
  let cur = best;
  for (const d of derived) {
    if (!cur) {
      cur = { code: d.code, name: d.name, at: d.atMs, pass: 1 };
      continue;
    }
    if (compareStageRecency({ code: d.code, at: d.atMs }, { code: cur.code, at: cur.at }) > 0) {
      cur = { code: d.code, name: d.name, at: d.atMs, pass: 1 };
    }
  }
  return cur;
}
