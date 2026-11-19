/**
 * График отпусков: сетка «месяц → две половины» и раскладка периодов по ячейкам.
 *
 * Сетка читается без прокрутки по месяцу: каждый месяц занимает две колонки —
 * первая половина (1–15) и вторая (16–последний день). Период отпуска рисуется
 * полосой внутри своей половины: отступ пропорционален началу периода, ширина —
 * числу закрытых дней. Период через границу месяца виден в обеих половинах.
 *
 * Всё считается по МЕСТНОМУ времени машины оператора: границы месяца и «день
 * понедельника» — понятия календарные, а не UTC.
 */

/** Дней в календарном месяце (month — 1..12). */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** Половина месяца: 1 — первая (1–15), 2 — вторая (16–последний день). */
export type VacationHalf = {
  /** Месяц, 1..12. */
  month: number;
  /** Половина месяца: 1 или 2. */
  half: 1 | 2;
  /** Сколько дней в этой половине. */
  days: number;
  /** Номер колонки в сетке: 0 — первая половина января, 23 — вторая половина декабря. */
  index: number;
};

/** Сетка года: 12 месяцев × 2 половины = 24 колонки. */
export function vacationHalves(year: number): VacationHalf[] {
  const out: VacationHalf[] = [];
  for (let month = 1; month <= 12; month += 1) {
    const total = daysInMonth(year, month);
    out.push({ month, half: 1, days: 15, index: (month - 1) * 2 });
    out.push({ month, half: 2, days: total - 15, index: (month - 1) * 2 + 1 });
  }
  return out;
}

/**
 * Понедельник недели, в которую попадает указанная дата (может быть в прошлом
 * месяце — период через границу сетка рисует).
 */
export function mondayOfDate(year: number, month: number, day: number): number {
  const d = new Date(year, month - 1, day);
  const dow = d.getDay(); // 0 — воскресенье
  const back = dow === 1 ? 0 : (dow + 6) % 7; // 1→0 (понедельник), 0→6 (воскресенье → понедельник назад)
  return new Date(year, month - 1, day - back).getTime();
}

/**
 * Ближайший понедельник: сегодняшний, если сегодня понедельник, иначе — следующий.
 * Отсюда и считаем период по умолчанию: отпуск не начинается задним числом.
 */
export function nextMondayStart(ms: number): number {
  const d = new Date(ms);
  const dow = d.getDay(); // 0 — воскресенье
  const ahead = dow === 1 ? 0 : (8 - dow) % 7; // 1→0 (сегодня), 0→1 (завтра), 2→6…
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + ahead).getTime();
}

/**
 * Период отпуска по умолчанию: две недели с понедельника — с понедельника по
 * воскресенье через две недели (14 дней, конец = понедельник + 13 дней).
 */
export function defaultVacationPeriod(nowMs: number): { fromMs: number; toMs: number } {
  const fromMs = nextMondayStart(nowMs);
  const toMs = fromMs + 14 * 86_400_000 - 1; // последняя миллисекунда воскресенья
  return { fromMs, toMs };
}

/** Строка отпуска — та, что лежит в `ppe_absences`. */
export type VacationAbsence = {
  id: string;
  employeeId: string;
  fromMs: number;
  toMs: number;
  kind: string;
};

/** Полоса периода внутри одной половины месяца. */
export type VacationSegment = {
  absenceId: string;
  employeeId: string;
  /** Колонка сетки (0..23). */
  halfIndex: number;
  /** Отступ полосы, % от ширины колонки. */
  leftPct: number;
  /** Ширина полосы, % от ширины колонки. */
  widthPct: number;
  /** Подпись периода: «12.01 – 26.01». */
  label: string;
};

function localYmd(ms: number): { y: number; m: number; d: number } {
  const d = new Date(ms);
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

function fmtDay(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Разложить периоды по колонкам сетки года.
 *
 * Период длиннее года и период, начинающийся в прошлом году, обрезаются
 * границами показанного года: сетка показывает то, что в этом году.
 */
export function absenceSegments(absences: VacationAbsence[], year: number): VacationSegment[] {
  const halves = vacationHalves(year);
  const out: VacationSegment[] = [];
  for (const absence of absences ?? []) {
    const start = localYmd(absence.fromMs);
    const end = localYmd(absence.toMs);
    if (end.y < year || start.y > year) continue;
    // Счётчики по половинам месяца: первый закрытый день, последний, число дней.
    const acc = new Map<number, { first: number; last: number; count: number }>();
    let cursor = new Date(start.y, start.m - 1, start.d);
    const last = new Date(end.y, end.m - 1, end.d);
    // Страховка от «вечного» периода: больше 800 дней в графике не рисуем.
    for (let guard = 0; guard <= 800 && cursor <= last; guard += 1) {
      if (cursor.getFullYear() === year) {
        const month = cursor.getMonth() + 1;
        const day = cursor.getDate();
        const half = day <= 15 ? 1 : 2;
        const halfIndex = (month - 1) * 2 + (half - 1);
        const prev = acc.get(halfIndex);
        acc.set(halfIndex, {
          first: prev ? Math.min(prev.first, day) : day,
          last: prev ? Math.max(prev.last, day) : day,
          count: (prev?.count ?? 0) + 1,
        });
      }
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    }
    for (const [halfIndex, info] of acc) {
      const half = halves[halfIndex];
      if (!half) continue;
      const halfStart = half.half === 1 ? 1 : 16;
      out.push({
        absenceId: absence.id,
        employeeId: absence.employeeId,
        halfIndex,
        leftPct: ((info.first - halfStart) / half.days) * 100,
        widthPct: (info.count / half.days) * 100,
        label: `${fmtDay(absence.fromMs)} – ${fmtDay(absence.toMs)}`,
      });
    }
  }
  return out;
}

/**
 * Пересекается ли новый период с уже заведённым. Молчаливый дубль не заводим:
 * предупреждаем, и решение за оператором.
 */
export function findOverlappingAbsence(
  absences: VacationAbsence[],
  employeeId: string,
  fromMs: number,
  toMs: number,
): VacationAbsence | null {
  for (const row of absences ?? []) {
    if (row.employeeId !== employeeId) continue;
    if (row.fromMs <= toMs && fromMs <= row.toMs) return row;
  }
  return null;
}
