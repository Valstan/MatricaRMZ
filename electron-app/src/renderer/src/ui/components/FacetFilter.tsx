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

/** Значений больше — в меню ступени появляется поле «Найти…». */
const FACET_VALUE_SEARCH_THRESHOLD = 10;

/**
 * Высота строки плашек под кнопками-родителями. Резервируется у всех колонок, когда
 * выбрано хоть что-то: плашки висят плавающим слоем и не участвуют в потоке по ширине
 * (иначе длинное название выбранного значения раздвигало соседние кнопки — владелец
 * 12.11.2026), но место под них в колонке должно быть — иначе следующий ряд кнопок
 * наполз бы на плашки.
 */
const FACET_CHIP_ROW_HEIGHT = 22;

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
 * Теперь плашки висят отдельным слоем поверх ряда (absolute), прижаты к центру своей
 * кнопки и могут наползать на территорию соседа: место под соседом пустует, но ряд
 * кнопок остаётся компактным.
 *
 * Шестое (владелец 12.11.2026): кнопки «Фильтры» больше нет — панель всегда открыта,
 * выпадашка непрозрачная, щелчок по плашке снимает значение.
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
function facetChipStyle(tone: FacetTone): React.CSSProperties {
  return {
    padding: '1px 4px',
    borderRadius: 3,
    border: 'none',
    background: tone.tint,
    color: 'var(--text)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    maxWidth: 200,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    lineHeight: 1.25,
  };
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

  /** Есть ли где-то выбранные значения — от этого зависит, резервировать ли место под плашки. */
  const hasAnyChips = React.useMemo(() => {
    for (const facet of props.facets) {
      if ((selectedOptions.get(facet.id) ?? []).length > 0) return true;
      if (facet.kind === 'dateRange' && facetRangeOf(props.selection, facet.id) != null) return true;
    }
    return false;
  }, [props.facets, props.selection, selectedOptions]);

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
   * Ячейка ступени и её плашки.
   *
   * Плашка выбранного значения стоит под той ячейкой, из которой значение выбрано
   * (владелец 12.11.2026), и открывает то же меню — так набирают несколько значений,
   * не возвращаясь к ячейке.
   *
   * Но плашки НЕ входят в поток колонки: они висят отдельным слоем (absolute) под
   * ячейкой. Иначе длинное название выбранного значения раздвигало соседние кнопки —
   * общий ряд фильтров «расползался в ширину» (владелец 12.11.2026). Теперь ширину
   * колонки задаёт ТОЛЬКО кнопка, а плашка может наползти на территорию соседа.
   */
  function renderFacetColumn(facet: FacetDescriptor<Row>) {
    const tone = tones[facet.id] ?? FALLBACK_FACET_TONE;
    const picked = pickedCount(facet.id);
    const chips = selectedOptions.get(facet.id) ?? [];
    const range = facet.kind === 'dateRange' ? facetRangeOf(props.selection, facet.id) : null;
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
          // Место под строку плашек резервируется у ВСЕХ колонок, а не только у тех,
          // где что-то выбрано: иначе ряд кнопок переносился бы на разную высоту и
          // плашки первой строки наползали бы на кнопки второй.
          paddingBottom: hasAnyChips ? FACET_CHIP_ROW_HEIGHT : 0,
        }}
      >
        <div
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
          {chips.length > 0 ? (
            <div
              data-facet-chips={facet.id}
              style={{
                // Плавающий слой под кнопкой: он НЕ в потоке колонки, поэтому ширину
                // кнопки-родителя не раздвигает (владелец 12.11.2026: длинное название
                // выбранного значения разводило соседние кнопки, и общий ряд расползался
                // в ширину). Прижат к центру своей кнопки и может наползти на соседа.
                position: 'absolute',
                top: '100%',
                left: '50%',
                transform: 'translateX(-50%)',
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
                    style={facetChipStyle(tone)}
                  >
                    {option.label}
                  </button>
                  {renderFacetMenu(facet, option.value)}
                </div>
              ))}
            </div>
          ) : null}
          {range ? (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 5,
              }}
            >
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
                  style={facetChipStyle(tone)}
                >
                  {range.from && range.from === range.to ? range.from : `${range.from ?? '…'} — ${range.to ?? '…'}`}
                </button>
                {renderFacetMenu(facet, 'range')}
              </div>
            </div>
          ) : null}
        </div>
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
    </div>
  );
}
