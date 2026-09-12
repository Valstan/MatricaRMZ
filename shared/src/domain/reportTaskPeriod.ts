/**
 * Период из задачи, сформулированной словами («за сентябрь», «за прошлый месяц», «с 1 по
 * 15 сентября», «за последние 30 дней»). Нужен ИИванычу, чтобы подобрать не просто отчёт,
 * а отчёт с настройками: без периода оператор всё равно лезет в фильтры руками.
 *
 * Разбор детерминированный, а не модельный: модель путает формат дат и часовой пояс, и
 * ошибка видна только тому, кто открыл отчёт с чужим отбором. Границы считаются в местном
 * времени и включают весь последний день.
 */
export type ReportTaskPeriod = {
  startMs: number;
  endMs: number;
  /** Как назвать период оператору: «сентябрь 2026», «01.09.2026 — 15.09.2026». */
  label: string;
};

const MONTHS: Array<{ index: number; names: string[] }> = [
  { index: 0, names: ['январь', 'января', 'январе'] },
  { index: 1, names: ['февраль', 'февраля', 'феврале'] },
  { index: 2, names: ['март', 'марта', 'марте'] },
  { index: 3, names: ['апрель', 'апреля', 'апреле'] },
  { index: 4, names: ['май', 'мая', 'мае'] },
  { index: 5, names: ['июнь', 'июня', 'июне'] },
  { index: 6, names: ['июль', 'июля', 'июле'] },
  { index: 7, names: ['август', 'августа', 'августе'] },
  { index: 8, names: ['сентябрь', 'сентября', 'сентябре'] },
  { index: 9, names: ['октябрь', 'октября', 'октябре'] },
  { index: 10, names: ['ноябрь', 'ноября', 'ноябре'] },
  { index: 11, names: ['декабрь', 'декабря', 'декабре'] },
];

const MONTH_LABELS = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
];

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

function endOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
}

function monthRange(year: number, monthIndex: number): ReportTaskPeriod {
  const from = new Date(year, monthIndex, 1);
  const to = new Date(year, monthIndex + 1, 0);
  return { startMs: startOfDay(from), endMs: endOfDay(to), label: `${MONTH_LABELS[monthIndex]} ${year}` };
}

function dayLabel(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function findMonth(text: string): { index: number; at: number } | null {
  for (const m of MONTHS) {
    for (const name of m.names) {
      const at = text.indexOf(name);
      if (at >= 0) return { index: m.index, at };
    }
  }
  return null;
}

/** Год из текста: только правдоподобный (2000–2100), иначе номера деталей стали бы годами. */
function findYear(text: string): number | null {
  const m = text.match(/\b(20\d{2})\b/);
  if (!m) return null;
  const year = Number(m[1]);
  return year >= 2000 && year <= 2100 ? year : null;
}

/**
 * @param task текст задачи оператора
 * @param now  «сегодня» (параметр, а не `Date.now()`, — иначе функцию нельзя проверить тестом)
 */
export function parseReportTaskPeriod(task: string, now: Date = new Date()): ReportTaskPeriod | null {
  const text = String(task ?? '').toLowerCase().replace(/ё/g, 'е');
  if (!text.trim()) return null;

  // «с 1 по 15 сентября», «с 01.09.2026 по 15.09.2026»
  const explicit = text.match(/с\s+(\d{1,2})[.\s/-](\d{1,2})[.\s/-](\d{2,4})\s+по\s+(\d{1,2})[.\s/-](\d{1,2})[.\s/-](\d{2,4})/);
  if (explicit) {
    const y1 = Number(explicit[3]!.length === 2 ? `20${explicit[3]}` : explicit[3]);
    const y2 = Number(explicit[6]!.length === 2 ? `20${explicit[6]}` : explicit[6]);
    const from = new Date(y1, Number(explicit[2]) - 1, Number(explicit[1]));
    const to = new Date(y2, Number(explicit[5]) - 1, Number(explicit[4]));
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && from <= to) {
      return { startMs: startOfDay(from), endMs: endOfDay(to), label: `${dayLabel(startOfDay(from))} — ${dayLabel(endOfDay(to))}` };
    }
  }

  // «с 1 по 15 сентября» — месяц один на обе границы
  const withinMonth = text.match(/с\s+(\d{1,2})\s+по\s+(\d{1,2})\s+([а-я]+)/);
  if (withinMonth) {
    const month = findMonth(withinMonth[3]!);
    if (month) {
      const year = findYear(text) ?? now.getFullYear();
      const from = new Date(year, month.index, Number(withinMonth[1]));
      const to = new Date(year, month.index, Number(withinMonth[2]));
      if (from <= to) {
        return { startMs: startOfDay(from), endMs: endOfDay(to), label: `${dayLabel(startOfDay(from))} — ${dayLabel(endOfDay(to))}` };
      }
    }
  }

  // «за последние 30 дней», «за 2 недели», «за последний месяц»
  const lastN = text.match(/(?:за\s+)?(?:последни[ей]\s+)?(\d{1,3})\s*(дн|дня|дней|недел|месяц)/);
  if (lastN) {
    const n = Number(lastN[1]);
    const unit = lastN[2]!;
    const days = unit.startsWith('недел') ? n * 7 : unit.startsWith('месяц') ? n * 30 : n;
    if (n > 0 && days <= 3650) {
      const to = new Date(now);
      const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
      return { startMs: startOfDay(from), endMs: endOfDay(to), label: `последние ${days} дн.` };
    }
  }

  if (/прошл[а-я]*\s+месяц/.test(text)) {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return monthRange(d.getFullYear(), d.getMonth());
  }
  if (/(этот|текущ[а-я]*)\s+месяц|за\s+месяц\b/.test(text)) {
    return monthRange(now.getFullYear(), now.getMonth());
  }
  if (/прошл[а-я]*\s+год/.test(text)) {
    const year = now.getFullYear() - 1;
    return { startMs: startOfDay(new Date(year, 0, 1)), endMs: endOfDay(new Date(year, 11, 31)), label: `${year} год` };
  }
  if (/(этот|текущ[а-я]*)\s+год|за\s+год\b/.test(text)) {
    const year = findYear(text) ?? now.getFullYear();
    return { startMs: startOfDay(new Date(year, 0, 1)), endMs: endOfDay(new Date(year, 11, 31)), label: `${year} год` };
  }
  if (/(за\s+)?(сегодня|текущ[а-я]*\s+день)/.test(text)) {
    return { startMs: startOfDay(now), endMs: endOfDay(now), label: dayLabel(startOfDay(now)) };
  }
  if (/(за\s+)?вчера/.test(text)) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return { startMs: startOfDay(d), endMs: endOfDay(d), label: dayLabel(startOfDay(d)) };
  }
  if (/(за\s+)?недел/.test(text)) {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    return { startMs: startOfDay(from), endMs: endOfDay(now), label: 'последние 7 дн.' };
  }

  // «за сентябрь», «за сентябрь 2025»
  const month = findMonth(text);
  if (month) {
    const year = findYear(text) ?? now.getFullYear();
    return monthRange(year, month.index);
  }

  // Голый год: «за 2025»
  const year = findYear(text);
  if (year && /за\s+20\d{2}/.test(text)) {
    return { startMs: startOfDay(new Date(year, 0, 1)), endMs: endOfDay(new Date(year, 11, 31)), label: `${year} год` };
  }
  return null;
}
