import { moscowDayKey } from './workSheetDuplicates.js';
import { repairStageTemplate, resolveStageCode } from './repairStages.js';

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
