// Единый список этапов ремонта в карточке двигателя (план
// docs/plans/unified-repair-stages-2026-09.md, шаг 1: домен без UI).
//
// Состав утверждён владельцем 28.09.2026. Приоритет = порядок в линейке:
// дата этапа обязана быть не раньше дат всех нижележащих (субординация),
// возврат на нижележащий этап разрешён, но помечается (дальше — новый проход).

export const REPAIR_STAGE_CODES = [
  'arrival',
  'disassembly_defect',
  'kitting_done',
  'ukladka',
  'sborka',
  'obkatka',
  'otk',
  'shipped',
  'accepted',
  'scrap_branch',
] as const;

export type RepairStageCode = (typeof REPAIR_STAGE_CODES)[number];

export type RepairStageTemplate = {
  code: RepairStageCode;
  /** Подпись в списке. */
  name: string;
  /** Приоритет: чем больше, тем выше этап. Линейка идёт 10, 20, … */
  sortOrder: number;
  /** Этап-автомат: проставляется кнопкой (дефектовка), но и вручную. */
  autoFrom?: 'defectAct' | 'kittingAct' | 'obkatkaRow';
  /** Боковая ветка (утиль/брак): в порядок по датам не входит. */
  sideBranch?: boolean;
};

export const DEFAULT_REPAIR_STAGE_TEMPLATES: ReadonlyArray<RepairStageTemplate> = [
  { code: 'arrival', name: 'Принят на завод', sortOrder: 10 },
  { code: 'disassembly_defect', name: 'Разборка, дефектовка', sortOrder: 20, autoFrom: 'defectAct' },
  { code: 'kitting_done', name: 'Комплектовка сделана', sortOrder: 30, autoFrom: 'kittingAct' },
  { code: 'ukladka', name: 'Укладка', sortOrder: 40 },
  { code: 'sborka', name: 'Сборка', sortOrder: 50 },
  { code: 'obkatka', name: 'Обкатка', sortOrder: 60, autoFrom: 'obkatkaRow' },
  { code: 'otk', name: 'Выходной контроль ОТК', sortOrder: 70 },
  { code: 'shipped', name: 'Отправлен заказчику', sortOrder: 80 },
  { code: 'accepted', name: 'Принят заказчиком', sortOrder: 90 },
  { code: 'scrap_branch', name: 'Утиль и брак', sortOrder: 0, sideBranch: true },
];

const byCode = new Map<RepairStageCode, RepairStageTemplate>(
  DEFAULT_REPAIR_STAGE_TEMPLATES.map((t) => [t.code, t]),
);

export function repairStageTemplate(code: RepairStageCode): RepairStageTemplate {
  const t = byCode.get(code);
  if (!t) throw new Error(`неизвестный этап ремонта: ${code}`);
  return t;
}

export type DatedStage = {
  code: RepairStageCode;
  /** ms epoch; 0/null — дата не проставлена, в порядке не участвует. */
  at: number | null;
  /** id строки — чтобы правка даты не сравнивала строку саму с собой. */
  id?: string;
};

/**
 * Субординация дат: дата этапа — не раньше дат всех нижележащих этапов
 * (ОТК раньше сборки — отказ). Боковая ветка и этапы без даты не участвуют.
 * Возвращает код конфликтного нижележащего этапа или null.
 */
export function findStageDateConflict(stages: DatedStage[], code: RepairStageCode, at: number): RepairStageCode | null {
  const rank = repairStageTemplate(code).sortOrder;
  if (rank === 0 || !Number.isFinite(at) || at <= 0) return null;
  for (const s of stages) {
    const r = repairStageTemplate(s.code).sortOrder;
    if (r === 0 || r >= rank) continue;
    if (typeof s.at === 'number' && Number.isFinite(s.at) && s.at > 0 && at < s.at) return s.code;
  }
  return null;
}

/**
 * Возврат назад: ранг нового этапа ниже максимального ранга уже датированных
 * этапов (обкатка была — снова пишем сборку). История сохраняется, дальше идёт
 * новый проход (механизм `pass` строк этапов). Боковая ветка возвратом не считается.
 */
export function isStageBackwardMove(stages: DatedStage[], code: RepairStageCode): boolean {
  const rank = repairStageTemplate(code).sortOrder;
  if (rank === 0) return false;
  let max = 0;
  for (const s of stages) {
    if (typeof s.at !== 'number' || !Number.isFinite(s.at) || s.at <= 0) continue;
    const r = repairStageTemplate(s.code).sortOrder;
    if (r > max) max = r;
  }
  return rank < max;
}

/** Сортировка списка для показа: по дате, бездатые — в конец, затем по приоритету. */
export function sortStagesByDate<T extends DatedStage>(stages: T[]): T[] {
  return [...stages].sort((a, b) => {
    const atA = typeof a.at === 'number' && Number.isFinite(a.at) && a.at > 0 ? a.at : null;
    const atB = typeof b.at === 'number' && Number.isFinite(b.at) && b.at > 0 ? b.at : null;
    if (atA !== null && atB !== null && atA !== atB) return atA - atB;
    if (atA !== null && atB === null) return -1;
    if (atA === null && atB !== null) return 1;
    return repairStageTemplate(a.code).sortOrder - repairStageTemplate(b.code).sortOrder;
  });
}
