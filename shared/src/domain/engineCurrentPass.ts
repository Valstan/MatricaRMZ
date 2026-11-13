import type { EngineListItem, EngineStageEntry } from '../ipc/types.js';
import { compareStageRecency, repairStageRank } from './repairStages.js';

/**
 * «Сейчас» двигателя: текущий заезд и текущий проход (владелец 13.11.2026).
 *
 * Заявка владельца: «в режиме „Сейчас на заводе“ фильтром должны отсекаться все предыдущие
 * этапы ремонта… при повторных заездах и повторных операциях и при завозе двигателя на завод
 * по рекламации он не показывал предыдущие этапы и не путал оператора. Например двигатель
 * прошёл полный цикл ремонта, получил статус „Отгружен заказчику“, а потом пришёл по рекламации
 * снова — не нужно, чтобы его фильтровали по отгрузке или показывали статус „Отгружен
 * заказчику“, потому что это уже неправда».
 *
 * Два правила, из которых складывается «сейчас»:
 *
 * 1. **ЗАЕЗД.** Граница заезда — последняя приёмка (`arrival` / `arrival_reclamation`). Всё, что
 *    было до неё, — прошлый заезд: в режиме «сейчас» оно не действует. Рекламация — такой же
 *    разделитель, как обычный повторный приём.
 * 2. **ПРОХОД.** Внутри заезда шаг назад (этап ниже уже пройденного) обнуляет этапы выше него:
 *    был на обкатке, вернулся на сборку — обкатка в прошлом, «сейчас» движок на сборке.
 *
 * Порядок этапов — по московскому дню, внутри дня по рангу (`compareStageRecency`): полночь
 * ручной даты не должна обгонять момент нажатия. Этап без даты место не определяет и в разбор
 * шага назад не участвует (он не «обгоняет» и не «сбрасывает» ничего).
 *
 * Где применяется: режим «Сейчас на заводе» — и в отчёте, и в списке двигателей. Где НЕ
 * применяется: отчёты статистики («Этапы ремонта», ведомости, выгрузки) — там все операции
 * равны и считаются по всем датам (прямое требование владельца).
 */

/** Коды этапов, которыми начинается заезд: приёмка двигателя на завод (обычная и по рекламации). */
const VISIT_START_CODES = new Set(['arrival', 'arrival_reclamation']);

function codeOf(entry: EngineStageEntry): string {
  return String(entry?.code ?? '').trim().toLowerCase();
}

function atOf(entry: EngineStageEntry): number {
  const at = Number(entry?.at ?? 0);
  return Number.isFinite(at) && at > 0 ? at : 0;
}

function rankOf(code: string): number {
  return repairStageRank(code);
}

/** Приёмка (любая) — граница заезда. */
function isVisitStart(code: string): boolean {
  return VISIT_START_CODES.has(code);
}

/**
 * Действующие сейчас проходы этапов: текущий заезд минус этапы, сброшенные шагом назад.
 *
 * Порядок — по дате и рангу (как в ленте истории). Пустой набор — двигатель без этапов.
 */
export function currentPassStageEntries(entries: readonly EngineStageEntry[]): EngineStageEntry[] {
  const sorted = [...(entries ?? [])]
    .filter((entry) => entry && codeOf(entry))
    .sort((a, b) => compareStageRecency(a, b));
  if (sorted.length === 0) return [];

  // Этап без даты место не определяет: в порядке он стоит первым, и заезд он не помечает.
  // Такие строки — факт истории (оператор добавил этап без даты), поэтому они действуют
  // всегда и ни на что не влияют.
  const dated = sorted.filter((entry) => atOf(entry) > 0);
  const undated = sorted.filter((entry) => atOf(entry) <= 0);

  // 1. Текущий заезд — от последней приёмки (только по датированным: без даты заезда нет).
  let visitStart = -1;
  for (let i = dated.length - 1; i >= 0; i -= 1) {
    if (isVisitStart(codeOf(dated[i]!))) {
      visitStart = i;
      break;
    }
  }
  const visit = visitStart >= 0 ? dated.slice(visitStart) : dated;

  // 2. Внутри заезда шаг назад обнуляет этапы выше него.
  const effective: EngineStageEntry[] = [];
  let maxRank = Number.NEGATIVE_INFINITY;
  for (const entry of visit) {
    const rank = rankOf(codeOf(entry));
    const datedEntry = atOf(entry) > 0;
    if (datedEntry && rank > 0 && rank < maxRank) {
      // Шаг назад: всё, что выше этого этапа, в текущем проходе ещё не было.
      for (let i = effective.length - 1; i >= 0; i -= 1) {
        const other = rankOf(codeOf(effective[i]!));
        if (other > 0 && other > rank) effective.splice(i, 1);
      }
      maxRank = rank;
    }
    effective.push(entry);
    if (datedEntry && rank > maxRank) maxRank = rank;
  }
  return [...effective, ...undated];
}

