import React, { useMemo } from 'react';

import {
  engineFacets,
  type EngineFacetId,
  type EngineFacetSelection,
  type EngineFactoryStageTypeRef,
  type EngineListItem,
  type FacetDescriptor,
  type FacetSelection,
  type RepairStageTemplate,
} from '@matricarmz/shared';

import { FacetFilter, FacetToggleButton } from './FacetFilter.js';

/** Ступени со справочниками: ряд этапов полный, а не «что встретилось». */
function useEngineFacetDescriptors(
  types: readonly EngineFactoryStageTypeRef[] | undefined,
  stageTemplates: readonly RepairStageTemplate[] | undefined,
  selection: EngineFacetSelection,
) {
  return useMemo(
    () => engineFacets(types, stageTemplates, selection) as readonly FacetDescriptor<EngineListItem>[],
    [types, stageTemplates, selection],
  );
}

/** Кнопка «Фильтры» списка двигателей — живёт в тулбаре рядом с поиском. */
export function EngineFacetToggleButton(props: {
  selection: EngineFacetSelection;
  open: boolean;
  onToggle: () => void;
  types?: readonly EngineFactoryStageTypeRef[];
  stageTemplates?: readonly RepairStageTemplate[];
}) {
  const facets = useEngineFacetDescriptors(props.types, props.stageTemplates, props.selection);
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
  stageTemplates?: readonly RepairStageTemplate[];
  /** Ступени, спрятанные целиком (нет в ряду кнопок и в панелях): «Дата этапа» при активном «Текущем состоянии». */
  hiddenFields?: readonly EngineFacetId[];
  /** Ключ списка для рейтинга ступеней: ряд кнопок у каждого списка свой. */
  usageKey?: string;
  onChangeSelection: (next: EngineFacetSelection) => void;
  onChangeFields: (next: EngineFacetId[]) => void;
  onReset: () => void;
}) {
  const facets = useEngineFacetDescriptors(props.types, props.stageTemplates, props.selection);
  const visible = React.useMemo(
    () => (props.hiddenFields && props.hiddenFields.length > 0 ? facets.filter((f) => !(props.hiddenFields as readonly string[]).includes(f.id)) : facets),
    [facets, props.hiddenFields],
  );
  return (
    <FacetFilter<EngineListItem>
      facets={visible}
      rows={props.engines}
      selection={props.selection as FacetSelection}
      fields={props.fields}
      open={props.open}
      {...(props.usageKey !== undefined ? { usageKey: props.usageKey } : {})}
      onChangeSelection={(next) => props.onChangeSelection(next as EngineFacetSelection)}
      onChangeFields={(next) => props.onChangeFields(next as EngineFacetId[])}
      onReset={props.onReset}
    />
  );
}
