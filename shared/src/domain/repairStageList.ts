// ЕДИНЫЙ ИСТОЧНИК ИСТИНЫ для списка этапов ремонта (промт КАРМАНА #181, пункт 4).
//
// Правило владельца: этап строки берётся из серверного шаблона, а при его отсутствии —
// из статичной линейки, и подпись ступени не должна зависеть от того, ответил ли сервер
// (иначе один и тот же двигатель попадал бы в разные группы при офлайне).
//
// До этого промта ряд этапов собирался в трёх местах (ступень «История», ряд значений
// ступени «Текущее состояние», новый шаблон фильтра списка) — и каждый раз по-своему:
// подпись, порядок и сам состав этапов могли разойтись. Здесь — одна сборка, из которой
// берут все: список двигателей, отчёт «Сейчас на заводе» и шаблоны фильтров.
//
// Состав: только этапы РЕМОНТА. Служебный этап («Создание карточки двигателя»)
// отметка о заведении карточки, а не этап ремонта (решение владельца 02.11.2026) —
// в фильтр он не попадает.

import { orderedStageTemplates } from './engineFactoryStage.js';
import { DEFAULT_REPAIR_STAGE_TEMPLATES, isServiceStageCode, type RepairStageTemplate } from './repairStages.js';

/** Префикс значения этапа в ступени «История»: `stage:<код>`. */
export const REPAIR_STAGE_VALUE_PREFIX = 'stage:';

/** Префикс значения этапа в ступени «Этап ремонта»: `repair:<код>`. */
export const REPAIR_STAGE_STEP_VALUE_PREFIX = 'repair:';

/**
 * Значение ступени «История» для кода этапа (`stage:<код>`).
 *
 * Это ПРОШЕДШИЕ этапы («двигатель проходил такой этап»), их список живёт в ступени
 * «История». Ступень «Этап ремонта» (двигатель СЕЙЧАС на этом этапе) живёт в своём
 * пространстве имён — `repair:<код>`, чтобы два разных вопроса не путались в одном отборе.
 */
export function stageValueOf(code: string | null | undefined): string | null {
  const c = String(code ?? '').trim().toLowerCase();
  if (!c || isServiceStageCode(c)) return null;
  return `${REPAIR_STAGE_VALUE_PREFIX}${c}`;
}

/** Значение ступени «Этап ремонта» для кода этапа (`repair:<код>`). */
export function repairStageValue(code: string | null | undefined): string | null {
  const c = String(code ?? '').trim().toLowerCase();
  if (!c || isServiceStageCode(c)) return null;
  return `${REPAIR_STAGE_STEP_VALUE_PREFIX}${c}`;
}

/** Код этапа из значения ступени `stage:<код>` или `repair:<код>`; не значение — `null`. */
export function repairStageCodeFromValue(value: string | null | undefined): string | null {
  const v = String(value ?? '').trim().toLowerCase();
  for (const prefix of [REPAIR_STAGE_VALUE_PREFIX, REPAIR_STAGE_STEP_VALUE_PREFIX]) {
    if (!v.startsWith(prefix)) continue;
    const code = v.slice(prefix.length).trim();
    if (code) return code;
  }
  return null;
}

export type RepairStageListItem = {
  /** Код этапа ремонта (`ukladka`, `sborka`, …). */
  code: string;
  /** Значение ступени «История» (`stage:<код>`) — этап проходил когда-то. */
  historyValue: string;
  /** Значение ступени «Этап ремонта» (`repair:<код>`) — двигатель СЕЙЧАС на этом этапе. */
  stepValue: string;
  /** Подпись этапа — из серверного шаблона, при его отсутствии — из статичной линейки. */
  label: string;
  /** Приоритет линейки: чем больше, тем позже этап. */
  sortOrder: number;
  /** Боковая ветка (утиль/брак): вне линейки, по датам не участвует. */
  sideBranch: boolean;
};

/**
 * Ряд этапов ремонта — из одного места: серверный шаблон (порядок и названия меняет
 * владелец), при его отсутствии — статичная линейка `DEFAULT_REPAIR_STAGE_TEMPLATES`.
 *
 * Гарантии (на них стоит сторож промта #181):
 * - каждый этап встречается РОВНО ОДИН РАЗ (дубли кода из справочника схлопываются);
 * - служебный этап в ряд не попадает;
 * - порядок: линейка по приоритету, боковая ветка — в конец (тот же порядок, что у
 *   групп отчёта: «поздние выше» — это порядок показа, здесь порядок справочника).
 *
 * Офлайн и онлайн дают ОДИН И ТОТ ЖЕ ряд: серверный шаблон меняет лишь названия и
 * приоритеты, но не сам состав этапов ремонта.
 */
export function repairStageList(templates?: readonly RepairStageTemplate[]): RepairStageListItem[] {
  const source = templates && templates.length > 0 ? templates : DEFAULT_REPAIR_STAGE_TEMPLATES;
  const out: RepairStageListItem[] = [];
  const seen = new Set<string>();
  for (const template of orderedStageTemplates(source)) {
    const code = String(template.code ?? '').trim().toLowerCase();
    if (!code || isServiceStageCode(code)) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({
      code,
      historyValue: `${REPAIR_STAGE_VALUE_PREFIX}${code}`,
      stepValue: `${REPAIR_STAGE_STEP_VALUE_PREFIX}${code}`,
      label: String(template.name ?? '').trim() || code,
      sortOrder: Number(template.sortOrder ?? 0),
      sideBranch: template.sideBranch === true,
    });
  }
  return out;
}

/** Подпись этапа по коду — тем же рядом (серверный шаблон → статичная линейка). */
export function repairStageLabel(code: string | null | undefined, templates?: readonly RepairStageTemplate[]): string | null {
  const c = String(code ?? '').trim().toLowerCase();
  if (!c || isServiceStageCode(c)) return null;
  const hit = repairStageList(templates).find((item) => item.code === c);
  return hit ? hit.label : null;
}

/**
 * Коды этапов, выбранные в ступени, — по значениям `stage:<код>`.
 * «этапов нет» кодом не является: в выборку оно не попадает.
 */
export function repairStageCodesFromSelection(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const value of values) {
    const code = repairStageCodeFromValue(typeof value === 'string' ? value : '');
    if (!code || out.includes(code)) continue;
    out.push(code);
  }
  return out;
}
