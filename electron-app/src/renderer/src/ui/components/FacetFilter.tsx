import React from 'react';

import {
  activeFacetCount,
  clearFacet,
  createEmptyFacetUsage,
  facetOptions,
  facetRangeOf,
  facetUsageBump,
  facetUsageScore,
  facetValueScore,
  facetValueUsageId,
  normalizeLookupCompact,
  rankByUsage,
  sanitizeFacetUsage,
  setFacetDateBound,
  setFacetDay,
  toggleFacetValue,
  type FacetDescriptor,
  type FacetOption,
  type FacetSelection,
  type FacetUsage,
} from '@matricarmz/shared';

import { Input } from './Input.js';
import { emojiAttrs } from '../utils/labelEmoji.js';
import { FALLBACK_FACET_TONE, facetTones, type FacetTone } from '../utils/facetTone.js';
import { layoutFacetChipGroups, type FacetChipGroup } from '../utils/facetChipLayout.js';

/** Значений больше — в меню ступени появляется поле «Найти…». */
const FACET_VALUE_SEARCH_THRESHOLD = 10;

/**
 * Высота строки плашек под кнопками-родителями. Плашки висят в ОТДЕЛЬНОЙ строке под рядом
 * кнопок (не плавающим слоем поверх него): строка плашек — общая на все ступени, иначе
 * плашки соседних ступеней наезжали друг на друга (владелец 12.11.2026: «наезжают друг на
 * друга, прочитать невозможно, что выбрано, и отключить невозможно»).
 */
const FACET_CHIP_ROW_HEIGHT = 22;

/** Плашка не шире этого — длинное значение обрезается многоточием, полный текст — в подсказке. */
const FACET_CHIP_MAX_WIDTH = 200;

/**
 * Ниже этой ширины плашку не ужимаем: вместо читаемой подписи получится «Пр…», и оператор
 * не поймёт, что выбрано. Лучше пусть ряд выйдет за панель, чем плашка станет нечитаемой.
 */
const FACET_CHIP_MIN_WIDTH = 90;

/** Хранилище рейтинга ступеней: своё у каждого списка (`usageKey`). */
const FACET_USAGE_STORAGE_PREFIX = 'facetUsage:';

/**
 * Открытое меню ступени: по ячейке первого уровня или по плашке выбранного значения.
 * `anchor` — что именно открыто: `'cell'` (ячейка ступени) либо значение плашки.
 */
type FacetMenu = { facetId: string; anchor: 'cell' | string };

/** Меню: выбранное значение — синее с белыми буквами, под курсором — серое. */
const MENU_SELECTED = 'hsl(221 83% 53%)';
const MENU_SELECTED_HOVER = 'hsl(221 83% 45%)';
const MENU_HOVER = 'rgba(127, 127, 127, 0.18)';

function readFacetUsage(usageKey: string | undefined): FacetUsage {
  if (!usageKey) return createEmptyFacetUsage();
  try {
    const raw = window.localStorage.getItem(FACET_USAGE_STORAGE_PREFIX + usageKey);
    return raw ? sanitizeFacetUsage(JSON.parse(raw)) : createEmptyFacetUsage();
  } catch {
    return createEmptyFacetUsage();
  }
}

