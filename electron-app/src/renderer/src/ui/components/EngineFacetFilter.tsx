import React from 'react';

import {
  ENGINE_FACETS,
  activeEngineFacetCount,
  clearEngineFacet,
  engineFacetOptions,
  engineFacetRangeOf,
  setEngineFacetDateBound,
  toggleEngineFacetValue,
  type EngineFacetId,
  type EngineFacetSelection,
  type EngineListItem,
} from '@matricarmz/shared';

import { Input } from './Input.js';

/**
 * Ступенчатый фильтр списка двигателей, спрятанный под кнопку «Фильтры» (просьба владельца
 * 08.09.2026: тулбар оброс кнопками, и все отборы должны жить в одном месте).
 *
 * Первая ступень — какие поля вообще участвуют (заказчик, контракт, марка, стадия, цех, даты…),
 * вторая — значения выбранных полей; пустой выбор значений читается как «все», поэтому
 * состояния «поле выбрано, а список пуст» не существует.
 *
 * Числа рядом со значениями — сколько двигателей останется, и считаются они по строкам,
 * прошедшим ОСТАЛЬНЫЕ ступени. Отсюда два следствия, ради которых всё и затевалось: выбор
 * заказчика сужает марки, а выбор марки — заказчиков, и порядок щелчков ни на что не влияет.
 * Ступени по датам считаются наравне с остальными: цех + диапазон дают «кто был в цехе в эти дни».
 */
export function EngineFacetFilter(props: {
  engines: readonly EngineListItem[];
  selection: EngineFacetSelection;
  /** Какие ступени раскрыты. Хранится снаружи: состояние списка роумится вместе с фильтром. */
  fields: EngineFacetId[];
  /** Раскрыта ли панель целиком. Тоже снаружи — роумится вместе со списком. */
  open: boolean;
  onToggleOpen: () => void;
  onChangeSelection: (next: EngineFacetSelection) => void;
  onChangeFields: (next: EngineFacetId[]) => void;
  onReset: () => void;
}) {
  const activeCount = activeEngineFacetCount(props.selection);
  const chosen = new Set(props.fields);

  const pickedCount = (id: EngineFacetId): number => {
    const raw = props.selection[id];
    if (Array.isArray(raw)) return raw.length;
    const range = engineFacetRangeOf(props.selection, id);
    return range == null ? 0 : 1;
  };

  const toggleField = (id: EngineFacetId) => {
    if (chosen.has(id)) {
      props.onChangeFields(props.fields.filter((x) => x !== id));
      // Снятое поле не должно продолжать отбирать втихую.
      props.onChangeSelection(clearEngineFacet(props.selection, id));
    } else {
      props.onChangeFields([...props.fields, id]);
    }
  };

  // Кнопка живёт и в свёрнутом виде — по числу рядом с ней видно, что список отобран.
  const toggle = (
    <button
      type="button"
      data-facet-toggle
      onClick={props.onToggleOpen}
      title={props.open ? 'Свернуть фильтры' : 'Развернуть фильтры'}
      style={{
        padding: '6px 12px',
        borderRadius: 8,
        border: '1px solid var(--border)',
        background: activeCount > 0 ? 'rgba(37, 99, 235, 0.15)' : 'var(--surface)',
        fontWeight: activeCount > 0 ? 700 : 400,
        cursor: 'pointer',
      }}
    >
      {props.open ? '▾' : '▸'} Фильтры{activeCount > 0 ? ` (${activeCount})` : ''}
    </button>
  );

  if (!props.open) return <div data-engine-facets>{toggle}</div>;

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
        {toggle}
        <span style={{ fontWeight: 700 }}>по столбцам:</span>
        {ENGINE_FACETS.map((facet) => {
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
        const facet = ENGINE_FACETS.find((f) => f.id === fieldId);
        if (!facet) return null;
        if (facet.kind === 'dateRange') {
          const range = engineFacetRangeOf(props.selection, fieldId) ?? {};
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
                  onChange={(e) => props.onChangeSelection(setEngineFacetDateBound(props.selection, fieldId, 'from', e.target.value))}
                  title={`${facet.label}: с`}
                />
              </div>
              <div style={{ width: 170 }}>
                <Input
                  type="date"
                  data-facet-date={`${fieldId}:to`}
                  value={range.to ?? ''}
                  onChange={(e) => props.onChangeSelection(setEngineFacetDateBound(props.selection, fieldId, 'to', e.target.value))}
                  title={`${facet.label}: по`}
                />
              </div>
              <span className="ui-muted">одна дата — ровно этот день</span>
            </div>
          );
        }
        const options = engineFacetOptions(props.engines, props.selection, fieldId);
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
                  onClick={() => props.onChangeSelection(toggleEngineFacetValue(props.selection, fieldId, option.value))}
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
