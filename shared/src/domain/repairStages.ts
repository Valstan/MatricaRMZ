// Единый список этапов ремонта в карточке двигателя (план
// docs/plans/_archive/unified-repair-stages-2026-09.md, шаг 1: домен без UI).
//
// Состав утверждён владельцем 05.10.2026 (таблица 9 этапов): `kitting_done`
// снесён слиянием в `arrival` («Приемка»), №1 — `card_created` (авто-строка
// датой создания карточки), имена линейки — по таблице. Приоритет = порядок
// в линейке: дата этапа обязана быть не раньше дат всех нижележащих
// (субординация), возврат на нижележащий этап разрешён, но помечается
// (дальше — новый проход). Текущее место двигателя — этап с максимальной
// датой (tie — больший ранг): повторный заход обнуляет прошлые этапы.

import type { WorkSheetDuplicateRef } from './workSheetDuplicates.js';
import { moscowDayKey } from './workSheetDuplicates.js';

export const REPAIR_STAGE_CODES = [
  'card_created',
  'arrival',
  'disassembly_defect',
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
  /** Этап-автомат: проставляется кнопкой (дефектовка, комплектность), но и вручную. */
  autoFrom?: 'defectAct' | 'kittingAct';
  /** Боковая ветка (утиль/брак): в порядок по датам не входит. */
  sideBranch?: boolean;
  /** Серверный id и версия (есть у строк справочника, нет у статики шага 1). */
  id?: string;
  updatedAt?: number;
  archivedAt?: number | null;
};

export const DEFAULT_REPAIR_STAGE_TEMPLATES: ReadonlyArray<RepairStageTemplate> = [
  { code: 'card_created', name: 'Создание карточки двигателя', sortOrder: 5 },
  { code: 'arrival', name: 'Приемка двигателя на завод', sortOrder: 10, autoFrom: 'kittingAct' },
  { code: 'disassembly_defect', name: 'Разборка/Дефектовка', sortOrder: 20, autoFrom: 'defectAct' },
  { code: 'ukladka', name: 'Укладка вала', sortOrder: 40 },
  { code: 'sborka', name: 'Сборка двигателя', sortOrder: 50 },
  { code: 'obkatka', name: 'Обкатка двигателя', sortOrder: 60 },
  { code: 'otk', name: 'Выходной контроль ОТК', sortOrder: 70 },
  { code: 'shipped', name: 'Отгрузка двигателя заказчику', sortOrder: 80 },
  { code: 'accepted', name: 'Приемка двигателя заказчиком', sortOrder: 90 },
  { code: 'scrap_branch', name: 'Утиль и брак', sortOrder: 0, sideBranch: true },
];

/**
 * Снесённые коды, читаемые как их преемники до миграции строк (PR3 данных):
 * старые строки в БД несут `kitting_done`, новые пишутся только кодами реестра.
 * Создание новых строк идёт кодами из реестра — алиас только для чтения.
 */
export const LEGACY_STAGE_CODE_ALIASES: Record<string, RepairStageCode> = {
  kitting_done: 'arrival',
};

/** Код как его несут строки (включая снесённые) → код реестра. */
export function resolveStageCode(code: string): string {
  const c = String(code ?? '').trim().toLowerCase();
  return LEGACY_STAGE_CODE_ALIASES[c] ?? c;
}

/**
 * Срез переноса при перебивке номера (программа владельца, п.4, 10.10.2026):
 * этапы «от укладки вала и выше». Боковая ветка и неизвестные коды не переносятся.
 */
export function isTransferableStageCode(code: string): boolean {
  const c = resolveStageCode(code);
  if (c === 'scrap_branch') return false;
  const rank = repairStageRank(c);
  return rank > 0 && rank >= repairStageRank('ukladka');
}

const byCode = new Map<RepairStageCode, RepairStageTemplate>(
  DEFAULT_REPAIR_STAGE_TEMPLATES.map((t) => [t.code, t]),
);

export function repairStageTemplate(code: RepairStageCode): RepairStageTemplate {
  const t = byCode.get(resolveStageCode(code) as RepairStageCode);
  if (!t) throw new Error(`неизвестный этап ремонта: ${code}`);
  return t;
}

/**
 * Ранг произвольного кода (не бросает): известный — его приоритет, снесённый —
 * ранг преемника, чужой — 0, то есть боковая ветка вне порядка. Нужно чтению
 * старых и runtime-строк, чьи коды могут не совпасть с реестром.
 */
