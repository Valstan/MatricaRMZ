// Кладовщик (СИЗ), MVP: ядро расчёта норм и сроков выдачи.
// Одно на всех: карточка сотрудника, отчёты и будущий прогноз считают через него,
// иначе «невыданное» в ведомости и «просрочка» в карточке разъедутся (два калькулятора).
export const PPE_DAY_MS = 86_400_000;
/** За сколько дней до срока позиция попадает в «скоро выдавать». */
export const PPE_DUE_SOON_DAYS = 14;

export type PpeNormLineInput = {
  normSetId: string;
  nomenclatureId: string;
  qty: number;
  wearMonths: number;
  /** Условия набора- владельца строки (NULL = для всех). Фаза 2: пол/сезон/дежурные. */
  setGender?: string | null;
  setSeason?: string | null;
};

/** Контекст расчёта: пол сотрудника и сезон. Не задан — фильтра по оси нет. */
export type PpeNormCondition = {
  gender?: string | null;
  season?: string | null;
};

export type PpeAbsenceInput = {
  fromMs: number;
  toMs: number;
};

export type PpeIssueEntryInput = {
  nomenclatureId: string;
  qty: number;
  issuedAt: number;
};

export type MergedPpeNorm = {
  nomenclatureId: string;
  qty: number;
  wearMonths: number;
};

export type PpeIssueStatus = 'overdue' | 'dueSoon' | 'ok' | 'neverIssued';

export type PpeNextIssue = MergedPpeNorm & {
  lastIssuedAt: number | null;
  nextDueAt: number | null;
  status: PpeIssueStatus;
};

/** Календарные месяцы по UTC: срок носки «12 мес» = та же дата через год. */
export function addWearMonths(fromMs: number, wearMonths: number): number {
  const d = new Date(fromMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + wearMonths, d.getUTCDate());
}

/**
 * Слияние нескольких норм сотрудника в одну: количества суммируются,
 * при пересечении позиции живёт минимальный срок носки (строже = раньше напомним).
 * Порядок детерминирован (по номенклатуре) — списки не прыгают между прогонами.
 *
 * Фаза 2: второй аргумент (опционален) — фильтр по условиям набора.
 * NULL в норме = подходит всем; незаданная ось контекста не режет ничего.
 * Без второго аргумента поведение ровно как в MVP.
 */
export function resolveEmployeeNorms(lines: PpeNormLineInput[], cond?: PpeNormCondition): MergedPpeNorm[] {
  const gender = cond?.gender ?? null;
  const season = cond?.season ?? null;
  const kept = !cond
    ? lines
    : lines.filter(
      (l) =>
        (l.setGender == null || gender == null || l.setGender === gender) &&
        (l.setSeason == null || season == null || l.setSeason === season),
    );
  const byNom = new Map<string, { qty: number; wearMonths: number }>();
  for (const l of kept) {
    const cur = byNom.get(l.nomenclatureId);
    if (!cur) {
      byNom.set(l.nomenclatureId, { qty: l.qty, wearMonths: l.wearMonths });
    } else {
      cur.qty += l.qty;
      if (l.wearMonths < cur.wearMonths) cur.wearMonths = l.wearMonths;
    }
  }
  return [...byNom.entries()]
    .map(([nomenclatureId, v]) => ({ nomenclatureId, qty: v.qty, wearMonths: v.wearMonths }))
    .sort((a, b) => (a.nomenclatureId < b.nomenclatureId ? -1 : 1));
}

/**
 * Сдвиг срока на пересечение с отсутствиями (календарные дни, UTC):
 * каждый день отсутствия до срока продлевает носку на день.
 * Пересекающиеся отсутствия считаются по объединению, а не дважды.
 */
export function shiftByAbsences(nextDueAt: number, absences: PpeAbsenceInput[]): number {
  const spans = absences
    .filter((a) => a.fromMs < nextDueAt && a.toMs > a.fromMs)
    .map((a) => [a.fromMs, Math.min(a.toMs, nextDueAt)] as const)
    .sort((x, y) => x[0] - y[0]);
  let shiftMs = 0;
  let coveredUntil = -1;
  for (const [start, end] of spans) {
    if (start >= coveredUntil) {
      shiftMs += end - start;
      coveredUntil = end;
    } else if (end > coveredUntil) {
      shiftMs += end - coveredUntil;
      coveredUntil = end;
    }
  }
  return nextDueAt + Math.round(shiftMs / PPE_DAY_MS) * PPE_DAY_MS;
}

/**
 * Нормы сотрудника = личные привязки + привязки его групп (транзитивно).
 * Дедуп по norm_set_id; конфликт сроков решается позже слиянием
 * (resolveEmployeeNorms берёт минимальный) — и для групповых тоже.
 */
export function resolveGroupNorms(input: {
  personalNormSetIds: string[];
  memberGroupIds: string[];
  groupNorms: Array<{ groupId: string; normSetId: string }>;
}): string[] {
  const out = new Set(input.personalNormSetIds);
  const member = new Set(input.memberGroupIds);
  for (const g of input.groupNorms) {
    if (member.has(g.groupId)) out.add(g.normSetId);
  }
  return [...out].sort();
}

/**
 * Даты следующих выдач: последняя выдача + срок носки. Без выдач — `neverIssued`
 * (срок не тикает из пустоты: норма назначена, но отсчёт идёт от факта).
 * Пятый аргумент (опционален) — отсутствия: срок сдвигается shiftByAbsences.
 */
export function nextIssueDates(
  merged: MergedPpeNorm[],
  entries: PpeIssueEntryInput[],
  now: number,
  dueSoonDays: number = PPE_DUE_SOON_DAYS,
  absences: PpeAbsenceInput[] = [],
): PpeNextIssue[] {
  const lastByNom = new Map<string, number>();
  for (const e of entries) {
    const cur = lastByNom.get(e.nomenclatureId);
    if (cur == null || e.issuedAt > cur) lastByNom.set(e.nomenclatureId, e.issuedAt);
  }
  return merged.map((m) => {
    const last = lastByNom.get(m.nomenclatureId) ?? null;
    if (last == null) {
      return { ...m, lastIssuedAt: null, nextDueAt: null, status: 'neverIssued' as const };
    }
    const rawDueAt = addWearMonths(last, m.wearMonths);
    const nextDueAt = absences.length > 0 ? shiftByAbsences(rawDueAt, absences) : rawDueAt;
    const status: PpeIssueStatus =
      nextDueAt <= now ? 'overdue' : nextDueAt <= now + dueSoonDays * PPE_DAY_MS ? 'dueSoon' : 'ok';
    return { ...m, lastIssuedAt: last, nextDueAt, status };
  });
}

/**
 * «Кому и что выдавать в ближайшие N дней»: просрочка и ближайшие сроки,
 * сортировка по дате (старые первыми). Зародыш заявки и прогноза запасов —
 * те же данные, та же функция, другой горизонт.
 */
export function upcomingIssues(
  merged: MergedPpeNorm[],
  entries: PpeIssueEntryInput[],
  now: number,
  horizonDays: number,
): PpeNextIssue[] {
  const horizon = now + horizonDays * PPE_DAY_MS;
  return nextIssueDates(merged, entries, now)
    .filter((n) => n.nextDueAt != null && n.nextDueAt <= horizon)
    .sort((a, b) => (a.nextDueAt ?? 0) - (b.nextDueAt ?? 0) || (a.nomenclatureId < b.nomenclatureId ? -1 : 1));
}
