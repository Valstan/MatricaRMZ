import React, { useMemo } from 'react';

import {
  engineFacets,
  type EngineFacetId,
  type EngineFacetSelection,
  type EngineFactoryStageTypeRef,
  type EngineListItem,
  type FacetDescriptor,
  type FacetSelection,
} from '@matricarmz/shared';

import { FacetFilter, FacetToggleButton } from './FacetFilter.js';

/** Ступени со справочником видов работ: ряд этапов полный, а не «что встретилось». */
function useEngineFacetDescriptors(types: readonly EngineFactoryStageTypeRef[] | undefined) {
  return useMemo(() => engineFacets(types) as readonly FacetDescriptor<EngineListItem>[], [types]);
}

/** Кнопка «Фильтры» списка двигателей — живёт в тулбаре рядом с поиском. */
export function EngineFacetToggleButton(props: {
  selection: EngineFacetSelection;
  open: boolean;
  onToggle: () => void;
  types?: readonly EngineFactoryStageTypeRef[];
}) {
  const facets = useEngineFacetDescriptors(props.types);
  return (
    <FacetToggleButton<EngineListItem>
      facets={facets}
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
  types?: readonly EngineFactoryStageTypeRef[];
  onChangeSelection: (next: EngineFacetSelection) => void;
  onChangeFields: (next: EngineFacetId[]) => void;
  onReset: () => void;
}) {
  const facets = useEngineFacetDescriptors(props.types);
  return (
    <FacetFilter<EngineListItem>
      facets={facets}
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