export function repairStageRank(code: string): number {
  const t = byCode.get(resolveStageCode(code) as RepairStageCode);
  return t ? t.sortOrder : 0;
}

/** Приоритет для внутренних обходов (субординация, возврат): алиасы и чужие коды — без броска. */
function sortOrderOf(code: string): number {
  const t = byCode.get(resolveStageCode(code) as RepairStageCode);
  return t ? t.sortOrder : 0;
}

/**
 * Календарный день (Москва) в сортируемом виде `ГГГГ-ММ-ДД`. Даты этапов —
 * дневной гранулярности (ввод датой без времени; полночь — артефакт ввода,
 * `Date.now()` — артефакт кнопки), поэтому порядок и субординация считаются
 * ПО ДНЯМ: внутри одного дня время не различаем, побеждает приоритет.
 */
export function moscowDaySortKey(ts: number): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '';
  const dmy = moscowDayKey(ts);
  if (!dmy) return '';
  const parts = dmy.split('.');
  if (parts.length !== 3) return '';
  const [d, m, y] = parts as [string, string, string];
  return `${y}-${m}-${d}`;
}

/**
 * Давность этапа для правила «текущий = последний по времени»: сначала день,
 * затем приоритет. Возвращает 0 при равенстве, >0 когда a позже b.
 * Этапы без даты и вне линейки (ранг 0) в сравнении проигрывают датированным.
 */
export function compareStageRecency(
  a: { code: string; at: number | null },
  b: { code: string; at: number | null },
): number {
  const dayA = typeof a.at === 'number' ? moscowDaySortKey(a.at) : '';
  const dayB = typeof b.at === 'number' ? moscowDaySortKey(b.at) : '';
  if (!dayA && !dayB) return 0;
  if (!dayA) return -1;
  if (!dayB) return 1;
  if (dayA !== dayB) return dayA < dayB ? -1 : 1;
  return sortOrderOf(a.code) - sortOrderOf(b.code);
}

/**
 * Кандидат массового добавления этапа (владелец 01.10.2026): показывают только
 * двигатели, которые стоят на заводе СЕЙЧАС на предыдущем этапе. Уехавшие
 * (нет прихода / есть отгрузка), стоящие на этом или более высоком этапе и
 * ушедшие в боковую ветку утиля скрываются совсем, а не группой «остальные»:
 * иначе за обкатку список из 991 штуки, где живых — горсть.
 *
 * `lastRank`: ранг последнего этапа двигателя (null — этапов ещё не было);
 * ранг 0 (боковой/неизвестный код) — не «ниже», а «вне линейки», не кандидат.
 */
