import React from 'react';

import {
  activeFacetCount,
  clearFacet,
  facetOptions,
  facetRangeOf,
  setFacetDateBound,
  toggleFacetValue,
  type FacetDescriptor,
  type FacetSelection,
} from '@matricarmz/shared';

import { Input } from './Input.js';

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
  /**
   * Кнопка выбора колонок списка. Живёт здесь, а не в тулбаре (владелец 08.09.2026): что
   * показывать и по чему отбирать — один и тот же вопрос «как я хочу видеть список», и место
   * у него одно.
   */
  columnsControl?: React.ReactNode;
}) {
  const activeCount = activeFacetCount(props.facets, props.selection);
  const chosen = new Set(props.fields);

  const toggleField = (id: string) => {
    if (chosen.has(id)) {
      props.onChangeFields(props.fields.filter((x) => x !== id));
      // Снятое поле не должно продолжать отбирать втихую.
      props.onChangeSelection(clearFacet(props.selection, id));
    } else {
      props.onChangeFields([...props.fields, id]);
    }
  };

  const pickedCount = (id: string): number => {
    const raw = props.selection[id];
    if (Array.isArray(raw)) return raw.length;
    return facetRangeOf(props.selection, id) == null ? 0 : 1;
  };

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
            названы столбцами (владелец 08.09.2026). */}
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
        <div style={{ flex: 1 }} />
        {props.columnsControl ? <div data-facet-columns>{props.columnsControl}</div> : null}
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
      </div>

      {props.fields.map((fieldId) => {
        const facet = props.facets.find((f) => f.id === fieldId);
        if (!facet) return null;
        if (facet.kind === 'dateRange') {
          const range = facetRangeOf(props.selection, fieldId) ?? {};
          return (
            <div key={fieldId} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ minWidth: 150, color: 'var(--subtle)' }}>
                {facet.label}: {range.from || range.to ? `${range.from || '…'} — ${range.to || '…'}` : 'все'}
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
        const options = facetOptions(props.facets, props.rows, props.selection, fieldId);
        const picked = pickedCount(fieldId);
        return (
          <div key={fieldId} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ minWidth: 150, color: 'var(--subtle)' }}>
              {facet.label}: {picked === 0 ? 'все' : `выбрано ${picked}`}
            </span>
            {options.length === 0 ? (
              <span className="ui-muted">нет значений при текущем отборе</span>
            ) : (
              options.map((option) => (
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
