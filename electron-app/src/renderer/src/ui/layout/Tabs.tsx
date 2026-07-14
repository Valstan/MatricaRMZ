import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { UiDisplayPrefs } from '@matricarmz/shared';
import { DEFAULT_UI_DISPLAY_PREFS } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { theme } from '../theme.js';

export type TabId =
  | 'history'
  | 'engines'
  | 'assembly_forecast'
  | 'engine'
  | 'engine_brands'
  | 'engine_brand'
  | 'engine_brand_groups'
  | 'engine_brand_group'
  | 'counterparties'
  | 'counterparty'
  | 'products'
  | 'product'
  | 'services'
  | 'services_by_brand'
  | 'service'
  | 'nomenclature'
  | 'nomenclature_item'
  | 'parts_dedupe'
  | 'empty_cards'
  | 'drafts'
  | 'stock_balances'
  | 'stock_receipts'
  | 'stock_issues'
  | 'stock_transfers'
  | 'stock_documents'
  | 'stock_document'
  | 'stock_inventory'
  | 'repair_fund_audit'
  | 'warehouse_analytics'
  | 'workshop_stats'
  | 'engine_assembly_bom'
  | 'engine_assembly_bom_item'
  | 'contracts'
  | 'contract'
  | 'requests'
  | 'request'
  | 'work_orders'
  | 'work_order'
  | 'work_order_templates'
  | 'parts'
  | 'part'
  | 'tools'
  | 'tool_accounting'
  | 'tool'
  | 'tool_properties'
  | 'tool_property'
  | 'employees'
  | 'employee'
  | 'access_sections'
  | 'timesheets'
  | 'timesheet'
  | 'changes'
  | 'auth'
  | 'reports'
  | 'report_preset'
  | 'masterdata'
  | 'workshops'
  | 'warehouses_admin'
  | 'warehouse_locations'
  | 'admin'
  | 'audit'
  | 'notes'
  | 'settings'
  | 'user_screens'
  | 'user_screen';

export type MenuTabId = Exclude<
  TabId,
  | 'engine'
  | 'request'
  | 'work_order'
  | 'part'
  | 'employee'
  | 'contract'
  | 'engine_brand'
  | 'engine_brand_group'
  | 'product'
  | 'service'
  | 'nomenclature_item'
  | 'stock_document'
  | 'counterparty'
  | 'tool'
  | 'tool_property'
  | 'tool_properties'
  | 'report_preset'
  | 'engine_assembly_bom_item'
  | 'timesheet'
  | 'user_screen'
>;
export type TabsLayoutPrefs = {
  order?: MenuTabId[];
  hidden?: MenuTabId[];
  trashIndex?: number | null;
  groupOrder?: MenuGroupId[];
  hiddenGroups?: MenuGroupId[];
  collapsedGroups?: MenuGroupId[];
  activeGroup?: MenuGroupId | null;
};

/** Maps detail tabs to their parent menu tab so the correct section button stays highlighted. */
const PARENT_TAB: Record<string, MenuTabId> = {
  engine: 'engines',
  engine_brand: 'engine_brands',
  engine_brand_group: 'engine_brand_groups',
  work_order: 'work_orders',
  part: 'parts',
  tool: 'tools',
  tool_property: 'tools',
  tool_properties: 'tools',
  employee: 'employees',
  contract: 'contracts',
  counterparty: 'counterparties',
  product: 'nomenclature',
  service: 'nomenclature',
  nomenclature_item: 'nomenclature',
  stock_document: 'stock_documents',
  engine_assembly_bom_item: 'engine_assembly_bom',
  request: 'requests',
  report_preset: 'reports',
  timesheet: 'timesheets',
  user_screen: 'user_screens',
};

// Pre-computed set for O(1) lookup
const menuTabSet = new Set<MenuTabId>([
  'history',
  'masterdata',
  'contracts',
  'changes',
  'engines',
  'assembly_forecast',
  'engine_brands',
  'engine_brand_groups',
  'counterparties',
  'requests',
  'work_orders',
  'work_order_templates',
  'parts',
  'tools',
  'tool_accounting',
  'products',
  'services',
  'services_by_brand',
  'nomenclature',
  'parts_dedupe',
  'stock_balances',
  'stock_documents',
  'stock_receipts',
  'stock_issues',
  'stock_transfers',
  'stock_inventory',
  'repair_fund_audit',
  'warehouse_analytics',
  'workshop_stats',
  'engine_assembly_bom',
  'employees',
  'timesheets',
  'access_sections',
  'reports',
  'audit',
  'admin',
  'auth',
  'notes',
  'settings',
  'workshops',
  'warehouses_admin',
  'warehouse_locations',
  'user_screens',
]);

export function resolveMenuTab(tab: string): MenuTabId | null {
  const parent = PARENT_TAB[tab];
  if (parent) return parent;
  return menuTabSet.has(tab as MenuTabId) ? (tab as MenuTabId) : null;
}

type ContextTarget =
  | { kind: 'tab'; id: MenuTabId }
  | { kind: 'group'; id: MenuGroupId };
export type MenuGroupId =
  | 'history'
  | 'production'
  | 'supply'
  | 'warehouse'
  | 'business'
  | 'people'
  | 'control';

export const GROUP_LABELS: Record<MenuGroupId, string> = {
  history: 'Мой круг',
  production: 'Производство',
  supply: 'Снабжение',
  warehouse: 'Склад',
  business: 'Договоры и контрагенты',
  people: 'Персонал и доступ',
  control: 'Контроль и аналитика',
};

export const DEFAULT_GROUP_ORDER: MenuGroupId[] = ['history', 'production', 'supply', 'warehouse', 'business', 'people', 'control'];
export const DEFAULT_GROUP_TABS: Record<MenuGroupId, MenuTabId[]> = {
  history: ['history', 'user_screens'],
  production: ['engines', 'assembly_forecast', 'engine_brands', 'engine_brand_groups', 'parts', 'engine_assembly_bom', 'tools'],
  supply: ['requests', 'work_orders', 'work_order_templates', 'services', 'services_by_brand', 'tool_accounting'],
  warehouse: ['nomenclature', 'parts_dedupe', 'stock_balances', 'warehouse_locations', 'stock_documents', 'stock_receipts', 'stock_issues', 'stock_transfers', 'stock_inventory', 'repair_fund_audit', 'warehouse_analytics'],
  business: ['contracts', 'counterparties'],
  people: ['employees', 'timesheets', 'access_sections'],
  control: ['reports', 'changes', 'audit', 'notes', 'masterdata', 'workshops', 'workshop_stats', 'warehouses_admin', 'empty_cards', 'drafts', 'admin'],
};

