import React from 'react';

import { useListLasso } from '../hooks/useListLasso.js';
import { lassoRectStyle } from '../utils/listLasso.js';

/**
 * Слой выделения контуром (Ctrl + рамка) — общий для всех списков (промт КАРМАНА #67).
 *
 * Список подключает его одним элементом и отдаёт выбор строк; геометрия, рамка и
 * правило «Ctrl+клик по чекбоксу остаётся чекбоксом» живут здесь, а не в каждом списке.
 */
export function ListLassoLayer(props: { enabled: boolean; onSelect: (keys: string[]) => void }) {
  const { lassoRect } = useListLasso({ enabled: props.enabled, onSelect: props.onSelect });
  if (!lassoRect) return null;
  return <div data-list-lasso="true" style={lassoRectStyle(lassoRect)} />;
}
