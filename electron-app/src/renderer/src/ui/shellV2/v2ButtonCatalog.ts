import type { V2ButtonLayout } from '@matricarmz/shared';

import {
  DEFAULT_GROUP_ORDER,
  DEFAULT_GROUP_TABS,
  GROUP_LABELS,
  TAB_VISUALS,
  TABLET_OPERATOR_TABS,
  groupForTab,
  type MenuTabId,
  type TabId,
} from '../layout/Tabs.js';
import { type ActionButtonDescriptor, type ActionButtonId, ACTION_BUTTONS, ACTION_GROUP_LABELS, ACTION_GROUP_ORDER } from './menuActions.js';
import { isAndroidPlatform } from '../platform.js';

// На Android-планшете чат-каналы моста не зарегистрированы — кнопки без функции прячем,
// иначе «Чат» даёт пустой экран, а «Ссылка в чат» — мягкий отказ.
const ANDROID_HIDDEN_ACTIONS: ReadonlySet<ActionButtonId> = new Set<ActionButtonId>([
  'chat',
  'ai_chat',
  'chat_link',
  'program_feedback',
  // «Рабочий стол» живёт на экране чата — на Android чата нет, ярлык добавлять некуда.
  'desktop_shortcut',
]);

function actionVisibleOnPlatform(id: ActionButtonId): boolean {
  return !isAndroidPlatform() || !ANDROID_HIDDEN_ACTIONS.has(id);
}

export const V2_LIST_TABS: ReadonlySet<TabId> = new Set<TabId>([
  'engines',
  'engine_brands',
  'engine_brand_groups',
  'parts',
  'tools',
  'tool_properties',
  'engine_assembly_bom',
  'repair_norms',
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
  'user_screens',
]);

export type MenuButtonKind = 'nav' | 'action';

export type MenuButtonDescriptor = {
  id: string;
  label: string;
  icon: string;
  group: string;
  groupLabel: string;
  kind: MenuButtonKind;
  isList?: boolean;
};

export type MenuSection = {
  id: string;
  label: string;
  icon: string;
  items: MenuButtonDescriptor[];
};

export type V2Buttons = {
  pinned: MenuButtonDescriptor[];
  sections: MenuSection[];
  hidden: MenuButtonDescriptor[];
};

function defaultFlatOrder(): MenuTabId[] {
  return DEFAULT_GROUP_ORDER.flatMap((g) => DEFAULT_GROUP_TABS[g]);
}

function toDescriptor(id: MenuTabId, menuLabels: Partial<Record<MenuTabId, string>>): MenuButtonDescriptor {
  const group = groupForTab(id);
  return {
    id,
    label: menuLabels[id] ?? id,
    icon: TAB_VISUALS[id]?.icon ?? '▫️',
    group,
    groupLabel: GROUP_LABELS[group] ?? group,
    kind: 'nav',
    isList: V2_LIST_TABS.has(id),
  };
}

function toActionDescriptor(a: ActionButtonDescriptor): MenuButtonDescriptor {
  return {
    id: a.id,
    label: a.label,
    icon: a.icon,
    group: a.group,
    groupLabel: ACTION_GROUP_LABELS[a.group] ?? a.group,
    kind: 'action',
  };
}

function sectionId(group: string): string {
  return `group:${group}`;
}

/**
 * Собирает кнопки панели в секции: закреплённые сверху (в порядке pinned — это копии,
 * оригиналы остаются в своих секциях), затем секции по группам с возможностью сворачивания.
 */
export function buildV2Buttons(
  availableTabs: MenuTabId[],
  menuLabels: Partial<Record<MenuTabId, string>>,
  layout: V2ButtonLayout,
  tabletOperatorMenu = false,
): V2Buttons {
  const visibleTabs = tabletOperatorMenu
    ? availableTabs.filter((id) => TABLET_OPERATOR_TABS.includes(id))
    : availableTabs;
  const available = new Set(visibleTabs);
  const hiddenSet = new Set(layout.hidden.filter((id) => available.has(id as MenuTabId)));
  const pinnedIds = layout.pinned.filter((id): id is MenuTabId => available.has(id as MenuTabId) && !hiddenSet.has(id));

  const savedOrder = layout.order.filter((id): id is MenuTabId => available.has(id as MenuTabId));
  const order: MenuTabId[] = [...savedOrder];
  const defaults = defaultFlatOrder().filter((id) => available.has(id));
  for (const id of defaults) {
    if (order.includes(id)) continue;
    const defIdx = defaults.indexOf(id);
    const pred = defIdx > 0 ? defaults[defIdx - 1] : undefined;
    const at = pred ? order.indexOf(pred) : -1;
    if (at >= 0) order.splice(at + 1, 0, id);
    else order.push(id);
  }
  for (const id of visibleTabs) if (!order.includes(id)) order.push(id);

  const mainIds = order.filter((id) => !hiddenSet.has(id));
  const allNav = mainIds.map((id) => toDescriptor(id, menuLabels));

  const allActions = ACTION_BUTTONS.filter((a) => actionVisibleOnPlatform(a.id)).map(toActionDescriptor);

  const pinnedDescs = pinnedIds.map((id) => toDescriptor(id, menuLabels));
  const pinnedActionIds = layout.pinned.filter((id) => !available.has(id as MenuTabId));
  for (const aid of pinnedActionIds) {
    const ad = ACTION_BUTTONS.find((a) => a.id === aid);
    if (ad && !hiddenSet.has(aid as any) && actionVisibleOnPlatform(ad.id)) pinnedDescs.push(toActionDescriptor(ad));
  }

  const navGroups = new Map<string, MenuButtonDescriptor[]>();
  for (const btn of allNav) {
    const list = navGroups.get(btn.group) ?? [];
    list.push(btn);
    navGroups.set(btn.group, list);
  }

  const sections: MenuSection[] = [];

  for (const gid of DEFAULT_GROUP_ORDER) {
    const items = navGroups.get(gid);
    if (!items || items.length === 0) continue;
    sections.push({
      id: sectionId(gid),
      label: GROUP_LABELS[gid] ?? gid,
      icon: '',
      items,
    });
  }

  const actionGroups = new Map<string, MenuButtonDescriptor[]>();
  for (const btn of allActions) {
    const list = actionGroups.get(btn.group) ?? [];
    list.push(btn);
    actionGroups.set(btn.group, list);
  }

  for (const gid of ACTION_GROUP_ORDER) {
    const items = actionGroups.get(gid);
    if (!items || items.length === 0) continue;
    sections.push({
      id: sectionId(gid),
      label: ACTION_GROUP_LABELS[gid] ?? gid,
      icon: '',
      items,
    });
  }

  return {
    pinned: pinnedDescs,
    sections,
    hidden: order.filter((id) => hiddenSet.has(id)).map((id) => toDescriptor(id, menuLabels)),
  };
}