type GroupVisualMeta = { icon: string; subtitle: string; gradient: string };
const GROUP_VISUALS: Record<MenuGroupId, GroupVisualMeta> = {
  history: {
    icon: '🎯',
    subtitle: '',
    gradient: 'linear-gradient(135deg, #1d4ed8 0%, #0ea5e9 100%)',
  },
  production: {
    icon: '⚙️',
    subtitle: 'Двигатели, марки, детали и BOM',
    gradient: 'linear-gradient(135deg, #0f766e 0%, #10b981 100%)',
  },
  supply: {
    icon: '📦',
    subtitle: 'Заявки, наряды и снабжение',
    gradient: 'linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)',
  },
  warehouse: {
    icon: '🏭',
    subtitle: 'Остатки, документы и инвентаризация',
    gradient: 'linear-gradient(135deg, #0369a1 0%, #0ea5e9 100%)',
  },
  business: {
    icon: '🤝',
    subtitle: 'Контракты и контрагенты',
    gradient: 'linear-gradient(135deg, #be185d 0%, #ec4899 100%)',
  },
  people: {
    icon: '👥',
    subtitle: 'Сотрудники и роли доступа',
    gradient: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)',
  },
  control: {
    icon: '📊',
    subtitle: 'Отчеты, аудит, заметки и справочники',
    gradient: 'linear-gradient(135deg, #c2410c 0%, #f97316 100%)',
  },
};

type TabVisualMeta = { icon: string; subtitle: string; gradient: string };
export const TAB_VISUALS: Partial<Record<MenuTabId, TabVisualMeta>> = {
  history: { icon: '🎯', subtitle: '', gradient: 'linear-gradient(135deg, #1d4ed8 0%, #0ea5e9 100%)' },
  engines: { icon: '⚙️', subtitle: 'Список и карточки двигателей', gradient: 'linear-gradient(135deg, #1d4ed8 0%, #0ea5e9 100%)' },
  assembly_forecast: { icon: '🔮', subtitle: 'Прогноз сборки двигателей', gradient: 'linear-gradient(135deg, #4338ca 0%, #6366f1 100%)' },
  engine_brands: { icon: '🏷️', subtitle: 'Марки двигателей и нормы', gradient: 'linear-gradient(135deg, #2563eb 0%, #60a5fa 100%)' },
  engine_brand_groups: { icon: '🗂️', subtitle: 'Группы марок для привязки деталей', gradient: 'linear-gradient(135deg, #1d4ed8 0%, #38bdf8 100%)' },
  parts: { icon: '🧩', subtitle: 'Справочник деталей и узлов', gradient: 'linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)' },
  requests: { icon: '📦', subtitle: 'Закупка и потребности', gradient: 'linear-gradient(135deg, #0f766e 0%, #10b981 100%)' },
  work_orders: { icon: '🛠️', subtitle: 'Работы и производство', gradient: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)' },
  work_order_templates: { icon: '📋', subtitle: 'Шаблоны нарядов по типу', gradient: 'linear-gradient(135deg, #0d9488 0%, #2dd4bf 100%)' },
  tools: { icon: '🔧', subtitle: 'Справочник инструментов (номенклатура)', gradient: 'linear-gradient(135deg, #059669 0%, #22c55e 100%)' },
  tool_accounting: { icon: '📋', subtitle: 'Выдачи и возвраты по сотрудникам', gradient: 'linear-gradient(135deg, #047857 0%, #34d399 100%)' },
  products: { icon: '📦', subtitle: 'Товары и номенклатура', gradient: 'linear-gradient(135deg, #0891b2 0%, #06b6d4 100%)' },
  services: { icon: '🧰', subtitle: 'Услуги и операции', gradient: 'linear-gradient(135deg, #0284c7 0%, #38bdf8 100%)' },
  services_by_brand: { icon: '🧩', subtitle: 'Спецификация услуг по марке двигателя', gradient: 'linear-gradient(135deg, #0369a1 0%, #0ea5e9 100%)' },
  nomenclature: { icon: '🗃️', subtitle: 'Единый каталог ТМЦ', gradient: 'linear-gradient(135deg, #0369a1 0%, #0ea5e9 100%)' },
  engine_assembly_bom: { icon: '🧮', subtitle: 'Матрица комплектования двигателей', gradient: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)' },
  stock_balances: { icon: '📊', subtitle: 'Остатки по складам', gradient: 'linear-gradient(135deg, #0284c7 0%, #38bdf8 100%)' },
  stock_documents: { icon: '📄', subtitle: 'Все типы складских документов', gradient: 'linear-gradient(135deg, #0369a1 0%, #22d3ee 100%)' },
  stock_receipts: { icon: '📥', subtitle: 'Документы поступления', gradient: 'linear-gradient(135deg, #0ea5e9 0%, #22d3ee 100%)' },
  stock_issues: { icon: '📤', subtitle: 'Документы расхода', gradient: 'linear-gradient(135deg, #0891b2 0%, #06b6d4 100%)' },
  stock_transfers: { icon: '🔄', subtitle: 'Перемещения и списание', gradient: 'linear-gradient(135deg, #0c4a6e 0%, #0284c7 100%)' },
  stock_inventory: { icon: '📋', subtitle: 'Инвентаризация склада', gradient: 'linear-gradient(135deg, #075985 0%, #0284c7 100%)' },
  repair_fund_audit: { icon: '🛠️', subtitle: 'Детали, ожидающие ремонта', gradient: 'linear-gradient(135deg, #b45309 0%, #f59e0b 100%)' },
  warehouse_analytics: { icon: '📈', subtitle: 'Выпуск двигателей по маркам', gradient: 'linear-gradient(135deg, #0d9488 0%, #2dd4bf 100%)' },
  workshop_stats: { icon: '📊', subtitle: 'Труд и прохождение двигателей по цехам', gradient: 'linear-gradient(135deg, #4338ca 0%, #6366f1 100%)' },
  contracts: { icon: '📄', subtitle: 'Договоры и условия', gradient: 'linear-gradient(135deg, #7c3aed 0%, #c084fc 100%)' },
  counterparties: { icon: '🤝', subtitle: 'Поставщики и партнеры', gradient: 'linear-gradient(135deg, #9333ea 0%, #ec4899 100%)' },
  employees: { icon: '👥', subtitle: 'Сотрудники и профили', gradient: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)' },
  timesheets: { icon: '🗓️', subtitle: 'Табель учёта рабочего времени (Т-13)', gradient: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)' },
  access_sections: { icon: '🔐', subtitle: 'Кто видит и правит каждый раздел', gradient: 'linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)' },
  reports: { icon: '📊', subtitle: 'Аналитика и выгрузки', gradient: 'linear-gradient(135deg, #be185d 0%, #ec4899 100%)' },
  changes: { icon: '🧾', subtitle: 'История изменений данных', gradient: 'linear-gradient(135deg, #6b7280 0%, #94a3b8 100%)' },
  drafts: { icon: '🗂️', subtitle: 'Несохранённые черновики карточек', gradient: 'linear-gradient(135deg, #7c3aed 0%, #a78bfa 100%)' },
  audit: { icon: '🔍', subtitle: 'Журнал аудита действий', gradient: 'linear-gradient(135deg, #374151 0%, #6b7280 100%)' },
  notes: { icon: '📝', subtitle: 'Личные и общие записи', gradient: 'linear-gradient(135deg, #c2410c 0%, #f97316 100%)' },
  masterdata: { icon: '🗂️', subtitle: 'Общие справочники системы', gradient: 'linear-gradient(135deg, #0f766e 0%, #10b981 100%)' },
  admin: { icon: '🛡️', subtitle: 'Админ. раздел и полномочия', gradient: 'linear-gradient(135deg, #4b5563 0%, #9ca3af 100%)' },
  auth: { icon: '🔐', subtitle: 'Вход и авторизация', gradient: 'linear-gradient(135deg, #334155 0%, #64748b 100%)' },
  settings: { icon: '⚙️', subtitle: 'Параметры программы', gradient: 'linear-gradient(135deg, #475569 0%, #94a3b8 100%)' },
  user_screens: { icon: '🧱', subtitle: 'Экраны, собранные операторами', gradient: 'linear-gradient(135deg, #1d4ed8 0%, #7c3aed 100%)' },
};

