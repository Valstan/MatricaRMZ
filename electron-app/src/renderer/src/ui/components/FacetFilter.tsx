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
  orderFacetIdsByUsage,
  sanitizeFacetUsage,
  setFacetDateBound,
  setFacetDay,
  splitRatedByUsage,
  toggleFacetValue,
  type FacetDescriptor,
  type FacetOption,
  type FacetSelection,
  type FacetUsage,
} from '@matricarmz/shared';

import { Input } from './Input.js';
import { emojiAttrs } from '../utils/labelEmoji.js';
import { FALLBACK_FACET_TONE, facetTones, type FacetTone } from '../utils/facetTone.js';

/** Значений больше — у ступени появляется поле «Найти…». */
const FACET_VALUE_SEARCH_THRESHOLD = 10;

/** Хранилище рейтинга ступеней: своё у каждого списка (`usageKey`). */
const FACET_USAGE_STORAGE_PREFIX = 'facetUsage:';

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
 * Ступенчатый фильтр списка, спрятанный под кнопку «Фильтры» (просьба владельца 08.09.2026:
 * тулбар оброс кнопками, и все отборы должны жить в одном месте). Общий для двигателей и
 * контрактов — ступени приходят описанием, компонент о предметной области ничего не знает.
 *
 * Первая ступень — какие поля вообще участвуют, вторая — значения выбранных полей; пустой
 * выбор значений читается как «все», поэтому состояния «поле выбрано, а список пуст» нет.
 *
 * Числа рядом со значениями — сколько строк останется, и считаются они по строкам, прошедшим
 * ОСТАЛЬНЫЕ ступени. Отсюда следствие, ради которого всё и затевалось: выбор в одной ступени
 * сужает варианты в других, и порядок щелчков ни на что не влияет.
 *
 * Два свойства для узнаваемости (владелец 25.10.2026, «когда открыто много фильтров — каша»):
 * у каждой ступени свой цвет (`facetTone.ts`), и ряд кнопок отсортирован по рейтингу
 * использования (`facetUsage.ts`) — частые слева.
 *
 * Третье (владелец 26.10.2026): на виду только пять самых рейтинговых ступеней и пять значений
 * внутри ступени, остальное — под спойлером «Ещё N». Иначе открытая панель показывает разом два
 * десятка кнопок и пятьдесят заказчиков: «рябит в глазах». Активная ступень и выбранное значение
 * не прячутся никогда — иначе они отбирали бы втихую.
 */

/**
 * Цветной кружок перед подписью ступени в панели: сам цвет живёт в полосе и подложке, но подпись
 * должна читаться в любой теме, поэтому текст остаётся обычным — цвет несёт кружок.
 */
function FacetToneDot(props: { tone: FacetTone }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: 999,
        marginRight: 6,
        background: props.tone.accent,
        verticalAlign: 'middle',
      }}
    />
  );
}

/**
 * Кнопка «Фильтры» для тулбара — рядом с полем поиска (владелец 08.09.2026: панель не должна
 * занимать полосу, когда она свёрнута). Число активных ступеней видно и в свёрнутом виде:
 * иначе отобранный список неотличим от полного.
 */
export function FacetToggleButton<Row>(props: {
  facets: readonly FacetDescriptor<Row>[];
  selection: FacetSelection;
  open: boolean;
  onToggle: () => void;
}) {
  const activeCount = activeFacetCount(props.facets, props.selection);
  return (
    <button
      type="button"
      data-facet-toggle
      onClick={props.onToggle}
      title={props.open ? 'Свернуть панель фильтров (отбор останется)' : 'Развернуть панель фильтров'}
      style={{
        padding: '6px 12px',
        borderRadius: 8,
        border: '1px solid var(--border)',
        background: activeCount > 0 ? 'rgba(37, 99, 235, 0.15)' : 'var(--surface)',
        fontWeight: activeCount > 0 ? 700 : 400,
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      }}
    >
      {props.open ? '▾' : '▸'} Фильтры{activeCount > 0 ? ` (${activeCount})` : ''}
    </button>
  );
}

