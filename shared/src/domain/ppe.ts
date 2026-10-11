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
 */
export function resolveEmployeeNorms(lines: PpeNormLineInput[]): MergedPpeNorm[] {
  const byNom = new Map<string, { qty: number; wearMonths: number }>();
  for (const l of lines) {
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
 * Даты следующих выдач: последняя выдача + срок носки. Без выдач — `neverIssued`
 * (срок не тикает из пустоты: норма назначена, но отсчёт идёт от факта).
 */
export function nextIssueDates(
  merged: MergedPpeNorm[],
  entries: PpeIssueEntryInput[],
  now: number,
  dueSoonDays: number = PPE_DUE_SOON_DAYS,
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
    const nextDueAt = addWearMonths(last, m.wearMonths);
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