function clamp(n: number, min: number, max: number) {
  if (Number.isNaN(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function getDepartmentButtonStyle(style: { fontSize: number; paddingX: number; gap: number }) {
  const fontSize = Number(style?.fontSize ?? 0);
  const paddedX = Number(style?.paddingX ?? 0);
  const styleGap = Number(style?.gap ?? 0);
  return {
    iconSize: clamp(Math.round(clamp(fontSize, 18, 32) * 0.72), 18, 30),
    titleSize: clamp(Math.round(clamp(fontSize, 14, 32) * 0.58), 14, 20),
    subtitleSize: clamp(Math.round(clamp(fontSize, 12, 30) * 0.46), 11, 14),
    rightPadding: Math.max(2, Math.round(clamp(paddedX, 2, 80))),
    stackGap: Math.max(2, Math.round(clamp(styleGap, 2, 24))),
  };
}

// For a tab not yet in a saved layout, its intended neighbour: the tab right before
// it in DEFAULT_GROUP_TABS. Lets new tabs land at their designed position (next to
// their sibling) instead of being dumped at the end of an existing saved order.
function defaultPredecessor(tab: MenuTabId): MenuTabId | null {
  for (const g of DEFAULT_GROUP_ORDER) {
    const list = DEFAULT_GROUP_TABS[g];
    const i = list.indexOf(tab);
    if (i > 0) return list[i - 1] ?? null;
    if (i === 0) return null;
  }
  return null;
}

export function deriveMenuState(availableTabs: MenuTabId[], layout?: TabsLayoutPrefs | null) {
  const rawOrder = Array.isArray(layout?.order) ? layout?.order ?? [] : [];
  const order = rawOrder.filter((t) => availableTabs.includes(t));
  for (const t of availableTabs) {
    if (order.includes(t)) continue;
    const pred = defaultPredecessor(t);
    const idx = pred ? order.indexOf(pred) : -1;
    if (idx >= 0) order.splice(idx + 1, 0, t);
    else order.push(t);
  }
  const hidden = Array.isArray(layout?.hidden) ? (layout?.hidden ?? []) : [];
  const hiddenSet = new Set(hidden);
  const visibleOrdered = order.filter((t) => !hiddenSet.has(t));
  const hiddenVisible = order.filter((t) => hiddenSet.has(t));
  const visibleByGroup: Record<MenuGroupId, MenuTabId[]> = {
    history: [],
    production: [],
    supply: [],
    warehouse: [],
    business: [],
    people: [],
    control: [],
  };
  for (const tab of visibleOrdered) {
    visibleByGroup[groupForTab(tab)].push(tab);
  }
  const groupsWithTabs = DEFAULT_GROUP_ORDER.filter((groupId) => visibleByGroup[groupId].length > 0);
  const hiddenGroupsRaw = Array.isArray(layout?.hiddenGroups) ? layout?.hiddenGroups ?? [] : [];
  const hiddenGroups = hiddenGroupsRaw.filter((g): g is MenuGroupId => isGroupId(String(g)));
  const hiddenGroupsSet = new Set(hiddenGroups);
  const hiddenGroupsVisible = groupsWithTabs.filter((g) => hiddenGroupsSet.has(g));
  const trashIndex = clamp(layout?.trashIndex ?? visibleOrdered.length, 0, visibleOrdered.length);
  return { order, hidden, hiddenSet, visibleOrdered, hiddenVisible, hiddenGroups, hiddenGroupsSet, hiddenGroupsVisible, trashIndex };
}

function isGroupId(value: string): value is MenuGroupId {
  return DEFAULT_GROUP_ORDER.includes(value as MenuGroupId);
}

export function groupForTab(tab: MenuTabId): MenuGroupId {
  for (const groupId of DEFAULT_GROUP_ORDER) {
    if (DEFAULT_GROUP_TABS[groupId].includes(tab)) return groupId;
  }
  return 'control';
}

export function Tabs(props: {
  tab: TabId;
  onTab: (t: MenuTabId) => void;
  availableTabs: MenuTabId[];
  layout: TabsLayoutPrefs | null;
  onLayoutChange: (next: TabsLayoutPrefs) => void;
  userLabel: string;
  userTab: MenuTabId;
  authStatus?: { online: boolean | null };
  right?: React.ReactNode;
  notesAlertCount?: number;
  historyAlertCount?: number;
  displayPrefs?: UiDisplayPrefs;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  pinnedShortcuts?: string[];
  onAddShortcut?: (id: string) => void;
  onRemoveShortcut?: (id: string) => void;
}) {
  const displayPrefs = props.displayPrefs ?? DEFAULT_UI_DISPLAY_PREFS;
  const departmentButtonActiveStyle = displayPrefs.departmentButtons.active;
  const departmentButtonInactiveStyle = displayPrefs.departmentButtons.inactive;
  const sectionButtonActiveStyle = displayPrefs.sectionButtons.active;
  const sectionButtonInactiveStyle = displayPrefs.sectionButtons.inactive;
  const departmentCardMinHeight = Math.max(
    44,
    Number(departmentButtonActiveStyle.height ?? 0),
    Number(departmentButtonInactiveStyle.height ?? 0),
  );
  const sectionCardMinHeight = Math.max(34, Math.floor(departmentCardMinHeight / 1.9));
  const departmentCardMaxWidth = Math.max(
    120,
    Number(departmentButtonActiveStyle.width ?? 0),
    Number(departmentButtonInactiveStyle.width ?? 0),
  );
  // Кнопки разделов растягиваются под надпись (одна строка, без переноса) — кап ширины
  // должен вмещать самые длинные метки («Статистика цехов», «Дубли номенклатуры» ~ одна строка).
  const sectionCardMaxWidth = Math.max(
    240,
    Number(sectionButtonActiveStyle.width ?? 240),
    Number(sectionButtonInactiveStyle.width ?? 240),
  );
  const departmentButtonsGap = 2;
  const sectionButtonsGap = 2;
  const canGoBack = props.canGoBack === true && typeof props.onBack === 'function';
  const canGoForward = props.canGoForward === true && typeof props.onForward === 'function';
  const menuState = deriveMenuState(props.availableTabs, props.layout);
  const hiddenGroupsSet = useMemo<Set<MenuGroupId>>(() => {
    const raw: unknown[] = Array.isArray(props.layout?.hiddenGroups) ? props.layout.hiddenGroups : [];
    const parsed = raw.map((x) => String(x)).filter((x): x is MenuGroupId => isGroupId(x));
    return new Set<MenuGroupId>(parsed);
  }, [props.layout?.hiddenGroups]);
  const collapsedGroups = useMemo<Set<MenuGroupId>>(() => {
    const raw: unknown[] = Array.isArray(props.layout?.collapsedGroups) ? props.layout.collapsedGroups : [];
    const parsed = raw.map((x) => String(x)).filter((x): x is MenuGroupId => isGroupId(x));
    return new Set<MenuGroupId>(parsed);
  }, [props.layout?.collapsedGroups]);
  const groupOrder = useMemo<MenuGroupId[]>(() => {
    const raw: unknown[] = Array.isArray(props.layout?.groupOrder) ? props.layout.groupOrder : [];
    const order = raw.map((x) => String(x)).filter((x): x is MenuGroupId => isGroupId(x));
    for (const groupId of DEFAULT_GROUP_ORDER) {
      if (!order.includes(groupId)) order.push(groupId);
    }
    const withoutHistory = order.filter((id) => id !== 'history');
    return ['history', ...withoutHistory];
  }, [props.layout?.groupOrder]);
  const visibleByGroup = useMemo(() => {
    const mapped: Record<MenuGroupId, MenuTabId[]> = {
      history: [],
      production: [],
      supply: [],
      warehouse: [],
      business: [],
      people: [],
      control: [],
    };
    for (const tab of menuState.visibleOrdered) {
      mapped[groupForTab(tab)].push(tab);
    }
    return mapped;
  }, [menuState.visibleOrdered]);
  const groupsWithTabs = useMemo<MenuGroupId[]>(() => groupOrder.filter((groupId) => visibleByGroup[groupId].length > 0), [groupOrder, visibleByGroup]);
  const groupsInUse = useMemo<MenuGroupId[]>(
    () => groupsWithTabs.filter((groupId) => !hiddenGroupsSet.has(groupId)),
    [groupsWithTabs, hiddenGroupsSet],
  );
  const preferredGroupByTab = useMemo(() => {
    const menuTab = resolveMenuTab(props.tab);
    if (!menuTab || !menuState.visibleOrdered.includes(menuTab)) return null;
    return groupForTab(menuTab);
  }, [menuState.visibleOrdered, props.tab]);
  const activeGroup = useMemo<MenuGroupId | null>(() => {
    const byLayoutRaw = props.layout?.activeGroup;
    const byLayout = typeof byLayoutRaw === 'string' && isGroupId(byLayoutRaw) ? byLayoutRaw : null;
    if (byLayout && groupsInUse.includes(byLayout) && !collapsedGroups.has(byLayout)) return byLayout;
    if (preferredGroupByTab && groupsInUse.includes(preferredGroupByTab) && !collapsedGroups.has(preferredGroupByTab)) {
      return preferredGroupByTab;
    }
    for (const groupId of groupsInUse) {
      if (!collapsedGroups.has(groupId)) return groupId;
    }
    return groupsInUse[0] ?? null;
  }, [collapsedGroups, groupsInUse, preferredGroupByTab, props.layout?.activeGroup]);
  const menuItems: MenuTabId[] = useMemo(() => [...menuState.visibleOrdered], [menuState.visibleOrdered]);
  const groupMenuItems: MenuTabId[] = useMemo(() => {
    if (!activeGroup) return [];
    return menuItems.filter((id) => groupForTab(id) === activeGroup);
  }, [activeGroup, menuItems]);
  const activeGroupIndex = useMemo(() => {
    if (!activeGroup) return -1;
    return groupsInUse.indexOf(activeGroup);
  }, [activeGroup, groupsInUse]);
  const menuItemsKey = groupMenuItems.join('|');
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const movePopupRef = useRef<HTMLDivElement | null>(null);
  const sectionsViewportRef = useRef<HTMLDivElement | null>(null);
  const sectionsTrackRef = useRef<HTMLDivElement | null>(null);
  const [contextMenu, setContextMenu] = useState<{ target: ContextTarget; x: number; y: number } | null>(null);
  const [moveId, setMoveId] = useState<ContextTarget | null>(null);
  const [moveRect, setMoveRect] = useState<DOMRect | null>(null);
  const [sectionsLeftPx, setSectionsLeftPx] = useState<number | null>(0);

  function keyOfTarget(target: ContextTarget) {
    return `${target.kind}:${target.id}`;
  }

  const labels: Record<MenuTabId, string> = {
    history: 'Мой круг',
    user_screens: 'Мои экраны',
    masterdata: 'Справочники',
    contracts: 'Контракты',
    changes: 'Изменения',
    engines: 'Двигатели',
    assembly_forecast: 'Прогноз сборки',
    engine_brands: 'Марки двигателей',
    engine_brand_groups: 'Группы марок',
    counterparties: 'Контрагенты',
    requests: 'Заявки',
    work_orders: 'Наряды',
    work_order_templates: 'Шаблоны нарядов',
    parts: 'Детали',
    tools: 'Инструменты',
    tool_accounting: 'Учёт инструментов',
    products: 'Товары',
    services: 'Услуги',
    services_by_brand: 'Услуги по маркам',
    nomenclature: 'Номенклатура',
    parts_dedupe: 'Дубли номенклатуры',
    engine_assembly_bom: 'BOM двигателей',
    stock_balances: 'Остатки',
    stock_documents: 'Документы',
    stock_receipts: 'Приход',
    stock_issues: 'Расход',
    stock_transfers: 'Перемещения',
    stock_inventory: 'Инвентаризация',
    repair_fund_audit: 'Ревизия ремфонда',
    warehouse_analytics: 'Аналитика выпуска',
    workshop_stats: 'Статистика цехов',
    employees: 'Сотрудники',
    timesheets: 'Табель',
    access_sections: 'Доступы по разделам',
    reports: 'Отчёты',
    audit: 'Журнал',
    empty_cards: 'Пустые карточки',
    drafts: 'Черновики',
    admin: 'Админ',
    auth: 'Вход',
    notes: 'Заметки',
    settings: 'Настройки',
    workshops: 'Цеха',
    warehouses_admin: 'Склады и цеха',
    warehouse_locations: 'Локации',
  };

  function updateLayout(nextVisibleOrder: MenuTabId[], trashIndex: number, nextHidden: MenuTabId[]) {
    const fullOrder = [...menuState.order];
    let cursor = 0;
    for (let i = 0; i < fullOrder.length; i += 1) {
      const current = fullOrder[i];
      if (!current) continue;
      if (!menuState.hiddenSet.has(current)) {
        const next = nextVisibleOrder[cursor];
        if (next) fullOrder[i] = next;
        cursor += 1;
      }
    }
    props.onLayoutChange({
      order: fullOrder,
      hidden: nextHidden,
      trashIndex,
      ...(props.layout?.groupOrder ? { groupOrder: props.layout.groupOrder } : {}),
      ...(props.layout?.hiddenGroups ? { hiddenGroups: props.layout.hiddenGroups } : {}),
      ...(props.layout?.collapsedGroups ? { collapsedGroups: props.layout.collapsedGroups } : {}),
      ...(props.layout?.activeGroup != null ? { activeGroup: props.layout.activeGroup } : {}),
    });
  }

  function updateGroupPrefs(next: {
    activeGroup?: MenuGroupId | null;
    collapsedGroups?: MenuGroupId[];
    groupOrder?: MenuGroupId[];
    hiddenGroups?: MenuGroupId[];
  }) {
    props.onLayoutChange({
      order: menuState.order,
      hidden: menuState.hidden,
      trashIndex: menuState.trashIndex,
      ...(next.groupOrder !== undefined ? { groupOrder: next.groupOrder } : props.layout?.groupOrder !== undefined ? { groupOrder: props.layout.groupOrder } : {}),
      ...(next.hiddenGroups !== undefined
        ? { hiddenGroups: next.hiddenGroups }
        : props.layout?.hiddenGroups !== undefined
          ? { hiddenGroups: props.layout.hiddenGroups }
          : {}),
      ...(next.collapsedGroups !== undefined
        ? { collapsedGroups: next.collapsedGroups }
        : props.layout?.collapsedGroups !== undefined
          ? { collapsedGroups: props.layout.collapsedGroups }
          : {}),
      ...(next.activeGroup !== undefined
        ? { activeGroup: next.activeGroup }
        : props.layout?.activeGroup !== undefined
          ? { activeGroup: typeof props.layout.activeGroup === 'string' && isGroupId(props.layout.activeGroup) ? props.layout.activeGroup : null }
          : {}),
    });
  }

  function hideGroup(groupId: MenuGroupId) {
    const nextHiddenGroups = Array.from(new Set([...(props.layout?.hiddenGroups ?? []), groupId])).filter((g): g is MenuGroupId => isGroupId(String(g)));
    const nextActive = activeGroup === groupId ? groupsInUse.find((g) => g !== groupId) ?? null : activeGroup;
    updateGroupPrefs({
      activeGroup: nextActive,
      hiddenGroups: nextHiddenGroups,
    });
  }

  function activateGroup(groupId: MenuGroupId) {
    if (groupId === 'history') {
      props.onTab('history');
      updateGroupPrefs({ activeGroup: null });
      return;
    }
    const nextCollapsed = new Set(collapsedGroups);
    nextCollapsed.delete(groupId);
    updateGroupPrefs({
      activeGroup: groupId,
      collapsedGroups: Array.from(nextCollapsed),
    });
    const firstTab = visibleByGroup[groupId][0];
    if (firstTab) props.onTab(firstTab);
  }

  useEffect(() => {
    if (!preferredGroupByTab) return;
    if (activeGroup === preferredGroupByTab) return;
    if (props.layout?.activeGroup && isGroupId(props.layout.activeGroup)) return;
    const nextCollapsed = new Set(collapsedGroups);
    if (nextCollapsed.has(preferredGroupByTab)) nextCollapsed.delete(preferredGroupByTab);
    updateGroupPrefs({
      activeGroup: preferredGroupByTab,
      collapsedGroups: Array.from(nextCollapsed),
    });
  }, [activeGroup, collapsedGroups, preferredGroupByTab, props.layout?.activeGroup]);

  function openContextMenu(target: ContextTarget, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ target, x: e.clientX, y: e.clientY });
  }

  function hideTab(id: MenuTabId) {
    const nextHidden = Array.from(new Set([...menuState.hidden, id]));
    updateLayout(menuState.visibleOrdered, menuState.trashIndex, nextHidden);
  }

  function startMove(target: ContextTarget) {
    setContextMenu(null);
    setMoveId(target);
  }

  function moveItem(delta: -1 | 1) {
    if (!moveId) return;
    if (moveId.kind === 'tab') {
      const currentIndex = menuItems.indexOf(moveId.id);
      const nextIndex = currentIndex + delta;
      if (currentIndex < 0 || nextIndex < 0 || nextIndex >= menuItems.length) return;
      const nextItems = [...menuItems];
      const [item] = nextItems.splice(currentIndex, 1);
      if (!item) return;
      nextItems.splice(nextIndex, 0, item);
      updateLayout(nextItems, menuState.trashIndex, menuState.hidden);
      return;
    }
    const currentIndex = groupsInUse.indexOf(moveId.id);
    const nextIndex = currentIndex + delta;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= groupsInUse.length) return;
    const leftGroup = groupsInUse[currentIndex];
    const rightGroup = groupsInUse[nextIndex];
    if (!leftGroup || !rightGroup) return;
    const nextGroupOrder = [...groupOrder];
    const leftPos = nextGroupOrder.indexOf(leftGroup);
    const rightPos = nextGroupOrder.indexOf(rightGroup);
    if (leftPos < 0 || rightPos < 0) return;
    nextGroupOrder[leftPos] = rightGroup;
    nextGroupOrder[rightPos] = leftGroup;
    updateGroupPrefs({ groupOrder: nextGroupOrder });
  }

  function tabButton(id: MenuTabId, label: string, opts?: { onContextMenu?: (e: React.MouseEvent) => void }) {
    const active = resolveMenuTab(props.tab) === id;
    const notesCount = id === 'notes' ? Math.max(0, Number(props.notesAlertCount ?? 0)) : 0;
    const parentGroup = groupForTab(id);
    const parentVisual = GROUP_VISUALS[parentGroup];
    const visual = TAB_VISUALS[id];
    return (
      <Button
        key={id}
        variant="ghost"
        onClick={() => props.onTab(id)}
        onContextMenu={opts?.onContextMenu}
        className={notesCount > 0 ? 'notes-tab-blink' : undefined}
        style={
          active
            ? {
                border: '1px solid rgba(15, 23, 42, 0.14)',
                background: '#0f2f72',
                color: '#ffffff',
                boxShadow: '0 10px 24px rgba(15,23,42,0.18)',
                fontWeight: 700,
                minHeight: sectionCardMinHeight,
                height: 'auto',
                width: 'fit-content',
                maxWidth: sectionCardMaxWidth,
                minWidth: 0,
                padding: '3px 8px',
                fontSize: sectionButtonActiveStyle.fontSize,
                textAlign: 'left',
                whiteSpace: 'nowrap',
                overflowWrap: 'normal',
                wordBreak: 'normal',
                display: 'flex',
                alignItems: 'center',
              }
            : {
                border: '1px solid rgba(148, 163, 184, 0.34)',
                background: parentVisual?.gradient ?? visual?.gradient ?? 'linear-gradient(135deg, #1d4ed8 0%, #0ea5e9 100%)',
                color: '#ffffff',
                boxShadow: '0 6px 18px rgba(15, 23, 42, 0.09)',
                minHeight: sectionCardMinHeight,
                height: 'auto',
                width: 'fit-content',
                maxWidth: sectionCardMaxWidth,
                minWidth: 0,
                padding: '3px 8px',
                fontSize: sectionButtonInactiveStyle.fontSize,
                textAlign: 'left',
                whiteSpace: 'nowrap',
                overflowWrap: 'normal',
                wordBreak: 'normal',
                display: 'flex',
                alignItems: 'center',
              }
        }
      >
        <span style={{ display: 'grid', gridTemplateColumns: 'auto auto', columnGap: 8, rowGap: 2, alignItems: 'center', width: 'max-content' }}>
          <span style={{ gridRow: 1, gridColumn: 1, fontSize: 15, lineHeight: 1 }}>{visual?.icon ?? '📁'}</span>
          <span style={{ gridRow: 1, gridColumn: 2, fontSize: 12, fontWeight: 800, lineHeight: 1.05, whiteSpace: 'nowrap', overflowWrap: 'normal', wordBreak: 'normal' }}>
            {label}
          </span>
          {notesCount > 0 ? (
            <span style={{ gridRow: 2, gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span
                style={{
                  fontSize: 11,
                  borderRadius: 999,
                  padding: '2px 7px',
                  background: 'rgba(255,255,255,0.24)',
                  fontWeight: 700,
                }}
              >
                {notesCount} недавн.
              </span>
              <span style={{ color: '#ffffff', fontWeight: 800, fontSize: 10 }}>Есть непрочитанные</span>
            </span>
          ) : null}
        </span>
      </Button>
    );
  }

  function menuItemButton(id: MenuTabId) {
    return tabButton(id, labels[id], { onContextMenu: (e) => openContextMenu({ kind: 'tab', id }, e) });
  }

  useEffect(() => {
    if (!moveId) return;
    const el = itemRefs.current[keyOfTarget(moveId)];
    if (el) setMoveRect(el.getBoundingClientRect());
    const sync = () => {
      const nextEl = itemRefs.current[keyOfTarget(moveId)];
      if (nextEl) setMoveRect(nextEl.getBoundingClientRect());
    };
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    return () => {
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync, true);
    };
  }, [moveId, menuItemsKey, groupsInUse.join('|')]);

  useEffect(() => {
    if (!contextMenu && !moveId) return;
    const handler = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (contextMenu && contextMenuRef.current?.contains(target)) return;
      if (moveId && movePopupRef.current?.contains(target)) return;
      setContextMenu(null);
      if (moveId) setMoveId(null);
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [contextMenu, moveId]);

  useLayoutEffect(() => {
    if (!activeGroup || activeGroupIndex < 0 || groupsInUse.length <= 0) {
      setSectionsLeftPx(null);
      return;
    }
    const viewport = sectionsViewportRef.current;
    const track = sectionsTrackRef.current;
    if (!viewport || !track) {
      setSectionsLeftPx(null);
      return;
    }

    const recalc = () => {
      const viewportWidth = Math.max(0, viewport.clientWidth);
      const trackWidth = Math.max(0, track.scrollWidth);
      const deptEl = itemRefs.current[`group:${activeGroup}`];
      if (viewportWidth <= 0 || trackWidth <= 0 || !deptEl) {
        setSectionsLeftPx(0);
        return;
      }
      const viewportRect = viewport.getBoundingClientRect();
      const deptRect = deptEl.getBoundingClientRect();
      const desiredCenter = deptRect.left + deptRect.width / 2 - viewportRect.left;
      const unclampedLeft = desiredCenter - trackWidth / 2;
      const maxLeft = Math.max(0, viewportWidth - trackWidth);
      const clampedLeft = Math.max(0, Math.min(maxLeft, unclampedLeft));
      setSectionsLeftPx(clampedLeft);
    };

    recalc();
    window.addEventListener('resize', recalc);
    return () => window.removeEventListener('resize', recalc);
  }, [activeGroup, activeGroupIndex, groupsInUse.length, menuItemsKey]);

  return (
    <div style={{ position: 'relative' }}>
      <div
        style={{
          marginTop: 2,
          borderRadius: 14,
          border: '1px solid rgba(59, 130, 246, 0.25)',
          background:
            'radial-gradient(circle at 8% 20%, rgba(125, 211, 252, 0.16), transparent 40%), radial-gradient(circle at 92% 80%, rgba(196, 181, 253, 0.18), transparent 42%), #ffffff',
          padding: 2,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'center',
            gap: departmentButtonsGap,
            alignItems: 'stretch',
            width: '100%',
            minWidth: 0,
          }}
        >
          {groupsInUse.map((groupId) => {
            const isActive = activeGroup === groupId && !collapsedGroups.has(groupId);
            const deptStyle = isActive ? departmentButtonActiveStyle : departmentButtonInactiveStyle;
            const deptVisual = getDepartmentButtonStyle(deptStyle);
            return (
              <div
                key={groupId}
                ref={(el) => {
                  itemRefs.current[keyOfTarget({ kind: 'group', id: groupId })] = el;
                }}
                style={{ display: 'flex', minWidth: 0, flex: '0 0 auto', position: 'relative' }}
              >
                <Button
                  variant="ghost"
                  onClick={() => {
                    activateGroup(groupId);
                  }}
                  onContextMenu={(e) => openContextMenu({ kind: 'group', id: groupId }, e)}
                  style={
                    isActive
                      ? {
                          width: 'fit-content',
                          maxWidth: departmentCardMaxWidth,
                          minHeight: departmentCardMinHeight,
                          height: 'auto',
                          minWidth: 0,
                          paddingTop: 2,
                          paddingRight: deptVisual.rightPadding,
                          paddingBottom: 2,
                          paddingLeft: 8,
                          border: '1px solid rgba(15, 23, 42, 0.14)',
                          background: '#0f2f72',
                          color: '#ffffff',
                          fontWeight: 800,
                          fontSize: departmentButtonActiveStyle.fontSize,
                          boxShadow: '0 10px 24px rgba(15,23,42,0.18)',
                          textAlign: 'left',
                          whiteSpace: 'normal',
                          overflowWrap: 'normal',
                          wordBreak: 'normal',
                          display: 'flex',
                          alignItems: 'center',
                          gap: deptVisual.stackGap,
                        }
                      : {
                          width: 'fit-content',
                          maxWidth: departmentCardMaxWidth,
                          minHeight: departmentCardMinHeight,
                          height: 'auto',
                          minWidth: 0,
                          paddingTop: 2,
                          paddingRight: deptVisual.rightPadding,
                          paddingBottom: 2,
                          paddingLeft: 8,
                          border: '1px solid rgba(148, 163, 184, 0.34)',
                          background: GROUP_VISUALS[groupId].gradient,
                          color: '#ffffff',
                          fontWeight: 700,
                          fontSize: departmentButtonInactiveStyle.fontSize,
                          boxShadow: '0 6px 18px rgba(15, 23, 42, 0.09)',
                          textAlign: 'left',
                          whiteSpace: 'normal',
                          overflowWrap: 'normal',
                          wordBreak: 'normal',
                          display: 'flex',
                          alignItems: 'center',
                          gap: deptVisual.stackGap,
                        }
                  }
                  title="Открыть отдел и первый раздел"
                >
                <span style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: deptVisual.stackGap, rowGap: 2, alignItems: 'center', minWidth: 0, width: '100%' }}>
                  <span style={{ gridRow: 1, gridColumn: 1, fontSize: deptVisual.iconSize, lineHeight: 1 }}>{GROUP_VISUALS[groupId].icon}</span>
                  <span
                    style={{
                      gridRow: 1,
                      gridColumn: 2,
                      fontSize: deptVisual.titleSize,
                      fontWeight: 900,
                      lineHeight: 1.05,
                      whiteSpace: 'normal',
                      overflowWrap: 'normal',
                      wordBreak: 'normal',
                      letterSpacing: 0.1,
                      minWidth: 0,
                    }}
                  >
                    {GROUP_LABELS[groupId]}
                  </span>
                  {GROUP_VISUALS[groupId].subtitle ? (
                    <span
                      style={{
                        gridRow: 2,
                        gridColumn: '1 / -1',
                        fontSize: deptVisual.subtitleSize,
                        opacity: 0.95,
                        lineHeight: 1.1,
                        whiteSpace: 'normal',
                        overflowWrap: 'normal',
                        wordBreak: 'normal',
                        fontWeight: 700,
                      }}
                    >
                      {GROUP_VISUALS[groupId].subtitle}
                    </span>
                  ) : null}
                  </span>
                </Button>
                {groupId === 'history' && Math.max(0, Number(props.historyAlertCount ?? 0)) > 0 ? (
                  <span
                    className="notes-tab-blink"
                    title="Есть новые контракты/ДС — не забудьте привязать двигатели"
                    style={{
                      position: 'absolute',
                      top: -5,
                      right: -5,
                      fontSize: 15,
                      lineHeight: 1,
                      pointerEvents: 'none',
                      filter: 'drop-shadow(0 1px 2px rgba(15,23,42,0.4))',
                    }}
                    aria-label="Есть новые уведомления"
                  >
                    🔔
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <div
        style={{
          marginTop: 2,
          borderRadius: 14,
          border: '1px solid rgba(59, 130, 246, 0.22)',
          background: '#ffffff',
          padding: '6px',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 0,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'flex-start', gap: 8, flexShrink: 0 }}>
          <Button
            variant="ghost"
            disabled={!canGoBack}
            title="Перейти к предыдущему окну"
            onClick={() => props.onBack?.()}
            style={{ minHeight: sectionCardMinHeight, padding: '2px 10px', fontSize: sectionButtonInactiveStyle.fontSize }}
          >
            ← Назад
          </Button>
          <Button
            variant="ghost"
            disabled={!canGoForward}
            title="Вернуться вперед к следующему окну"
            onClick={() => props.onForward?.()}
            style={{ minHeight: sectionCardMinHeight, padding: '2px 10px', fontSize: sectionButtonInactiveStyle.fontSize }}
          >
            Вперёд →
          </Button>
        </div>

        {activeGroup != null && !(props.tab === 'history' && activeGroup === 'history') && (
          <div
            ref={sectionsViewportRef}
            style={{
              position: 'relative',
              display: 'block',
              flex: 1,
              borderRadius: 14,
              minHeight: Math.max(38, sectionCardMinHeight),
              marginTop: 0,
              overflow: 'hidden',
            }}
          >
            {activeGroup == null ? (
              <div>
                <span style={{ color: theme.colors.muted }}>Выберите отдел, чтобы показать разделы.</span>
              </div>
            ) : (
              <div
                ref={sectionsTrackRef}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: sectionsLeftPx != null ? `${sectionsLeftPx}px` : '50%',
                  transform: sectionsLeftPx != null ? 'none' : 'translateX(-50%)',
                  display: 'inline-flex',
                  gap: sectionButtonsGap,
                  flexWrap: 'nowrap',
                  alignItems: 'stretch',
                  justifyContent: 'flex-start',
                  minHeight: sectionCardMinHeight,
                  whiteSpace: 'nowrap',
                }}
              >
                {groupMenuItems.map((id) => (
                  <div
                    key={id}
                    ref={(el) => {
                      itemRefs.current[keyOfTarget({ kind: 'tab', id })] = el;
                    }}
                    style={{ display: 'inline-flex' }}
                  >
                    {menuItemButton(id)}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            background: theme.colors.surface2,
            border: '1px solid var(--border)',
            borderRadius: 10,
            boxShadow: '0 16px 40px rgba(15,23,42,0.18)',
            padding: 6,
            zIndex: 2000,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            minWidth: 160,
          }}
        >
          <Button
            variant="ghost"
            onClick={() => {
              if (contextMenu.target.kind === 'tab') hideTab(contextMenu.target.id);
              else hideGroup(contextMenu.target.id);
              setContextMenu(null);
            }}
          >
            Скрыть
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              startMove(contextMenu.target);
            }}
          >
            Переместить
          </Button>
          {contextMenu.target.kind === 'tab' && props.onAddShortcut && props.onRemoveShortcut ? (() => {
            const shortcutId = `tab:${contextMenu.target.id}`;
            const isPinned = (props.pinnedShortcuts ?? []).includes(shortcutId);
            return (
              <Button
                variant="ghost"
                onClick={() => {
                  if (isPinned) props.onRemoveShortcut!(shortcutId);
                  else props.onAddShortcut!(shortcutId);
                  setContextMenu(null);
                }}
              >
                {isPinned ? 'Убрать из Моего круга' : 'Добавить в Мой круг'}
              </Button>
            );
          })() : null}
        </div>
      )}

      {moveId && moveRect && (
        <div
          ref={movePopupRef}
          style={{
            position: 'fixed',
            top: Math.max(4, moveRect.top - 38),
            left: moveRect.left + moveRect.width / 2 - 58,
            display: 'flex',
            gap: 6,
            padding: 6,
            borderRadius: 999,
            background: theme.colors.surface2,
            border: '1px solid var(--border)',
            boxShadow: '0 10px 24px rgba(15,23,42,0.16)',
            zIndex: 1950,
          }}
        >
          <Button
            variant="ghost"
            onClick={() => moveItem(-1)}
            disabled={moveId.kind === 'tab' ? menuItems.indexOf(moveId.id) <= 0 : groupsInUse.indexOf(moveId.id) <= 0}
          >
            ←
          </Button>
          <Button
            variant="ghost"
            onClick={() => moveItem(1)}
            disabled={
              moveId.kind === 'tab'
                ? menuItems.indexOf(moveId.id) >= menuItems.length - 1
                : groupsInUse.indexOf(moveId.id) >= groupsInUse.length - 1
            }
          >
            →
          </Button>
        </div>
      )}
    </div>
  );
}


