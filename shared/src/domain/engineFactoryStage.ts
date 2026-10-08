import type { EngineListItem } from '../ipc/types.js';
import type { StatusCode } from './contract.js';
import { DEFAULT_REPAIR_STAGE_TEMPLATES, repairStageRank, type RepairStageTemplate } from './repairStages.js';

/**
 * «Где двигатель на заводе» — этап ремонта по данным карточки и строк этапов работ (владелец
 * 15.09.2026, вечер): отчёт по двигателям, которые числятся пришедшими и ещё не
 * отправленными, разбитый по группам движения.
 *
 * Правило одно: **побеждает самый поздний признак**, а не дата. Дата этапа — из строки списка
 * (`statusDates` для стадий карточки, `defectDate`, дата этапа работ, приход). Утиль — отдельная группа
 * выше всех; дальше от позднего к раннему: Отремонтирован → последний этап по виду
 * работ (обкатка / сборка / вал / укладка — порядок из справочника видов) → Дефектовка
 * сделана → Комплектовка сделана → Ремонт начат → Пришёл, ремонт не начат.
 *
 * Виды работ — динамический справочник: их ранги строятся по `sortOrder` вида, новый вид
 * появится в отчёте сам. Этап работ неизвестного (архивного) вида получает базовый ранг
 * этапов работ и подпись из самой строки.
 */
export type EngineFactoryStage = {
  /** Ключ группы: `scrap` / `repaired` / `sheet:<code>` / `defect_act` / `completeness_act` / `repair_started` / `arrived`. */
  key: string;
  label: string;
  /** Чем больше — тем позже этап; по нему и сортируются группы. */
  rank: number;
  /** Дата этапа, когда она есть у строки списка (приход, дефектовка, этап работ). */
  at: number | null;
  /**
   * Настоящий этап строки, когда `label` занят группой. У строки «Возвраты» `label` —
   * это про повторный проход, а колонке «Этап на заводе» нужно, на каком этапе движок
   * стоит («Сборка»). Есть только у возвратов; для остальных `label` уже называет этап.
   */
  stageLabel?: string;
};

export type EngineFactoryStageTypeRef = { code: string; name: string; sortOrder?: number };

export const ENGINE_FACTORY_STAGE_RANK = {
  arrived: 0,
  repairStarted: 1,
  completenessAct: 2,
  defectAct: 3,
  /** База для этапов работ: `10 + индекс вида по sortOrder`. */
  sheetBase: 10,
  /** База для строк единого списка: `50 + индекс этапа по шаблону`. Выше узлов — строка ведётся оператором сейчас. */
  stageBase: 50,
  repaired: 100,
  /** Возвраты — выше готового и ниже утиля: повторный заход виден сразу, но это не отказ. */
  returns: 900,
  scrap: 1000,
} as const;

