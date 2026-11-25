import React from 'react';

import { Button } from './Button.js';
import { useFacetPanelState } from '../hooks/facetPanelStore.js';

/**
 * Кнопка «Фильтры» в верхней панели управляющих кнопок (владелец 25.11.2026, промт КАРМАНА #151):
 * нажатие открывает панель фильтров, повторное — сворачивает её.
 *
 * Кнопка ВЕРНУЛАСЬ в тулбар после разворота решения 12.11.2026 («убери кнопку „Фильтры“ отовсюду,
 * пусть панель фильтров будет всегда открыта»). Раньше сворачивание было только кнопкой у самой
 * панели, и открыть панель обратно можно было только ею же — теперь кнопка есть у всех экранов
 * с панелью, в том числе там, где своя панель стоит не под тулбаром.
 *
 * Число активных ступеней — на самой кнопке: свёрнутая панель исчезает с экрана целиком (ни
 * плашек, ни кнопки сброса), и без числа оператор не поймёт, почему список короче.
 */
export function FacetPanelToggle(props: { usageKey?: string }) {
  const { expanded, activeCount, toggle } = useFacetPanelState(props.usageKey);
  return (
    <Button
      type="button"
      variant="outline"
      data-facet-toggle
      aria-expanded={expanded}
      onClick={toggle}
      title={
        expanded
          ? 'Свернуть панель фильтров — освободит место под список'
          : 'Показать панель фильтров'
      }
    >
      Фильтры{activeCount > 0 ? ` (${activeCount})` : ''}
    </Button>
  );
}
