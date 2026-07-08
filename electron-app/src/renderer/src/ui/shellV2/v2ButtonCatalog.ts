import type { V2ButtonLayout } from '@matricarmz/shared';

import {
  DEFAULT_GROUP_ORDER,
  DEFAULT_GROUP_TABS,
  GROUP_LABELS,
  TAB_VISUALS,
  groupForTab,
  type MenuGroupId,
  type MenuTabId,
  type TabId,
} from '../layout/Tabs.js';

/**
 * V2: какие табы — «списки» (живут во 2-й колонке). Всё остальное (страницы-документы,
 * карточки) рендерится в рабочей области (3-я колонка). Карточные табы (engine, work_order…)
 * в меню не показываются и классификации не требуют.
 */
export const V2_LIST_TABS: ReadonlySet<TabId> = new Set<TabId>([
  'engines',
  'engine_brands',
  'engine_brand_groups',
  'parts',
  'tools',
  'tool_properties',
  'engine_assembly_bom',
  'requests',
  'work_orders',
  'services',
  'nomenclature',
  'products',
  'stock_documents',
  'stock_receipts',
  'stock_issues',
  'stock_transfers',
  'stock_inventory',
  'contracts',
  'counterparties',
  'employees',
  'timesheets',
  'reports',
  'drafts',
]);

export type V2ButtonDescriptor = {
  id: MenuTabId;
  label: string;
  icon: string;
  group: MenuGroupId;
  groupLabel: string;
  isList: boolean;
};

export type V2Buttons = {
  pinned: V2ButtonDescriptor[];
  main: V2ButtonDescriptor[];
  hidden: V2ButtonDescriptor[];
};

function defaultFlatOrder(): MenuTabId[] {
  return DEFAULT_GROUP_ORDER.flatMap((g) => DEFAULT_GROUP_TABS[g]);
}

function toDescriptor(id: MenuTabId, menuLabels: Partial<Record<MenuTabId, string>>): V2ButtonDescriptor {
  const group = groupForTab(id);
  return {
    id,
    label: menuLabels[id] ?? id,
    icon: TAB_VISUALS[id]?.icon ?? '▫️',
    group,
    groupLabel: GROUP_LABELS[group] ?? group,
    isList: V2_LIST_TABS.has(id),
  };
}

/**
 * Собирает кнопки панели: закреплённые сверху (в порядке pinned), затем основной
 * список в пользовательском порядке (неизвестные новые табы — на их дефолтном месте),
 * скрытые — отдельно (для восстановления).
 */
export function buildV2Buttons(
  availableTabs: MenuTabId[],
  menuLabels: Partial<Record<MenuTabId, string>>,
  layout: V2ButtonLayout,
): V2Buttons {
  const available = new Set(availableTabs);
  const hiddenSet = new Set(layout.hidden.filter((id) => available.has(id as MenuTabId)));
  const pinnedIds = layout.pinned.filter((id): id is MenuTabId => available.has(id as MenuTabId) && !hiddenSet.has(id));
  const pinnedSet = new Set(pinnedIds);

  const savedOrder = layout.order.filter((id): id is MenuTabId => available.has(id as MenuTabId));
  const order: MenuTabId[] = [...savedOrder];
  const defaults = defaultFlatOrder().filter((id) => available.has(id));
  for (const id of defaults) {
    if (order.includes(id)) continue;
    // Новый (не сохранённый) таб — вставляем после его дефолтного предшественника.
    const defIdx = defaults.indexOf(id);
    const pred = defIdx > 0 ? defaults[defIdx - 1] : undefined;
    const at = pred ? order.indexOf(pred) : -1;
    if (at >= 0) order.splice(at + 1, 0, id);
    else order.push(id);
  }
  // Доступные табы вне дефолтного каталога (на всякий случай) — в конец.
  for (const id of availableTabs) if (!order.includes(id)) order.push(id);

  return {
    pinned: pinnedIds.map((id) => toDescriptor(id, menuLabels)),
    main: order.filter((id) => !pinnedSet.has(id) && !hiddenSet.has(id)).map((id) => toDescriptor(id, menuLabels)),
    hidden: order.filter((id) => hiddenSet.has(id)).map((id) => toDescriptor(id, menuLabels)),
  };
}