export const ENGINE_FACTORY_STAGE_LABELS = {
  arrived: 'Пришёл, ремонт не начат',
  repairStarted: 'Ремонт начат',
  completenessAct: 'Комплектовка сделана',
  defectAct: 'Дефектовка сделана',
  repaired: 'Отремонтирован',
  returns: 'Возвраты (повторный проход)',
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

/** Виды работ по порядку справочника — ранг этапа работ растёт с индексом. */
function orderedTypes(types: readonly EngineFactoryStageTypeRef[] | undefined): EngineFactoryStageTypeRef[] {
  return [...(types ?? [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, 'ru'));
}

/** Шаблон этапов по порядку: линейка по приоритету, боковая ветка — в конец. */
function orderedStageTemplates(
  templates: readonly RepairStageTemplate[] | undefined,
): RepairStageTemplate[] {
  const list = [...(templates ?? DEFAULT_REPAIR_STAGE_TEMPLATES)];
  const line = list.filter((t) => t.sideBranch !== true).sort((a, b) => a.sortOrder - b.sortOrder);
  const side = list.filter((t) => t.sideBranch === true);
  return [...line, ...side];
}

/**
 * Последний датированный этап единого списка из строки списка. Этапы без даты
 * место не определяют — по ним нельзя сказать, где двигатель.
 */
function stageRow(
  e: Pick<EngineListItem, 'lastStageCode' | 'lastStageName' | 'lastStageAt'>,
  templates: readonly RepairStageTemplate[] | undefined,
): EngineFactoryStage | null {
  const code = String(e.lastStageCode ?? '').trim().toLowerCase();
  const at = dateMs(e.lastStageAt);
  if (!code || at == null) return null;
  const ordered = orderedStageTemplates(templates);
  const idx = ordered.findIndex((t) => t.code === code);
  const template = idx >= 0 ? ordered[idx]! : null;
  if (template?.sideBranch === true) {
    return { key: `stage:${code}`, label: String(e.lastStageName ?? '').trim() || template.name, rank: ENGINE_FACTORY_STAGE_RANK.repairStarted, at };
  }
  return {
    key: `stage:${code}`,
    label: String(e.lastStageName ?? '').trim() || template?.name || code,
    rank: ENGINE_FACTORY_STAGE_RANK.stageBase + Math.max(0, idx),
    at,
  };
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

/**
 * Проход последнего этапа из строки списка: 1 — первый, ≥2 — возврат назад.
 * Поле необязательное (старые реплики его не знают), поэтому отсутствие = первый проход.
 */
export function returnsPass(e: Pick<EngineListItem, 'lastStagePass'>): number {
  const n = Number(e.lastStagePass);
  return Number.isFinite(n) && n > 1 ? Math.floor(n) : 1;
}

/** Дата стадии карточки из строки списка (`status_<code>_date`); нет — `null`. */
export function engineStatusDate(e: Pick<EngineListItem, 'statusDates'>, code: StatusCode): number | null {
  return dateMs(e.statusDates?.[code]);
}

/** Дата утиля — по той же паре меток, что и `isScrapEngine`; забракованный без них — дата брака. */
export function engineScrapDate(e: Pick<EngineListItem, 'statusDates'>): number | null {
  return engineStatusDate(e, 'status_scrap_confirmed') ?? engineStatusDate(e, 'status_rework_sent') ?? engineStatusDate(e, 'status_rejected');
}

/**
 * Состояние двигателя одной подписью для отчёта «Двигатели» (все двигатели, не только на
 * заводе): побеждает поздний признак — утиль, отгружен, готов и не отгружен, в ремонте,
 * принят, на заводе; без даты прихода — «Заведён». Подписи те же, что были у пресетного
 * отчёта до B3 программы осень-2026, чтобы оператор не переучивался.
 *
 * Шаг 8 плана: последнее датированное место в едином списке бьёт замороженные флаги
 * (их с 8/1 никто не пишет). Пороги те же, что у countdown: готов — «Обкатка» и дальше,
 * в ремонте — любой датированный этап ниже; «Принят» — этап прибытия (наследник
 * «Принят на хранение» для новых двигателей).
 */
export function engineStateLabel(
  e: Pick<EngineListItem, 'isScrap' | 'arrivalDate' | 'shippingDate' | 'statusFlags' | 'lastStageCode' | 'lastStageAt'>,
): string {
  const flags = e.statusFlags ?? {};
  if (e.isScrap) return 'Утиль';
  const stageCode = String(e.lastStageCode ?? '').trim().toLowerCase();
  const stageAt =
    typeof e.lastStageAt === 'number' && Number.isFinite(e.lastStageAt) && e.lastStageAt > 0 ? e.lastStageAt : null;
  const stageRank = stageAt !== null ? repairStageRank(stageCode) : 0;
  if (
    dateMs(e.shippingDate) != null ||
    flags.status_customer_sent ||
    flags.status_customer_accepted ||
    (stageAt !== null && (stageCode === 'shipped' || stageCode === 'accepted'))
  ) {
    return 'Отгружен';
  }
  if (flags.status_repaired || (stageAt !== null && stageRank >= repairStageRank('obkatka'))) return 'Готов, не отгружен';
  if (flags.status_repair_started || (stageAt !== null && stageRank > repairStageRank('arrival'))) return 'В ремонте';
  if (flags.status_storage_received || (stageAt !== null && stageCode === 'arrival')) return 'Принят';
  return dateMs(e.arrivalDate) != null ? 'На заводе' : 'Заведён';
}

/** Дней на заводе: до отгрузки — по дате отгрузки, иначе по сегодняшнему дню; без даты прихода — `null`. */
export function engineDaysOnSite(e: Pick<EngineListItem, 'arrivalDate' | 'shippingDate'>, now = Date.now()): number | null {
  const arrival = dateMs(e.arrivalDate);
  if (arrival == null) return null;
  const end = dateMs(e.shippingDate) ?? now;
  return Math.max(0, Math.round((end - arrival) / 86_400_000));
}

export function engineFactoryStage(
  e: EngineListItem,
  types?: readonly EngineFactoryStageTypeRef[],
  stageTemplates?: readonly RepairStageTemplate[],
): EngineFactoryStage {
  const flags = e.statusFlags ?? {};
  if (e.isScrap === true) {
    return { key: 'scrap', label: ENGINE_FACTORY_STAGE_LABELS.scrap, rank: ENGINE_FACTORY_STAGE_RANK.scrap, at: engineScrapDate(e) };
  }
  // Датированная строка единого списка — текущее место: бьёт и готовый флаг, и узлы,
  // и акты. Возврат (сборка после обкатки при взведённом «Отремонтирован») — это она:
  // место — сборка, а не готовый. Утиль выше — его решает флаг, а не строка.
  const stage = stageRow(e, stageTemplates);
  if (stage) {
    // Возврат назад по линейке (проход ≥ 2) — ОТДЕЛЬНОЙ строкой (решение владельца
    // 05.10.2026). Не «ещё один этап»: двигатель, который гоняли второй раз, в группе
    // своего этапа неотличим от never-возвращавшегося, а это ровно то, что цеху видеть.
    // Поэтому такие двигатели уходят из групп этапов — иначе строка «Возвраты» была бы
    // пустой, а счётчики этапов врали бы. Утиль выше: уход в брак важнее повтора.
    if (returnsPass(e) >= 2) {
      return {
        key: 'returns',
        label: ENGINE_FACTORY_STAGE_LABELS.returns,
        // Этап, на котором движок стоит, — иначе строка «Возвраты» была бы списком
        // без указания, что там с двигателем, а колонка «Этап на заводе» врала бы.
        stageLabel: stage.label,
        rank: ENGINE_FACTORY_STAGE_RANK.returns,
        at: stage.at,
      };
    }
    return stage;
  }
  if (flags.status_repaired === true) {
    return { key: 'repaired', label: ENGINE_FACTORY_STAGE_LABELS.repaired, rank: ENGINE_FACTORY_STAGE_RANK.repaired, at: engineStatusDate(e, 'status_repaired') };
  }
  const sheet = sheetStage(e, types);
  if (sheet) return sheet;
  if (e.hasDefectAct === true) {
    return { key: 'defect_act', label: ENGINE_FACTORY_STAGE_LABELS.defectAct, rank: ENGINE_FACTORY_STAGE_RANK.defectAct, at: dateMs(e.defectDate) };
  }
  // Дата берётся из акта («Провести комплектность» её и ставит): до этого группа была
  // единственной без «Даты этапа». Признак «акт начали заполнять» пока оставлен вторым
  // основанием — снять его значит разом вывести из группы двигатели, у которых дата не
  // проставлена, а это решение владельца (вопрос записан в handoff).
  if (e.completenessActDate != null || e.hasCompletenessAct === true) {
    return {
      key: 'completeness_act',
      label: ENGINE_FACTORY_STAGE_LABELS.completenessAct,
      rank: ENGINE_FACTORY_STAGE_RANK.completenessAct,
      at: dateMs(e.completenessActDate),
    };
  }
  if (flags.status_repair_started === true) {
    return { key: 'repair_started', label: ENGINE_FACTORY_STAGE_LABELS.repairStarted, rank: ENGINE_FACTORY_STAGE_RANK.repairStarted, at: engineStatusDate(e, 'status_repair_started') };
  }
  return { key: 'arrived', label: ENGINE_FACTORY_STAGE_LABELS.arrived, rank: ENGINE_FACTORY_STAGE_RANK.arrived, at: dateMs(e.arrivalDate) };
}

/**
 * Подпись колонки «Этап / Этап на заводе» (раскатка пилота #1195, решение
 * владельца 09.10.2026): этап строкой, у повторного прохода — с суффиксом
 * «· возврат», как в списке двигателей. Группировка и сортировка идут по
 * `key`/`rank` — сюда только текст (печать берёт его же из `render`).
 */
export function formatEngineFactoryStageLabel(stage: Pick<EngineFactoryStage, 'key' | 'label' | 'stageLabel'>): string {
  const base = stage.stageLabel ?? stage.label;
  return stage.key === 'returns' ? `${base} · возврат` : base;
}

/**
 * Полный ряд групп отчёта от позднего к раннему (для порядка групп и пустых групп в шапке):
 * утиль, возвраты, отремонтирован, единый список по шаблону (поздние выше), этапы работ
 * по видам, дефектовка, комплектовка, ремонт начат, пришёл.
 */
export function engineFactoryStageOrder(
  types?: readonly EngineFactoryStageTypeRef[],
  stageTemplates?: readonly RepairStageTemplate[],
): Array<Pick<EngineFactoryStage, 'key' | 'label' | 'rank'>> {
  const sheets = orderedTypes(types).map((t, idx) => ({ key: `sheet:${t.code}`, label: t.name, rank: ENGINE_FACTORY_STAGE_RANK.sheetBase + idx }));
  const ordered = orderedStageTemplates(stageTemplates);
  const lineStages = ordered
    .filter((t) => t.sideBranch !== true)
    .map((t, idx) => ({ key: `stage:${t.code}`, label: t.name, rank: ENGINE_FACTORY_STAGE_RANK.stageBase + idx }))
    .reverse();
  // Боковая ветка — сразу после «Ремонт начат», с тем же рангом: вне линейки,
  // но не вперемешку с ней. Равные соседние ранги stable-сортировка не двигает.
  const sideStages = ordered
    .filter((t) => t.sideBranch === true)
    .map((t) => ({ key: `stage:${t.code}`, label: t.name, rank: ENGINE_FACTORY_STAGE_RANK.repairStarted }));
  return [
    { key: 'scrap', label: ENGINE_FACTORY_STAGE_LABELS.scrap, rank: ENGINE_FACTORY_STAGE_RANK.scrap },
    { key: 'returns', label: ENGINE_FACTORY_STAGE_LABELS.returns, rank: ENGINE_FACTORY_STAGE_RANK.returns },
    { key: 'repaired', label: ENGINE_FACTORY_STAGE_LABELS.repaired, rank: ENGINE_FACTORY_STAGE_RANK.repaired },
    ...lineStages,
    ...sheets.reverse(),
    { key: 'defect_act', label: ENGINE_FACTORY_STAGE_LABELS.defectAct, rank: ENGINE_FACTORY_STAGE_RANK.defectAct },
    { key: 'completeness_act', label: ENGINE_FACTORY_STAGE_LABELS.completenessAct, rank: ENGINE_FACTORY_STAGE_RANK.completenessAct },
    { key: 'repair_started', label: ENGINE_FACTORY_STAGE_LABELS.repairStarted, rank: ENGINE_FACTORY_STAGE_RANK.repairStarted },
    ...sideStages,
    { key: 'arrived', label: ENGINE_FACTORY_STAGE_LABELS.arrived, rank: ENGINE_FACTORY_STAGE_RANK.arrived },
  ];
}
