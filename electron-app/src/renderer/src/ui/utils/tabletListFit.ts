// Планшетная укладка списков (промт КАРМАНА #70, п.2: «все данные желательно
// перестраивать под экран планшета, потому что они уходят за край»).
//
// Логика чистая и без DOM — её можно посчитать и проверить тестом. На входе:
// колонки (вид данных + естественная ширина содержимого) и ширина экрана в «ch»
// (ширина цифры «0» шрифтом таблицы). На выходе — какие колонки остаются на
// экране, какие свёрнуты и какой ширины каждая оставшаяся.
//
// Порядок решений — «сначала ужать, потом свернуть»: колонка, которую можно
// показать в читаемой ширине, не должна исчезать только потому, что справа от
// неё стоит ещё одна. Но и в ниточку её не сжимаем: если даже минимальной
// ширины не хватает — колонка сворачивается (прячется), а не обрезается.

export type FitColumnKind = 'flag' | 'num' | 'date' | 'name' | 'text' | 'thumbs' | 'rownum' | 'other';

export type FitColumn = {
  /** Номер колонки в таблице (1-based — как nth-child). */
  index: number;
  kind: FitColumnKind;
  /** Естественная ширина содержимого в ch (по квантилям данных). */
  contentCh: number;
};

export type FitPlan = {
  /** Колонки, остающиеся на экране (по возрастанию номера). */
  visible: number[];
  /** Колонки, свёрнутые под ширину экрана. */
  collapsed: number[];
  /** Ширина каждой видимой колонки в ch (ключ — номер колонки). */
  widthsCh: Record<number, number>;
};

/** Минимальная читаемая ширина колонки, ch. Ниже неё колонка — полоска. */
export const FIT_MIN_CH: Record<FitColumnKind, number> = {
  name: 10,
  text: 8,
  num: 6,
  date: 7,
  flag: 5,
  thumbs: 6,
  rownum: 3,
  other: 8,
};

/** Верхняя ширина колонки: за ней колонку лучше свернуть, чем сжимать в ниточку. */
export const FIT_MAX_CH: Record<FitColumnKind, number> = {
  name: 26,
  text: 20,
  num: 14,
  date: 12,
  flag: 7,
  thumbs: 10,
  rownum: 4,
  other: 16,
};

/**
 * Колонки, которые не сворачиваем, пока есть что свернуть: имя объекта — это
 * ключевые данные списка, а «№» — служебная колонка. Сворачиваются они последними.
 */
function isProtected(kind: FitColumnKind): boolean {
  return kind === 'name' || kind === 'rownum';
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

/** Естественная ширина колонки с учётом потолка по виду данных. */
export function naturalWidthCh(column: FitColumn): number {
  return clamp(column.contentCh, FIT_MIN_CH[column.kind], FIT_MAX_CH[column.kind]);
}

/**
 * Ужимает колонки под ширину экрана: сначала пропорционально запасу над
 * минимумом (широкие отдают больше), затем — дорезанием самой широкой.
 * Минимум не нарушается: если даже он не влезает — план решает это сворачиванием.
 */
function shrinkToFit(columns: FitColumn[], availableCh: number): number[] {
  const mins = columns.map((c) => FIT_MIN_CH[c.kind]);
  const widths = columns.map((c) => naturalWidthCh(c));
  let total = sum(widths);
  if (total <= availableCh) return widths;

  const slack = widths.map((w, i) => Math.max(0, w - (mins[i] ?? 0)));
  const slackTotal = sum(slack);
  const excess = total - availableCh;
  if (slackTotal > 0 && excess > 0) {
    for (let i = 0; i < widths.length; i += 1) {
      const min = mins[i] ?? 0;
      const w = widths[i] ?? min;
      const s = slack[i] ?? 0;
      widths[i] = Math.max(min, Math.round(w - (excess * s) / slackTotal));
    }
  }
  total = sum(widths);
  while (total > availableCh) {
    let idx = -1;
    let widest = -1;
    for (let i = 0; i < widths.length; i += 1) {
      const w = widths[i] ?? 0;
      if (w > widest) {
        widest = w;
        idx = i;
      }
    }
    if (idx < 0) break;
    const min = mins[idx] ?? 0;
    const w = widths[idx] ?? 0;
    if (w <= min) break;
    widths[idx] = w - 1;
    total -= 1;
  }
  return widths;
}

/**
 * Кого сворачиваем: самую широкую из незащищённых (при равенстве — правую:
 * справа обычно служебные подписи). Если незащищённых не осталось — самую
 * широкую из оставшихся, кроме служебной «№».
 */
function pickVictim(columns: FitColumn[]): FitColumn | null {
  let victim: FitColumn | null = null;
  for (const col of columns) {
    if (isProtected(col.kind)) continue;
    const w = naturalWidthCh(col);
    const vw = victim ? naturalWidthCh(victim) : -1;
    if (!victim || w > vw || (w === vw && col.index > victim.index)) victim = col;
  }
  if (victim) return victim;
  for (const col of columns) {
    if (col.kind === 'rownum') continue;
    const w = naturalWidthCh(col);
    const vw = victim ? naturalWidthCh(victim) : -1;
    if (!victim || w > vw || (w === vw && col.index > victim.index)) victim = col;
  }
  return victim;
}

/**
 * План укладки списка под ширину экрана.
 *
 * availableCh — ширина экрана в ch. Ширину неизвестна (0 или мусор) — ничего не
 * трогаем: план без изменений, чтобы не спрятать колонки наугад.
 */
export function planTabletFit(columns: FitColumn[], availableCh: number): FitPlan {
  const cols = [...columns].sort((a, b) => a.index - b.index);

  if (!Number.isFinite(availableCh) || availableCh <= 0) {
    const natural = cols.map((c) => [c.index, naturalWidthCh(c)] as const);
    return { visible: cols.map((c) => c.index), collapsed: [], widthsCh: Object.fromEntries(natural) };
  }

  const visible = cols.slice();
  const collapsed: number[] = [];
  let widths = shrinkToFit(visible, availableCh);

  while (sum(widths) > availableCh && visible.length > 1) {
    const victim = pickVictim(visible);
    if (!victim) break;
    visible.splice(visible.indexOf(victim), 1);
    collapsed.push(victim.index);
    widths = shrinkToFit(visible, availableCh);
  }

  const widthsCh: Record<number, number> = {};
  visible.forEach((col, i) => {
    widthsCh[col.index] = widths[i] ?? naturalWidthCh(col);
  });

  return { visible: visible.map((c) => c.index), collapsed: collapsed.slice().sort((a, b) => a - b), widthsCh };
}
