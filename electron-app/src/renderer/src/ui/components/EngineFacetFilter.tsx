import React from 'react';

import {
  ENGINE_FACETS,
  type EngineFacetId,
  type EngineFacetSelection,
  type EngineListItem,
  type FacetDescriptor,
  type FacetSelection,
} from '@matricarmz/shared';

import { FacetFilter, FacetToggleButton } from './FacetFilter.js';

const ENGINE_FACET_DESCRIPTORS = ENGINE_FACETS as readonly FacetDescriptor<EngineListItem>[];

/** Кнопка «Фильтры» списка двигателей — живёт в тулбаре рядом с поиском. */
export function EngineFacetToggleButton(props: {
  selection: EngineFacetSelection;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <FacetToggleButton<EngineListItem>
      facets={ENGINE_FACET_DESCRIPTORS}
      selection={props.selection as FacetSelection}
      open={props.open}
      onToggle={props.onToggle}
    />
  );
}

/**
 * Панель ступеней списка двигателей поверх общего `FacetFilter`. Разворачивается ПОД тулбаром
 * по кнопке `EngineFacetToggleButton`; свёрнутая не занимает места, а отбор продолжает работать.
 */
export function EngineFacetFilter(props: {
  engines: readonly EngineListItem[];
  selection: EngineFacetSelection;
  fields: EngineFacetId[];
  open: boolean;
  onChangeSelection: (next: EngineFacetSelection) => void;
  onChangeFields: (next: EngineFacetId[]) => void;
  onReset: () => void;
}) {
  return (
    <FacetFilter<EngineListItem>
      facets={ENGINE_FACET_DESCRIPTORS}
      rows={props.engines}
      selection={props.selection as FacetSelection}
      fields={props.fields}
      open={props.open}
      onChangeSelection={(next) => props.onChangeSelection(next as EngineFacetSelection)}
      onChangeFields={(next) => props.onChangeFields(next as EngineFacetId[])}
      onReset={props.onReset}
    />
  );
}