export function isBulkStageCandidate(args: {
  atPlant: boolean;
  hasScrapBranch: boolean;
  lastRank: number | null;
  selectedRank: number;
}): boolean {
  if (!args.atPlant || args.hasScrapBranch) return false;
  if (args.selectedRank <= 0) return false;
  if (args.lastRank === null) return true;
  return args.lastRank > 0 && args.lastRank < args.selectedRank;
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
 * (ОТК раньше сборки — отказ). Сравнение ПО ДНЯМ (Москва): время внутри дня —
 * артефакты ввода (полночь у ручной даты, момент нажатия у кнопки), нарушением
 * считается только более ранний календарный день. Боковая ветка и этапы без
 * даты не участвуют. Возвращает код конфликтного нижележащего этапа или null.
 */
export function findStageDateConflict(stages: DatedStage[], code: RepairStageCode, at: number): RepairStageCode | null {
  const rank = sortOrderOf(code);
  const day = moscowDaySortKey(at);
  if (rank === 0 || !day) return null;
  for (const s of stages) {
    const r = sortOrderOf(s.code);
    if (r === 0 || r >= rank) continue;
    const sDay = typeof s.at === 'number' ? moscowDaySortKey(s.at) : '';
    if (sDay && sDay > day) return s.code;
  }
  return null;
}

/**
 * Возврат назад: ранг нового этапа ниже максимального ранга уже датированных
 * этапов (обкатка была — снова пишем сборку). История сохраняется, дальше идёт
 * новый проход (механизм `pass` строк этапов). Боковая ветка возвратом не считается.
 */
export function isStageBackwardMove(stages: DatedStage[], code: RepairStageCode, newAtMs?: number): boolean {
  const rank = sortOrderOf(code);
  if (rank === 0) return false;
  // Дата новой строки: этапы, датированные ПОЗЖЕ неё, её не «обгоняют» — это довнесение
  // пропущенного, а не возврат (баг 09.10.2026: поздно внесённая сборка с ранней датой
  // при живом shipped помечалась pass≥2). Сравнение по дням (Москва), как в субординации:
  // внутри дня время — артефакты ввода. Без даты новой строки — старое поведение.
  const newDay =
    typeof newAtMs === 'number' && Number.isFinite(newAtMs) && newAtMs > 0 ? moscowDaySortKey(newAtMs) : '';
  let max = 0;
  for (const s of stages) {
    if (typeof s.at !== 'number' || !Number.isFinite(s.at) || s.at <= 0) continue;
    if (newDay) {
      const sDay = moscowDaySortKey(s.at);
      if (sDay && sDay > newDay) continue;
    }
    const r = sortOrderOf(s.code);
    if (r > max) max = r;
  }
  return rank < max;
}

/** Строка единого списка для экранов и IPC-контракта. */
export type RepairStageRow = {
  id: string;
  code: string;
  name: string;
  /** ms epoch; null — дата не проставлена. */
  at: number | null;
  /** Номер прохода (1 — первый, без пометки). */
  pass: number;
  note: string;
  /** Автор внесения (логин); null — неизвестен/служебная запись. H1: автор навсегда. */
  by: string | null;
};

export type SaveRepairStageInput = {
  id: string;
  engineId: string;
  code: string;
  atMs: number;
  note?: string;
  /** Цех отметки (необязательно); имя — снимком, как у ручных записей. */
  workshopId?: string;
  workshopName?: string;
  /** Осознанный повторный проход (ответ на гейт дублей), начиная с 2. */
  repeatPass?: number;
  repeatReason?: string;
  /**
   * Ответ на вопрос про смену даты дефектовки (dual-entry, PR4). Без него запись
   * с другой датой у уже существующей строки `disassembly_defect` не проходит —
   * возвращается `defectDateChange`, экран спрашивает и повторяет с этим флагом.
   * Автоматы флаг не передают (им mark-if-absent, гейт не касается).
   */
  confirmDefectDate?: boolean;
};

export type SaveRepairStageResult =
  | { ok: true; id: string; created: boolean; backward: boolean; pass: number }
  | {
      ok: false;
      error: string;
      duplicate?: { refs: WorkSheetDuplicateRef[]; nextPass: number; typeName: string; atMs: number };
      /** Смена даты дефектовки требует подтверждения: сейчас в базе `currentAtMs`. */
      defectDateChange?: { currentAtMs: number; nextAtMs: number; typeName: string };
    };

/**
 * Сортировка списка для показа: по дате, бездатые — в конец, затем по приоритету.
 * Коды строковые намеренно: читатели (экраны) несут строки, которых может не быть
 * в реестре, — неизвестный код сортируется как боковая ветка, а не бросает.
 */
export function sortStagesByDate<T extends { code: string; at: number | null }>(stages: T[]): T[] {
  return [...stages].sort((a, b) => {
    const atA = typeof a.at === 'number' && Number.isFinite(a.at) && a.at > 0 ? a.at : null;
    const atB = typeof b.at === 'number' && Number.isFinite(b.at) && b.at > 0 ? b.at : null;
    if (atA !== null && atB !== null && atA !== atB) return atA - atB;
    if (atA !== null && atB === null) return -1;
    if (atA === null && atB !== null) return 1;
    return repairStageRank(a.code) - repairStageRank(b.code);
  });
}

/**
 * Текущее место двигателя (решение владельца 05.10.2026): последний этап по
 * времени — сначала календарный день (Москва), внутри дня — приоритет.
 * Всё, что раньше по времени, на место не влияет: повторный заход обнуляет
 * приоритеты прошлых этапов, отсчёт идёт от последнего этапа по времени.
 * Этапы без даты место не определяют. Отчёты и фильтры кладут двигатель ровно
 * в одну группу — по этому этапу; возвраты (`pass ≥ 2`) считаются отдельной
 * строкой (проход читается из строки, здесь его нет — только день и ранг).
 */
export function currentDatedStage(
  rows: ReadonlyArray<{ code: string; at: number | null }>,
): { code: string; at: number } | null {
  let best: { code: string; at: number } | null = null;
  for (const r of rows) {
    const at = typeof r.at === 'number' && Number.isFinite(r.at) && r.at > 0 ? r.at : null;
    if (at === null) continue;
    const code = resolveStageCode(String(r.code ?? ''));
    if (best === null || compareStageRecency({ code, at }, { code: best.code, at: best.at }) > 0) {
      best = { code, at };
    }
  }
  return best;
}
