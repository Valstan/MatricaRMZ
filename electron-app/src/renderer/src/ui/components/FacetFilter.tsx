import React from 'react';

import {
  activeFacetCount,
  clearFacet,
  facetOptions,
  facetRangeOf,
  normalizeLookupCompact,
  setFacetDateBound,
  toggleFacetValue,
  type FacetDescriptor,
  type FacetOption,
  type FacetSelection,
} from '@matricarmz/shared';

import { Input } from './Input.js';
import { emojiAttrs } from '../utils/labelEmoji.js';

/** Значений больше — у ступени появляется поле «Найти…». */
const FACET_VALUE_SEARCH_THRESHOLD = 10;

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
 */

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
  onChangeSelection: (next: FacetSelection) => void;
  onChangeFields: (next: string[]) => void;
  onReset: () => void;
  // Кнопки колонок здесь больше нет (владелец 16.09.2026): она жила в панели с 08.09, но
  // панель сворачивается, и «Колонки списка» пропадали вместе с ней. Настройка колонок нужна
  // и при закрытом фильтре, поэтому она вернулась в тулбар — постоянно на виду.
}) {
  const activeCount = activeFacetCount(props.facets, props.selection);
  const chosen = new Set(props.fields);

  const toggleField = (id: string) => {
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
        {props.facets.map((facet) => {
          const on = chosen.has(facet.id);
          const picked = pickedCount(facet.id);
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
                border: '1px solid var(--border)',
                background: on ? 'rgba(37, 99, 235, 0.15)' : 'var(--surface)',
                fontWeight: on ? 700 : 400,
                cursor: 'pointer',
              }}
            >
              {facet.label}
              {picked > 0 ? ` (${picked})` : ''}
            </button>
          );
        })}
      </div>

      {props.fields.map((fieldId) => {
        const facet = props.facets.find((f) => f.id === fieldId);
        if (!facet) return null;
        if (facet.kind === 'dateRange') {
          const range = facetRangeOf(props.selection, fieldId) ?? {};
          return (
            <div key={fieldId} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ minWidth: 150, color: 'var(--subtle)' }}>
                <span {...emojiAttrs(facet.label)}>{facet.label}</span>: {range.from || range.to ? `${range.from || '…'} — ${range.to || '…'}` : 'все'}
              </span>
              <div style={{ width: 170 }}>
                <Input
                  type="date"
                  data-facet-date={`${fieldId}:from`}
                  value={range.from ?? ''}
                  onChange={(e) => props.onChangeSelection(setFacetDateBound(props.selection, fieldId, 'from', e.target.value))}
                  title={`${facet.label}: с`}
                />
              </div>
              <div style={{ width: 170 }}>
                <Input
                  type="date"
                  data-facet-date={`${fieldId}:to`}
                  value={range.to ?? ''}
                  onChange={(e) => props.onChangeSelection(setFacetDateBound(props.selection, fieldId, 'to', e.target.value))}
                  title={`${facet.label}: по`}
                />
              </div>
              <span className="ui-muted">одна дата — ровно этот день</span>
            </div>
          );
        }
        const options = optionsByField.get(fieldId) ?? [];
        const picked = pickedCount(fieldId);
        const query = valueQuery[fieldId] ?? '';
        const shown = options.filter((option) => matchValueOption(option, query));
        return (
          <div key={fieldId} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ minWidth: 150, color: 'var(--subtle)' }}>
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
              shown.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  data-facet-value={`${fieldId}:${option.value}`}
                  onClick={() => props.onChangeSelection(toggleFacetValue(props.selection, fieldId, option.value))}
                  title={option.selected ? 'Убрать значение из отбора' : 'Оставить только это (и другие выбранные)'}
                  style={{
                    padding: '3px 8px',
                    borderRadius: 999,
                    border: '1px solid var(--border)',
                    background: option.selected ? 'rgba(37, 99, 235, 0.15)' : 'var(--surface)',
                    fontWeight: option.selected ? 700 : 400,
                    opacity: option.count === 0 && !option.selected ? 0.5 : 1,
                    cursor: 'pointer',
                  }}
                >
                  {option.label} <span style={{ color: 'var(--subtle)' }}>{option.count}</span>
                </button>
              ))
            )}
          </div>
        );
      })}
    </div>
  );
}