export function FacetFilter<Row>(props: {
  facets: readonly FacetDescriptor<Row>[];
  rows: readonly Row[];
  selection: FacetSelection;
  /** Какие ступени раскрыты. Хранится снаружи: состояние списка роумится вместе с фильтром. */
  fields: string[];
  /**
   * Раскрыта ли панель. Состояние снаружи (роумится вместе со списком), а переключает его
   * `FacetToggleButton` из тулбара: свёрнутая панель не должна занимать полосу, но отбор
   * при этом продолжает работать — он живёт в `selection`, а не в раскрытости.
   */
  open: boolean;
  /** Ключ списка для рейтинга ступеней (`list:engines`, `report:engines:ui`, …) — своё у каждого ряда. */
  usageKey?: string;
  onChangeSelection: (next: FacetSelection) => void;
  onChangeFields: (next: string[]) => void;
  onReset: () => void;
  // Кнопки колонок здесь больше нет (владелец 16.09.2026): она жила в панели с 08.09, но
  // панель сворачивается, и «Колонки списка» пропадали вместе с ней. Настройка колонок нужна
  // и при закрытом фильтре, поэтому она вернулась в тулбар — постоянно на виду.
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

  // Снимок счёта на момент открытия панели. По нему считаются и порядок кнопок, и видимая
  // пятёрка значений: щелчок внутри открытой панели счёт копит, но ряд под курсором не
  // перетасовывается — новый рейтинг оператор увидит при следующем открытии.
  const [rating, setRating] = React.useState<{ usage: FacetUsage; at: number }>(() => ({
    usage: usageRef.current,
    at: Date.now(),
  }));

  const [rankedIds, setRankedIds] = React.useState<string[]>(() =>
    orderFacetIdsByUsage(idsRef.current, usageRef.current, Date.now()),
  );
  React.useEffect(() => {
    if (!props.open) return;
    const at = Date.now();
    setRankedIds(orderFacetIdsByUsage(idsRef.current, usageRef.current, at));
    setRating({ usage: usageRef.current, at });
  }, [props.open, idsSignature]);

  const rankIndex = React.useMemo(() => {
    const map = new Map<string, number>();
    rankedIds.forEach((id, index) => map.set(id, index));
    props.facets.forEach((f, index) => {
      if (!map.has(f.id)) map.set(f.id, rankedIds.length + index);
    });
    return map;
  }, [rankedIds, props.facets]);

  // Видимая часть ряда ступеней: пять самых рейтинговых плюс уже открытые (владелец 26.10.2026).
  // Ряд кнопок короче — панель не превращается в стену из двух десятков ступеней.
  const fieldSplit = React.useMemo(
    () =>
      splitRatedByUsage(
        props.facets,
        (facet) => facetUsageScore(rating.usage, facet.id, rating.at),
        (facet) => props.fields.includes(facet.id),
      ),
    [props.facets, rating, props.fields],
  );

  const orderedFields = React.useMemo(
    () =>
      [...props.fields].sort(
        (a, b) =>
          (rankIndex.get(a) ?? Number.MAX_SAFE_INTEGER) - (rankIndex.get(b) ?? Number.MAX_SAFE_INTEGER),
      ),
    [props.fields, rankIndex],
  );

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

  const toggleField = (id: string) => {
    bumpFacet(id);
    if (chosen.has(id)) {
      props.onChangeFields(props.fields.filter((x) => x !== id));
      // Снятое поле не должно продолжать отбирать втихую.
      props.onChangeSelection(clearFacet(props.selection, id));
      setValueQuery((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } else {
      props.onChangeFields([...props.fields, id]);
    }
  };

  const pickedCount = (id: string): number => {
    const raw = props.selection[id];
    if (Array.isArray(raw)) return raw.length;
    return facetRangeOf(props.selection, id) == null ? 0 : 1;
  };

  // Поиск по значениям ступени (владелец 02.10.2026: 50 заказчиков глазами не
  // найти). Локально в панели, в отбор и роуминг не едет. Выбранные значения
  // видны всегда — иначе выбор снимался бы только сбросом всего фильтра.
  const [valueQuery, setValueQuery] = React.useState<Record<string, string>>({});

  function matchValueOption(option: FacetOption, query: string): boolean {
    if (option.selected) return true;
    const q = normalizeLookupCompact(query);
    if (!q) return true;
    return normalizeLookupCompact(option.label).includes(q);
  }

  // Варианты всех раскрытых ступеней — одним мемо: раньше каждая ступень сканировала
  // весь список прямо в рендере, и любой чих родителя (индикатор синка, часы)
  // пересчитывал всё заново. Содержимое то же, платит только смена входа.
  const optionsByField = React.useMemo(() => {
    const out = new Map<string, FacetOption[]>();
    if (!props.open) return out;
    for (const fieldId of props.fields) {
      const facet = props.facets.find((f) => f.id === fieldId);
      if (!facet || facet.kind !== 'values') continue;
      out.set(fieldId, facetOptions(props.facets, props.rows, props.selection, fieldId));
    }
    return out;
  }, [props.open, props.facets, props.rows, props.selection, props.fields]);

  /**
   * Кнопка «Сбросить фильтр» — первой в ряду (владелец 16.09.2026): выход из фильтра ищут в
   * начале панели, а не в её хвосте, который на узком окне уезжает под перенос ступеней.
   */
  function renderResetButton() {
    return (
      <button
        type="button"
        data-facet-reset
        onClick={props.onReset}
        disabled={activeCount === 0 && props.fields.length === 0}
        title="Снять все ступени и вернуть полный список"
        style={{
          padding: '4px 10px',
          borderRadius: 8,
          border: '1px solid var(--border)',
          background: 'var(--surface)',
          cursor: activeCount === 0 && props.fields.length === 0 ? 'default' : 'pointer',
        }}
      >
        Сбросить фильтр{activeCount > 0 ? ` (${activeCount})` : ''}
      </button>
    );
  }

  /** Кнопка ступени: цвет от её id, счёт выбранных значений — в подписи. */
  function renderFieldButton(facet: FacetDescriptor<Row>) {
    const on = chosen.has(facet.id);
    const picked = pickedCount(facet.id);
    const tone = tones[facet.id] ?? FALLBACK_FACET_TONE;
    return (
      <button
        key={facet.id}
        type="button"
        data-facet-field={facet.id}
        onClick={() => toggleField(facet.id)}
        title={on ? 'Убрать ступень из фильтра' : 'Добавить ступень в фильтр'}
        {...emojiAttrs(facet.label)}
        style={{
          padding: '4px 10px',
          borderRadius: 999,
          border: `1px solid ${on ? tone.accent : 'var(--border)'}`,
          // Цветная полоса слева видна и в закрытой ступени: по ней фильтр и узнают.
          borderLeft: `4px solid ${tone.accent}`,
          background: on ? tone.tint : 'var(--surface)',
          fontWeight: on ? 700 : 400,
          cursor: 'pointer',
        }}
      >
        {facet.label}
        {picked > 0 ? ` (${picked})` : ''}
      </button>
    );
  }

  // Свёрнутая панель не занимает НИЧЕГО: кнопка живёт в тулбаре рядом с поиском.
  if (!props.open) return null;

  return (
    <div
      data-engine-facets
      style={{
        display: 'grid',
        gap: 8,
        padding: 10,
        border: '1px solid var(--border)',
        borderRadius: 10,
        background: 'var(--surface-2)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {/* Подписи у ряда нет: кнопка «Фильтры» уже сказала, что это фильтры, а сами кнопки
            названы столбцами (владелец 08.09.2026). «Сбросить фильтр» — ПЕРВОЙ в ряду
            (владелец 16.09.2026): выход из фильтра ищут в начале панели, а не в её хвосте,
            который на узком окне уезжает под перенос ступеней. */}
        {renderResetButton()}
        {fieldSplit.visible.map(renderFieldButton)}
        {fieldSplit.hidden.length > 0 ? (
          <details
            data-facet-more="fields"
            style={{ display: 'inline-block', alignSelf: 'center' }}
          >
            <summary
              title="Остальные ступени: по рейтингу они реже — раскрыть список"
              style={{
                padding: '4px 10px',
                borderRadius: 999,
                border: '1px dashed var(--border)',
                background: 'var(--surface)',
                cursor: 'pointer',
                listStyle: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              Ещё {fieldSplit.hidden.length} ▾
            </summary>
            <div
              data-facet-more-list="fields"
              style={{
                display: 'flex',
                gap: 6,
                flexWrap: 'wrap',
                marginTop: 8,
                padding: 8,
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--surface)',
              }}
            >
              {fieldSplit.hidden.map(renderFieldButton)}
            </div>
          </details>
        ) : null}
      </div>

      {orderedFields.map((fieldId) => {
        const facet = props.facets.find((f) => f.id === fieldId);
        if (!facet) return null;
        const tone = tones[fieldId] ?? FALLBACK_FACET_TONE;
        // Подложка панели — в цвете своей ступени, а кнопки значений остаются обычными:
        // цвет отвечает на вопрос «чей это список», а не «что тут выбрано».
        const panelStyle: React.CSSProperties = {
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
          alignItems: 'center',
          background: tone.panel,
          borderLeft: `3px solid ${tone.accent}`,
          borderRadius: 8,
          padding: '6px 8px',
        };
        if (facet.kind === 'dateRange') {
          const range = facetRangeOf(props.selection, fieldId) ?? {};
          const sameDay = range.from && range.from === range.to ? range.from : '';
          return (
            <div key={fieldId} data-facet-panel={fieldId} style={panelStyle}>
              <span style={{ minWidth: 150, color: 'var(--subtle)' }}>
                <FacetToneDot tone={tone} />
                <span {...emojiAttrs(facet.label)}>{facet.label}</span>: {range.from || range.to ? `${range.from || '…'} — ${range.to || '…'}` : 'все'}
              </span>
              {/* Быстрый выбор одного дня (владелец 19.10.2026): ставит обе границы разом.
                  Вид записи диапазона не меняется — одна дата в нём ничего не значила. */}
              <span className="ui-muted">день</span>
              <div style={{ width: 170 }}>
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
              </div>
              <span className="ui-muted">или период</span>
              <div style={{ width: 170 }}>
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
              <div style={{ width: 170 }}>
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
          );
        }
        const options = optionsByField.get(fieldId) ?? [];
        const picked = pickedCount(fieldId);
        const query = valueQuery[fieldId] ?? '';
        const shown = options.filter((option) => matchValueOption(option, query));
        // Пять самых рейтинговых значений на виду, остальные — под спойлером (владелец
        // 26.10.2026: «чтобы все заказчики не показывались одновременно — рябит в глазах»).
        // Поиск — явный запрос: пока он набран, показываем всё, что совпало. Выбранные
        // значения не прячутся никогда, иначе снять выбор было бы нечем.
        const searching = query.trim().length > 0;
        const valueSplit = searching
          ? { visible: shown, hidden: [] as FacetOption[] }
          : splitRatedByUsage(
              shown,
              (option) => facetValueScore(rating.usage, fieldId, option.value, rating.at),
              (option) => option.selected === true,
            );
        const valueButton = (option: FacetOption) => (
          <button
            key={option.value}
            type="button"
            data-facet-value={`${fieldId}:${option.value}`}
            onClick={() => {
              bumpFacet(fieldId, option.value);
              props.onChangeSelection(toggleFacetValue(props.selection, fieldId, option.value));
            }}
            title={option.selected ? 'Убрать значение из отбора' : 'Оставить только это (и другие выбранные)'}
            style={{
              padding: '3px 8px',
              borderRadius: 999,
              border: '1px solid var(--border)',
              background: option.selected ? tone.tint : 'var(--surface)',
              fontWeight: option.selected ? 700 : 400,
              opacity: option.count === 0 && !option.selected ? 0.5 : 1,
              cursor: 'pointer',
            }}
          >
            {option.label} <span style={{ color: 'var(--subtle)' }}>{option.count}</span>
          </button>
        );
        return (
          <div key={fieldId} data-facet-panel={fieldId} style={panelStyle}>
            <span style={{ minWidth: 150, color: 'var(--subtle)' }}>
              <FacetToneDot tone={tone} />
              <span {...emojiAttrs(facet.label)}>{facet.label}</span>: {picked === 0 ? 'все' : `выбрано ${picked}`}
            </span>
            {options.length > FACET_VALUE_SEARCH_THRESHOLD ? (
              <Input
                value={query}
                onChange={(e) => setValueQuery((prev) => ({ ...prev, [fieldId]: e.target.value }))}
                placeholder="Найти…"
                title={`Найти значение: ${facet.label}`}
                data-facet-value-search={fieldId}
              />
            ) : null}
            {options.length === 0 ? (
              <span className="ui-muted">нет значений при текущем отборе</span>
            ) : shown.length === 0 ? (
              <span className="ui-muted">по запросу ничего нет</span>
            ) : (
              <>
                {valueSplit.visible.map(valueButton)}
                {valueSplit.hidden.length > 0 ? (
                  <details
                    data-facet-more={`values:${fieldId}`}
                    style={{ display: 'inline-block', alignSelf: 'center' }}
                  >
                    <summary
                      title="Остальные значения: по рейтингу они реже — раскрыть список"
                      style={{
                        padding: '3px 8px',
                        borderRadius: 999,
                        border: '1px dashed var(--border)',
                        background: 'var(--surface)',
                        cursor: 'pointer',
                        listStyle: 'none',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Ещё {valueSplit.hidden.length} ▾
                    </summary>
                    <div
                      data-facet-more-list={`values:${fieldId}`}
                      style={{
                        display: 'flex',
                        gap: 6,
                        flexWrap: 'wrap',
                        marginTop: 8,
                        padding: 8,
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        background: 'var(--surface)',
                      }}
                    >
                      {valueSplit.hidden.map(valueButton)}
                    </div>
                  </details>
                ) : null}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