/**
 * Ступенчатый фильтр списка — **всегда на виду**, под панелью управляющих кнопок
 * (владелец 12.11.2026: «убери кнопку „Фильтры“ отовсюду, пусть панель фильтров будет всегда
 * открыта и активна и видна под панелью управляющих кнопок карточки или списка»). Раньше панель
 * пряталась под кнопку в тулбаре (просьба владельца 08.09.2026: тулбар оброс кнопками, и все
 * отборы должны жить в одном месте) — теперь кнопки нет, а панель стоит под тулбаром всегда.
 * Общий для двигателей и контрактов — ступени приходят описанием, компонент о предметной
 * области ничего не знает.
 *
 * Вид панели (владелец 12.11.2026: «пусть это будут просто надписи на квадратных ячейках,
 * практически без полей»):
 *
 * - **Первый уровень** — ряд компактных ячеек: только надпись ступени, поля в пару пикселей,
 *   фон — бледный цвет своей ступени (`facetTone.ts`). Рамки нет: цвет и есть опознание.
 * - **Меню ступени** — выпадает ПОД ячейкой по наведению мыши (и по щелчку: на планшете
 *   наведения нет). Первая строка меню — «Сбросить фильтр»: снимает ЭТУ ступень. Сбросить
 *   всё — отдельная кнопка в начале ряда. Фон меню **непрозрачный** (владелец 12.11.2026:
 *   сквозь полупрозрачную выпадашку просвечивал список под ней).
 * - **Второй уровень** — выбранные значения стоят плашками ПОД своей ячейки, цветом той же
 *   ступени. Наведение на плашку открывает то же меню ступени — так набирают несколько
 *   значений, не возвращаясь к ячейке. **Щелчок по плашке снимает значение** (владелец
 *   12.11.2026: «наводишь мышку, хочешь отключить данный фильтр, а он не отключается, а только
 *   выпадашка меню выпала и в ней можно только его выбрать и отключить — это лишнее движение»).
 *
 * Числа рядом со значениями — сколько строк останется, и считаются они по строкам, прошедшим
 * ОСТАЛЬНЫЕ ступени. Отсюда следствие, ради которого всё и затевалось: выбор в одной ступени
 * сужает варианты в других, и порядок щелчков ни на что не влияет.
 *
 * Два свойства для узнаваемости (владелец 25.10.2026, «когда открыто много фильтров — каша»):
 * у каждой ступени свой цвет (`facetTone.ts`), и ряд кнопок отсортирован по рейтингу
 * использования (`facetUsage.ts`) — частые слева.
 *
 * Четвёртое (владелец 12.11.2026, после компактной переделки): спойлера «Ещё N» больше нет —
 * показываются ВСЕ ступени сразу. Рейтинг по-прежнему задаёт порядок, но ничего не прячет:
 * панель стала компактной, и стена из двух десятков кнопок больше не пугает.
 *
 * Пятое (владелец 12.11.2026): ширина плашек выбранных значений НЕ влияет на ширину
 * кнопки-родителя. Раньше колонка была `flex column` с `maxWidth`, и длинное название
 * выбранного значения раздвигало соседние кнопки — общий ряд «расползался в ширину».
 * Теперь плашки стоят отдельной строкой под рядом кнопок, и ширину ряда задаёт сама
 * кнопка.
 *
 * Шестое (владелец 12.11.2026): кнопки «Фильтры» больше нет — панель всегда открыта,
 * выпадашка непрозрачная, щелчок по плашке снимает значение.
 *
 * Седьмое (владелец 12.11.2026): плашки разных ступеней больше НЕ наезжают друг на друга.
 * Раньше каждая висела плавающим слоем под своей кнопкой, и широкая плашка наезжала на
 * соседнюю — «прочитать невозможно, что выбрано, и отключить невозможно». Теперь у всех
 * ступеней ОДНА строка плашек под рядом кнопок, и места в ней хватает всем: группа тянется
 * к своей кнопке-родителю, но при нехватке места сдвигается — ровно как дочернее меню в
 * Матрице первой и второй версии.
 */

/**
 * Ячейка ступени: только надпись, поля в пару пикселей, фон — бледный цвет ступени.
 * Рамки нет (владелец 12.11.2026: «рамочка невнятная — надо, чтоб просто фон»).
 */
function facetCellStyle(tone: FacetTone, active: boolean): React.CSSProperties {
  return {
    padding: '2px 4px',
    borderRadius: 4,
    border: 'none',
    background: tone.tint,
    color: 'var(--text)',
    fontWeight: active ? 700 : 400,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    lineHeight: 1.25,
  };
}

/** Плашка выбранного значения: тот же цвет, что у ячейки ступени, и так же компактна. */
function facetChipStyle(tone: FacetTone, maxWidth: number): React.CSSProperties {
  return {
    padding: '1px 4px',
    borderRadius: 3,
    border: 'none',
    background: tone.tint,
    color: 'var(--text)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    fontSize: 12,
    maxWidth,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    lineHeight: 1.25,
  };
}

/**
 * Позиции плашек не изменились — тогда состояние не трогаем. Без этого проверки каждый
 * замер ронял бы новый объект, а React — перерисовывать панель (и замерять снова) по кругу.
 */
function sameChipLayout(prev: Record<string, number>, next: Record<string, number>): boolean {
  const prevKeys = Object.keys(prev);
  if (prevKeys.length !== Object.keys(next).length) return false;
  return prevKeys.every((key) => Math.abs((prev[key] ?? -1) - (next[key] ?? -2)) <= 0.5);
}

