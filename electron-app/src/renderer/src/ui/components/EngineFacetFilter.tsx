import React from 'react';

import {
  ENGINE_FACETS,
  type EngineFacetId,
  type EngineFacetSelection,
  type EngineListItem,
  type FacetDescriptor,
  type FacetSelection,
} from '@matricarmz/shared';

import { FacetFilter } from './FacetFilter.js';

/**
 * Ступенчатый фильтр списка двигателей — ступени двигателя поверх общего `FacetFilter`.
 * Всё поведение (сворачивание под кнопку, подсчёт вариантов по остальным ступеням, диапазоны
 * дат) живёт там; здесь только типизация выбора под идентификаторы ступеней двигателя.
 */
export function EngineFacetFilter(props: {
  engines: readonly EngineListItem[];
  selection: EngineFacetSelection;
  fields: EngineFacetId[];
  open: boolean;
  onToggleOpen: () => void;
  onChangeSelection: (next: EngineFacetSelection) => void;
  onChangeFields: (next: EngineFacetId[]) => void;
  onReset: () => void;
}) {
  return (
    <FacetFilter<EngineListItem>
      facets={ENGINE_FACETS as readonly FacetDescriptor<EngineListItem>[]}
      rows={props.engines}
      selection={props.selection as FacetSelection}
      fields={props.fields}
      open={props.open}
      onToggleOpen={props.onToggleOpen}
      onChangeSelection={(next) => props.onChangeSelection(next as EngineFacetSelection)}
      onChangeFields={(next) => props.onChangeFields(next as EngineFacetId[])}
      onReset={props.onReset}
    />
  );
}