/** Действующие сейчас коды этапов — в порядке линейки, без повторов (как `stageCodes`). */
export function currentPassStageCodes(entries: readonly EngineStageEntry[]): string[] {
  const out: string[] = [];
  for (const entry of currentPassStageEntries(entries)) {
    const code = codeOf(entry);
    if (code && !out.includes(code)) out.push(code);
  }
  return out.sort((a, b) => rankOf(a) - rankOf(b));
}

/** Действующие сейчас даты этапов (код → ms) — как `stageDates`, но без прошлых проходов. */
export function currentPassStageDates(entries: readonly EngineStageEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of currentPassStageEntries(entries)) {
    const code = codeOf(entry);
    const at = atOf(entry);
    if (!code || !at) continue;
    const prev = out[code];
    if (prev === undefined || at > prev) out[code] = at;
  }
  return out;
}

/** Текущее место: последний ДАТИРОВАННЫЙ действующий этап. */
export function currentPassLastStage(entries: readonly EngineStageEntry[]): EngineStageEntry | null {
  let last: EngineStageEntry | null = null;
  for (const entry of currentPassStageEntries(entries)) {
    if (atOf(entry) <= 0) continue;
    if (!last || compareStageRecency(entry, last) > 0) last = entry;
  }
  return last;
}

/**
 * Строка списка в режиме «сейчас»: действующие этапы вместо всей истории.
 *
 * Трансформация строки, а не отдельная ветка в каждом отчёте: все существующие отборы,
 * колонки и группы начинают отвечать про текущий момент сами — иначе правило «сейчас» надо
 * было бы повторять в каждом месте, где читаются `stageCodes`.
 */
export function currentPassRow<T extends EngineListItem>(row: T): T {
  const entries = row.stageEntries ?? [];
  if (entries.length === 0) return row;
  const effective = currentPassStageEntries(entries);
  const codes: string[] = [];
  const dates: Record<string, number> = {};
  for (const entry of effective) {
    const code = codeOf(entry);
    if (!code) continue;
    if (!codes.includes(code)) codes.push(code);
    const at = atOf(entry);
    if (Number.isFinite(at) && at > 0) {
      const prev = dates[code];
      if (prev === undefined || at > prev) dates[code] = at;
    }
  }
  const last = currentPassLastStage(entries);
  const next = { ...row, stageCodes: codes, stageDates: dates, stageEntries: effective } as T;
  if (last) {
    next.lastStageCode = codeOf(last);
    next.lastStageName = String(last.name ?? '');
    next.lastStageAt = atOf(last);
    const pass = Number(last.pass ?? 1);
    if (pass > 1) next.lastStagePass = pass;
    else delete next.lastStagePass;
  } else {
    delete next.lastStageCode;
    delete next.lastStageName;
    delete next.lastStageAt;
    delete next.lastStagePass;
  }
  return next;
}

/** Строки списка в режиме «сейчас» — теми же правилами, что и одна строка. */
export function currentPassRows<T extends EngineListItem>(rows: readonly T[]): T[] {
  return (rows ?? []).map((row) => currentPassRow(row));
}