export function FacetFilter<Row>(props: {
  facets: readonly FacetDescriptor<Row>[];
  rows: readonly Row[];
  selection: FacetSelection;
  /** Какие ступени ступени были открыты. Хранится снаружи: состояние списка роумится вместе с фильтром. */
  fields: string[];
  /** Ключ списка для рейтинга ступеней (`list:engines`, `report:engines:ui`, …) — своё у каждого ряда. */
  usageKey?: string;
  onChangeSelection: (next: FacetSelection) => void;
  onChangeFields: (next: string[]) => void;
  onReset: () => void;
  // Пропа `open` больше нет (владелец 12.11.2026: «убери кнопку „Фильтры“ отовсюду, пусть
  // панель фильтров будет всегда открыта и активна и видна»): панель не сворачивается, и
  // состояние раскрытости в состоянии списка больше не нужно.
  // Кнопки колонок здесь тоже нет (владелец 16.09.2026): она жила в панели с 08.09, но панель
  // сворачивалась, и «Колонки списка» пропадали вместе с ней. Настройка колонок вернулась
  // в тулбар — постоянно на виду.
}) {
  const activeCount = activeFacetCount(props.facets, props.selection);
  const chosen = new Set(props.fields);

  // Цвет ступени — от её id, а не от места в ряду: фильтр узнаётся по цвету, даже когда
  // рейтинг переставил кнопки.
  const tones = React.useMemo(() => facetTones(props.facets.map((f) => f.id)), [props.facets]);

  // Рейтинг щелчков. Счёт — в ref: он меняет ПОРЯДОК кнопок, а порядок фиксируется на открытии
  // панели. Сдвинь кнопки в момент щелчка — и ряд перетасуется под курсором, оператор щёлкнет
  // не ту ступень (владелец: «при следующем открытии смотрится рейтинг»).
  const usageRef = React.useRef<FacetUsage>(createEmptyFacetUsage());
  const usageKeyRef = React.useRef<string | undefined>(undefined);
  if (usageKeyRef.current !== props.usageKey) {
    usageRef.current = readFacetUsage(props.usageKey);
    usageKeyRef.current = props.usageKey;
  }

  const idsRef = React.useRef<string[]>([]);
  idsRef.current = props.facets.map((f) => f.id);
  const idsSignature = idsRef.current.join('|');

  // Снимок счёта на момент появления панели. По нему считаются и порядок кнопок, и порядок
  // значений в меню: щелчок внутри панели счёт копит, но ряд под курсором не перетасовывается —
  // новый рейтинг оператор увидит, когда панель пересоберётся.
  const [rating, setRating] = React.useState<{ usage: FacetUsage; at: number }>(() => ({
    usage: usageRef.current,
    at: Date.now(),
  }));

  React.useEffect(() => {
    const at = Date.now();
    setRating({ usage: usageRef.current, at });
  }, [idsSignature]);

  /** Щелчок по ступени и по её значению копит счёт: у значения — свой ключ в той же карте. */
  function bumpFacet(facetId: string, value?: string) {
    const now = Date.now();
    usageRef.current = facetUsageBump(usageRef.current, facetId, now);
    if (value !== undefined) {
      usageRef.current = facetUsageBump(usageRef.current, facetValueUsageId(facetId, value), now);
    }
    if (!props.usageKey) return;
    try {
      window.localStorage.setItem(
        FACET_USAGE_STORAGE_PREFIX + props.usageKey,
        JSON.stringify(usageRef.current),
      );
    } catch {
      // Хранилище недоступно — рейтинг просто не переживёт перезапуск; фильтр работает.
    }
  }

  const pickedCount = (id: string): number => {
    const raw = props.selection[id];
    if (Array.isArray(raw)) return raw.length;
    return facetRangeOf(props.selection, id) == null ? 0 : 1;
  };

  // Поиск по значениям ступени (владелец 02.10.2026: 50 заказчиков глазами не
  // найти). Локально в меню, в отбор и роуминг не едет.
  const [valueQuery, setValueQuery] = React.useState<Record<string, string>>({});

  function matchValueOption(option: FacetOption, query: string): boolean {
    if (option.selected) return true;
    const q = normalizeLookupCompact(query);
    if (!q) return true;
    return normalizeLookupCompact(option.label).includes(q);
  }

  // Порядок ступеней в ряду — по рейтингу (частые слева). Спойлера нет: показываются все
  // (владелец 12.11.2026 — панель стала компактной, прятать больше нечего).
  const rankedFields = React.useMemo(
    () => rankByUsage(props.facets, (facet) => facetUsageScore(rating.usage, facet.id, rating.at)),
    [props.facets, rating],
  );

  // Открытое меню: наведение открывает, щелчок «прикалывает» (на планшете наведения нет).
  // Приколотое меню главнее наведённого: пока оно не отпущено, наведение его не вытесняет.
  const [pinned, setPinned] = React.useState<FacetMenu | null>(null);
  const [hovered, setHovered] = React.useState<FacetMenu | null>(null);
  const openMenuTarget = pinned ?? hovered;
  const openFacetId = openMenuTarget?.facetId ?? null;

  // Щелчок мимо меню закрывает его. Внутри меню — не закрывает: иначе нельзя было бы выбрать
  // несколько значений подряд (выбор не закрывает меню, закрывает только щелчок снаружи).
  // Щелчок по ячейке или плашке — тоже не закрывает: их обработчик сам решает, открыть или
  // отпустить, иначе повторный щелчок по ячейке открывал бы меню заново вместо закрытия.
  React.useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('[data-facet-menu]')) return;
      if (target.closest('[data-facet-field]')) return;
      if (target.closest('[data-facet-chip]')) return;
      setPinned(null);
      setHovered(null);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, []);

  /** Наведение открывает меню. Приколотое меню наведением не вытесняется. */
  function openMenu(facetId: string, anchor: 'cell' | string) {
    setHovered((prev) => {
      if (prev && prev.facetId === facetId && prev.anchor === anchor) return prev;
      return { facetId, anchor };
    });
  }

  /** Уход курсора закрывает наведённое меню: приколотое живёт до щелчка. */
  function closeMenuOnLeave() {
    setHovered(null);
  }

  /** Щелчок прикалывает меню (повторный — отпускает). */
  function togglePin(facetId: string, anchor: 'cell' | string) {
    bumpFacet(facetId);
    setPinned((prev) => {
      if (prev && prev.facetId === facetId && prev.anchor === anchor) return null;
      return { facetId, anchor };
    });
  }

  /**
   * Щелчок по плашке выбранного значения — **снимает значение из отбора**
   * (владелец 12.11.2026: «сделай так, чтобы при нажатии на плашку фильтра он активировался и
   * деактивировался… наводишь мышку, хочешь отключить данный фильтр, а он не отключается, а
   * только выпадашка меню выпала и в ней можно только его выбрать и отключить — это лишнее
   * движение»).
   *
   * Раньше щелчок по плашке прикалывал меню, и снять значение можно было только заходом в
   * выпадашку — два лишних движения. Теперь один щелчок по плашке — и значения в отборе нет.
   * **Сама выпадашка не тронута**: по наведению она открывается как прежде.
   */
  function toggleChip(facetId: string, value: string) {
    bumpFacet(facetId, value);
    props.onChangeSelection(toggleFacetValue(props.selection, facetId, value));
    // Меню, привязанное к этой плашке, закрываем: плашка могла исчезнуть, а приколотое меню
    // осталось бы висеть на несуществующем элементе и блокировать меню других ступеней.
    setPinned((prev) => (prev && prev.facetId === facetId && prev.anchor === value ? null : prev));
    setHovered((prev) => (prev && prev.facetId === facetId && prev.anchor === value ? null : prev));
  }

  /**
   * Щелчок по плашке периода — **снимает отбор по датам**. У ступени-диапазона отбор и есть
   * период, поэтому снимается он целиком (значений у такой ступени нет).
   */
  function clearRangeChip(facetId: string) {
    bumpFacet(facetId);
    props.onChangeSelection(clearFacet(props.selection, facetId));
    setPinned((prev) => (prev && prev.facetId === facetId && prev.anchor === 'range' ? null : prev));
    setHovered((prev) => (prev && prev.facetId === facetId && prev.anchor === 'range' ? null : prev));
  }

  /** Сбросить ветку ступени: снимает её значения и убирает ступень из открытых. */
  function resetFacet(facetId: string) {
    props.onChangeSelection(clearFacet(props.selection, facetId));
    if (chosen.has(facetId)) props.onChangeFields(props.fields.filter((x) => x !== facetId));
    setValueQuery((prev) => {
      if (!(facetId in prev)) return prev;
      const next = { ...prev };
      delete next[facetId];
      return next;
    });
  }

  /** Ступень с выбором запоминается открытой — иначе её ячейка уехала бы в спойлер. */
  function rememberField(facetId: string) {
    if (chosen.has(facetId)) return;
    props.onChangeFields([...props.fields, facetId]);
  }

  /** Варианты открытой ступени — по рейтингу: частые выше (рейтинг значений общий со ступенями). */
  const menuOptions = React.useMemo(() => {
    if (!openFacetId) return [] as FacetOption[];
    const facet = props.facets.find((f) => f.id === openFacetId);
    if (!facet || facet.kind !== 'values') return [];
    return facetOptions(props.facets, props.rows, props.selection, openFacetId)
      .map((option, index) => ({
        option,
        index,
        score: facetValueScore(rating.usage, openFacetId, option.value, rating.at),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((x) => x.option);
  }, [openFacetId, props.facets, props.rows, props.selection, rating]);

  /** Выбранные значения ступени — плашки под её ячейкой (владелец 12.11.2026). */
  const selectedOptions = React.useMemo(() => {
    const out = new Map<string, FacetOption[]>();
    for (const facet of props.facets) {
      if (facet.kind !== 'values') continue;
      const raw = props.selection[facet.id];
      if (!Array.isArray(raw) || raw.length === 0) continue;
      const options = facetOptions(props.facets, props.rows, props.selection, facet.id);
      out.set(
        facet.id,
        options.filter((o) => o.selected),
      );
    }
    return out;
  }, [props.facets, props.rows, props.selection]);

  /** Есть ли где-то выбранные значения — от этого зависит, рисовать ли строку плашек. */
  const hasAnyChips = React.useMemo(() => {
    for (const facet of props.facets) {
      if ((selectedOptions.get(facet.id) ?? []).length > 0) return true;
      if (facet.kind === 'dateRange' && facetRangeOf(props.selection, facet.id) != null) return true;
    }
    return false;
  }, [props.facets, props.selection, selectedOptions]);

  /**
   * Раскладка плашек по строке (владелец 12.11.2026).
   *
   * Плашки больше не висят плавающим слоем под своей кнопкой: все ступени делят ОДНУ строку
   * под рядом кнопок, и плашки соседних ступеней наезжали друг на друга. Теперь позиции
   * считаются явно: у каждой группы — своё место в строке, рядом со своей кнопкой, но без
   * наезда (алгоритм — в `utils/facetChipLayout.ts`, это то же поведение, что было у меню
   * Матрицы первой и второй версии: дочернее меню ищет место под родителем и сдвигается,
   * если место занято).
   */
  const chipRowRef = React.useRef<HTMLDivElement | null>(null);
  const parentRefs = React.useRef<Record<string, HTMLElement | null>>({});
  const groupRefs = React.useRef<Record<string, HTMLElement | null>>({});
  const [chipLayout, setChipLayout] = React.useState<Record<string, number>>({});
  /** Ширина плашки: ужимается, если в одну строку иначе не влезает. */
  const [chipMaxWidth, setChipMaxWidth] = React.useState(FACET_CHIP_MAX_WIDTH);

  /** Состав плашек — по нему ширина плашек возвращается к обычной, когда отбор изменился. */
  const chipSignature = React.useMemo(
    () =>
      rankedFields
        .map((facet) => {
          const chips = selectedOptions.get(facet.id) ?? [];
          const range = facet.kind === 'dateRange' && facetRangeOf(props.selection, facet.id) != null ? 1 : 0;
          return `${facet.id}:${chips.length}:${range}`;
        })
        .join('|'),
    [rankedFields, selectedOptions, props.selection],
  );

  React.useEffect(() => {
    setChipMaxWidth(FACET_CHIP_MAX_WIDTH);
  }, [chipSignature]);

  /**
   * Замер и раскладка. Считается после каждой отрисовки: изменились плашки, изменилась
   * ширина панели — плашки встали на новые места.
   */
  const measureChipRow = React.useCallback(() => {
    const chipRow = chipRowRef.current;
    if (!chipRow) return;
    const rowRect = chipRow.getBoundingClientRect();
    const available = rowRect.width;
    const groups: FacetChipGroup[] = [];
    let chipCount = 0;
    for (const facet of rankedFields) {
      const group = groupRefs.current[facet.id];
      const parent = parentRefs.current[facet.id];
      if (!group || !parent) continue;
      const chips = selectedOptions.get(facet.id) ?? [];
      const range = facet.kind === 'dateRange' ? facetRangeOf(props.selection, facet.id) : null;
      if (chips.length === 0 && !range) continue;
      const groupRect = group.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      groups.push({
        id: facet.id,
        width: groupRect.width,
        parentCenter: parentRect.left + parentRect.width / 2 - rowRect.left,
      });
      chipCount += chips.length + (range ? 1 : 0);
    }
    if (groups.length === 0) {
      setChipLayout((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    const plan = layoutFacetChipGroups(groups, available);
    // В одну строку не влезает — ужимаем плашки (снизу ограничителем: подпись должна читаться).
    if (plan.totalWidth > available + 0.5 && chipCount > 0 && chipMaxWidth > FACET_CHIP_MIN_WIDTH) {
      const per = Math.ceil((plan.totalWidth - available) / chipCount);
      const next = Math.max(FACET_CHIP_MIN_WIDTH, chipMaxWidth - per);
      if (next < chipMaxWidth) {
        setChipMaxWidth(next);
        return;
      }
    }
    setChipLayout((prev) => (sameChipLayout(prev, plan.positions) ? prev : plan.positions));
  }, [rankedFields, selectedOptions, props.selection, chipMaxWidth]);

  React.useLayoutEffect(() => {
    measureChipRow();
  }, [measureChipRow]);

  /** Ширина панели меняется — плашки пересчитывают места. */
  React.useEffect(() => {
    const chipRow = chipRowRef.current;
    if (!chipRow || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measureChipRow());
    observer.observe(chipRow);
    return () => observer.disconnect();
  }, [measureChipRow]);

  /**
   * Кнопка «Сбросить фильтры» — первой в ряду (владелец 16.09.2026): выход из фильтра ищут в
   * начале панели, а не в её хвосте, который на узком окне уезжает под перенос ступеней.
   * Снимает ВСЁ (владелец 12.11.2026); сброс одной ступени живёт в её меню.
   */
  function renderResetButton() {
    const idle = activeCount === 0 && props.fields.length === 0;
    return (
      <button
        type="button"
        data-facet-reset
        onClick={props.onReset}
        disabled={idle}
        title="Снять все ступени и вернуть полный список"
        style={{
          padding: '2px 4px',
          borderRadius: 4,
          border: '1px solid var(--border)',
          background: 'var(--surface)',
          color: 'var(--text)',
          cursor: idle ? 'default' : 'pointer',
          whiteSpace: 'nowrap',
          lineHeight: 1.25,
        }}
      >
        Сбросить фильтры{activeCount > 0 ? ` (${activeCount})` : ''}
      </button>
    );
  }

  /** Меню ступени: сброс этой ветки, а дальше — варианты (или поля дат). */
  function renderFacetMenu(facet: FacetDescriptor<Row>, anchor: 'cell' | string) {
    if (!openMenuTarget || openMenuTarget.facetId !== facet.id || openMenuTarget.anchor !== anchor) return null;
    const tone = tones[facet.id] ?? FALLBACK_FACET_TONE;
    const fieldId = facet.id;
    return (
      <div
        data-facet-menu={facet.id}
        style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          zIndex: 60,
          minWidth: 200,
          maxWidth: 320,
          maxHeight: 320,
          overflowY: 'auto',
          padding: 2,
          border: '1px solid var(--border)',
          borderLeft: `3px solid ${tone.accent}`,
          borderRadius: 6,
          // Фон НЕПРОЗРАЧНЫЙ (владелец 12.11.2026: «прозрачность выпадающего меню фильтров
          // убери»): сквозь полупрозрачную выпадашку просвечивал список под ней. Цвет ступени
          // остаётся виден по полосе слева и по цвету выбранного значения.
          background: 'var(--surface)',
          boxShadow: '0 8px 20px rgba(15, 23, 42, 0.18)',
        }}
      >
        <button
          type="button"
          data-facet-menu-reset={facet.id}
          onClick={() => resetFacet(facet.id)}
          title="Снять отбор по этой ступени"
          onMouseEnter={(e) => {
            e.currentTarget.style.background = MENU_HOVER;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            padding: '2px 4px',
            border: 'none',
            borderRadius: 3,
            background: 'transparent',
            color: 'var(--subtle)',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Сбросить фильтр
        </button>
        {renderMenuBody(facet, fieldId)}
      </div>
    );
  }

  /** Тело меню: у ступени-диапазона — поля дат, у ступени-значений — список вариантов. */
  function renderMenuBody(facet: FacetDescriptor<Row>, fieldId: string) {
    if (facet.kind === 'dateRange') {
      return renderDateMenu(facet, fieldId);
    }
    return renderValueMenu(facet, fieldId);
  }

  /** Поля дат ступени-диапазона: вариантов у неё нет — есть две границы. */
  function renderDateMenu(facet: FacetDescriptor<Row>, fieldId: string) {
    const range = facetRangeOf(props.selection, fieldId) ?? {};
    const sameDay = range.from && range.from === range.to ? range.from : '';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '2px 4px' }}>
        <span className="ui-muted">день</span>
        <Input
          type="date"
          data-facet-day={fieldId}
          value={sameDay}
          onChange={(e) => {
            bumpFacet(fieldId);
            props.onChangeSelection(setFacetDay(props.selection, fieldId, e.target.value));
          }}
          title={`${facet.label}: ровно этот день`}
        />
        <span className="ui-muted">или период</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 132 }}>
            <Input
              type="date"
              data-facet-date={`${fieldId}:from`}
              value={range.from ?? ''}
              onChange={(e) => {
                bumpFacet(fieldId);
                props.onChangeSelection(setFacetDateBound(props.selection, fieldId, 'from', e.target.value));
              }}
              title={`${facet.label}: с`}
            />
          </div>
          <span className="ui-muted">—</span>
          <div style={{ width: 132 }}>
            <Input
              type="date"
              data-facet-date={`${fieldId}:to`}
              value={range.to ?? ''}
              onChange={(e) => {
                bumpFacet(fieldId);
                props.onChangeSelection(setFacetDateBound(props.selection, fieldId, 'to', e.target.value));
              }}
              title={`${facet.label}: по`}
            />
          </div>
        </div>
      </div>
    );
  }

  /** Варианты ступени в меню: все, что она предлагает (владелец 12.11.2026). */
  function renderValueMenu(facet: FacetDescriptor<Row>, fieldId: string) {
    const options = menuOptions;
    const query = valueQuery[fieldId] ?? '';
    const shown = options.filter((option) => matchValueOption(option, query));
    const valueButton = (option: FacetOption) => (
      <button
        key={option.value}
        type="button"
        data-facet-value={`${fieldId}:${option.value}`}
        onClick={() => {
          bumpFacet(fieldId, option.value);
          props.onChangeSelection(toggleFacetValue(props.selection, fieldId, option.value));
          rememberField(fieldId);
        }}
        title={option.selected ? 'Убрать значение из отбора' : 'Оставить только это (и другие выбранные)'}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = option.selected ? MENU_SELECTED_HOVER : MENU_HOVER;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = option.selected ? MENU_SELECTED : 'transparent';
        }}
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          padding: '2px 4px',
          border: 'none',
          borderRadius: 3,
          textAlign: 'left',
          background: option.selected ? MENU_SELECTED : 'transparent',
          color: option.selected ? '#ffffff' : 'var(--text)',
          cursor: 'pointer',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {option.label}
        </span>
        <span style={{ color: option.selected ? 'rgba(255, 255, 255, 0.75)' : 'var(--subtle)' }}>
          {option.count}
        </span>
      </button>
    );
    return (
      <>
        {options.length > FACET_VALUE_SEARCH_THRESHOLD ? (
          <div style={{ padding: '2px 4px' }}>
            <Input
              value={query}
              onChange={(e) => setValueQuery((prev) => ({ ...prev, [fieldId]: e.target.value }))}
              placeholder="Найти…"
              title={`Найти значение: ${facet.label}`}
              data-facet-value-search={fieldId}
            />
          </div>
        ) : null}
        {options.length === 0 ? (
          <span className="ui-muted" style={{ padding: '2px 4px' }}>
            нет значений при текущем отборе
          </span>
        ) : shown.length === 0 ? (
          <span className="ui-muted" style={{ padding: '2px 4px' }}>
            по запросу ничего нет
          </span>
        ) : (
          shown.map(valueButton)
        )}
      </>
    );
  }

  /**
   * Ячейка ступени — кнопка-родитель. Плашек выбранных значений здесь нет: они стоят
   * общим рядом ПОД рядом кнопок (см. `renderChipGroup`), чтобы плашки соседних ступеней
   * не наезжали друг на друга.
   */
  function renderFacetColumn(facet: FacetDescriptor<Row>) {
    const tone = tones[facet.id] ?? FALLBACK_FACET_TONE;
    const picked = pickedCount(facet.id);
    return (
      <div
        key={facet.id}
        data-facet-column={facet.id}
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          alignItems: 'flex-start',
        }}
      >
        <div
          ref={(el) => {
            parentRefs.current[facet.id] = el;
          }}
          style={{ position: 'relative' }}
          onMouseEnter={() => openMenu(facet.id, 'cell')}
          onMouseLeave={closeMenuOnLeave}
        >
          <button
            type="button"
            data-facet-field={facet.id}
            onClick={() => togglePin(facet.id, 'cell')}
            title="Показать варианты фильтра"
            {...emojiAttrs(facet.label)}
            style={facetCellStyle(tone, picked > 0)}
          >
            {facet.label}
            {picked > 0 ? ` (${picked})` : ''}
          </button>
          {renderFacetMenu(facet, 'cell')}
        </div>
      </div>
    );
  }

  /**
   * Группа плашек одной ступени: стоит в общем ряду под кнопками, прижата к своей кнопке
   * (насколько позволяет ряд), но ни на что не наезжает.
   */
  function renderChipGroup(facet: FacetDescriptor<Row>) {
    const tone = tones[facet.id] ?? FALLBACK_FACET_TONE;
    const chips = selectedOptions.get(facet.id) ?? [];
    const range = facet.kind === 'dateRange' ? facetRangeOf(props.selection, facet.id) : null;
    if (chips.length === 0 && !range) return null;
    return (
      <div
        key={facet.id}
        ref={(el) => {
          groupRefs.current[facet.id] = el;
        }}
        data-facet-chip-group={facet.id}
        style={{
          position: 'absolute',
          top: 0,
          left: chipLayout[facet.id] ?? 0,
          // Ширина по содержимому: от положения группы в ряду она не зависит, иначе
          // замер ширины ломался бы о собственное смещение.
          width: 'max-content',
          display: 'flex',
          flexWrap: 'nowrap',
          alignItems: 'flex-start',
          gap: 2,
          whiteSpace: 'nowrap',
          zIndex: 5,
        }}
      >
        {chips.map((option) => (
          <div
            key={option.value}
            style={{ position: 'relative' }}
            onMouseEnter={() => openMenu(facet.id, option.value)}
            onMouseLeave={closeMenuOnLeave}
          >
            <button
              type="button"
              data-facet-chip={`${facet.id}:${option.value}`}
              onClick={() => toggleChip(facet.id, option.value)}
              title={`${option.label} — нажмите, чтобы снять значение из отбора`}
              style={facetChipStyle(tone, chipMaxWidth)}
            >
              {option.label}
            </button>
            {renderFacetMenu(facet, option.value)}
          </div>
        ))}
        {range ? (
          <div
            style={{ position: 'relative' }}
            onMouseEnter={() => openMenu(facet.id, 'range')}
            onMouseLeave={closeMenuOnLeave}
          >
            <button
              type="button"
              data-facet-chip={`${facet.id}:range`}
              onClick={() => clearRangeChip(facet.id)}
              title={`${facet.label}: ${range.from ?? '…'} — ${range.to ?? '…'} — нажмите, чтобы снять период`}
              style={facetChipStyle(tone, chipMaxWidth)}
            >
              {range.from && range.from === range.to ? range.from : `${range.from ?? '…'} — ${range.to ?? '…'}`}
            </button>
            {renderFacetMenu(facet, 'range')}
          </div>
        ) : null}
      </div>
    );
  }

  /** Общий ряд плашек под рядом кнопок: одна строка на все ступени, без наездов. */
  function renderChipRow() {
    if (!hasAnyChips) return null;
    return (
      <div
        ref={chipRowRef}
        data-facet-chip-row
        style={{ position: 'relative', height: FACET_CHIP_ROW_HEIGHT }}
      >
        {rankedFields.map(renderChipGroup)}
      </div>
    );
  }

  // Панель всегда на виду (владелец 12.11.2026): кнопки «Фильтры» больше нет, сворачивать
  // нечего — панель стоит под тулбаром всегда.
  return (
    <div
      data-engine-facets
      style={{
        display: 'grid',
        gap: 6,
        padding: 6,
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--surface-2)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4, flexWrap: 'wrap' }}>
        {/* Подписи у ряда нет: кнопка «Фильтры» уже сказала, что это фильтры, а сами кнопки
            названы столбцами (владелец 08.09.2026). «Сбросить фильтры» — ПЕРВОЙ в ряду
            (владелец 16.09.2026): выход из фильтра ищут в начале панели, а не в её хвосте,
            который на узком окне уезжает под перенос ступеней. */}
        {renderResetButton()}
        {/* Спойлера «Ещё N» больше нет (владелец 12.11.2026): после компактной переделки
            панели показывать все ступени сразу — удобно, а ряд остаётся компактным, потому
            что ширину задаёт сама кнопка, а не плашки под ней. Рейтинг по-прежнему задаёт
            порядок — частые слева. */}
        {rankedFields.map(renderFacetColumn)}
      </div>
      {/* Ряд плашек выбранных значений — общий на все ступени, под рядом кнопок. Каждая
          группа тянется к своей кнопке, но ни одна не наезжает на другую (владелец
          12.11.2026: «плавающие плашки наезжают друг на друга — прочитать невозможно,
          что выбрано, и отключить невозможно»). */}
      {renderChipRow()}
    </div>
  );
}
