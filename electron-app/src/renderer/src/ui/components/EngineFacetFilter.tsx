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

import { FacetFilter } from './FacetFilter.js';

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

/**
 * Панель ступеней списка двигателей поверх общего `FacetFilter`. Стоит **под тулбаром** (владелец
 * 25.11.2026: «кнопка „Фильтры“ в верхней панели управляющих кнопок; свёрнутая панель исчезает
 * совсем»).
 *
 * Панель открывается и сворачивается кнопкой «Фильтры» в тулбаре (промт КАРМАНА #151).
 * Раскрытость живёт в общем сторе (`hooks/facetPanelStore.ts`) по `usageKey` — там же, откуда её
 * читает кнопка в тулбаре, поэтому экрану знать о ней не надо и своего состояния он не заводит.
 */
export function EngineFacetFilter(props: {
  engines: readonly EngineListItem[];
  selection: EngineFacetSelection;
  fields: EngineFacetId[];
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
      {...(props.usageKey !== undefined ? { usageKey: props.usageKey } : {})}
      onChangeSelection={(next) => props.onChangeSelection(next as EngineFacetSelection)}
      onChangeFields={(next) => props.onChangeFields(next as EngineFacetId[])}
      onReset={props.onReset}
    />
  );
}
