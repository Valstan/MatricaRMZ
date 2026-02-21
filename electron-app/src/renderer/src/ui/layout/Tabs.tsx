import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { UiDisplayPrefs } from '@matricarmz/shared';
import { DEFAULT_UI_DISPLAY_PREFS } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { theme } from '../theme.js';

export type TabId =
  | 'history'
  | 'engines'
  | 'engine'
  | 'engine_brands'
  | 'engine_brand'
  | 'counterparties'
  | 'counterparty'
  | 'products'
  | 'product'
  | 'services'
  | 'service'
  | 'contracts'
  | 'contract'
  | 'requests'
  | 'request'
  | 'work_orders'
  | 'work_order'
  | 'parts'
  | 'part'
  | 'tools'
  | 'tool'
  | 'tool_properties'
  | 'tool_property'
  | 'employees'
  | 'employee'
  | 'changes'
  | 'auth'
  | 'reports'
  | 'masterdata'
  | 'admin'
  | 'audit'
  | 'notes'
  | 'settings'
  | 'ui_control';

export type MenuTabId = Exclude<
  TabId,
  | 'engine'
  | 'request'
  | 'work_order'
  | 'part'
  | 'employee'
  | 'contract'
  | 'engine_brand'
  | 'product'
  | 'service'
  | 'counterparty'
  | 'tool'
  | 'tool_property'
  | 'tool_properties'
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

type ContextTarget =
  | { kind: 'tab'; id: MenuTabId }
  | { kind: 'group'; id: MenuGroupId };
export type MenuGroupId =
  | 'history'
  | 'production'
  | 'supply'
  | 'business'
  | 'people'
  | 'control';

export const GROUP_LABELS: Record<MenuGroupId, string> = {
  history: 'История',
  production: 'Производство',
  supply: 'Снабжение и склад',
  business: 'Договоры и контрагенты',
  people: 'Персонал и доступ',
  control: 'Контроль и аналитика',
};

const DEFAULT_GROUP_ORDER: MenuGroupId[] = ['history', 'production', 'supply', 'business', 'people', 'control'];
const DEFAULT_GROUP_TABS: Record<MenuGroupId, MenuTabId[]> = {
  history: ['history'],
  production: ['engines', 'engine_brands', 'parts'],
  supply: ['requests', 'work_orders', 'tools', 'products', 'services'],
  business: ['contracts', 'counterparties'],
  people: ['employees'],
  control: ['reports', 'changes', 'audit', 'ui_control', 'notes', 'masterdata', 'admin'],
};

type GroupVisualMeta = { icon: string; subtitle: string; gradient: string };
const GROUP_VISUALS: Record<MenuGroupId, GroupVisualMeta> = {
  history: {
    icon: '🕘',
    subtitle: 'Последние действия и быстрый вход',
    gradient: 'linear-gradient(135deg, #1d4ed8 0%, #0ea5e9 100%)',
  },
  production: {
    icon: '⚙️',
    subtitle: 'Двигатели, марки и детали',
    gradient: 'linear-gradient(135deg, #0f766e 0%, #10b981 100%)',
  },
  supply: {
    icon: '📦',
    subtitle: 'Заявки, наряды и снабжение',
    gradient: 'linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)',
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
const TAB_VISUALS: Partial<Record<MenuTabId, TabVisualMeta>> = {
  history: { icon: '🕘', subtitle: 'Стартовый экран и последние переходы', gradient: 'linear-gradient(135deg, #1d4ed8 0%, #0ea5e9 100%)' },
  engines: { icon: '⚙️', subtitle: 'Список и карточки двигателей', gradient: 'linear-gradient(135deg, #1d4ed8 0%, #0ea5e9 100%)' },
  engine_brands: { icon: '🏷️', subtitle: 'Марки двигателей и нормы', gradient: 'linear-gradient(135deg, #2563eb 0%, #60a5fa 100%)' },
  parts: { icon: '🧩', subtitle: 'Справочник деталей и узлов', gradient: 'linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)' },
  requests: { icon: '📦', subtitle: 'Закупка и потребности', gradient: 'linear-gradient(135deg, #0f766e 0%, #10b981 100%)' },
  work_orders: { icon: '🛠️', subtitle: 'Работы и производство', gradient: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)' },
  tools: { icon: '🔧', subtitle: 'Инструменты и оснащение', gradient: 'linear-gradient(135deg, #059669 0%, #22c55e 100%)' },
  products: { icon: '📦', subtitle: 'Товары и номенклатура', gradient: 'linear-gradient(135deg, #0891b2 0%, #06b6d4 100%)' },
  services: { icon: '🧰', subtitle: 'Услуги и операции', gradient: 'linear-gradient(135deg, #0284c7 0%, #38bdf8 100%)' },
  contracts: { icon: '📄', subtitle: 'Договоры и условия', gradient: 'linear-gradient(135deg, #7c3aed 0%, #c084fc 100%)' },
  counterparties: { icon: '🤝', subtitle: 'Поставщики и партнеры', gradient: 'linear-gradient(135deg, #9333ea 0%, #ec4899 100%)' },
  employees: { icon: '👥', subtitle: 'Сотрудники и профили', gradient: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)' },
  reports: { icon: '📊', subtitle: 'Аналитика и выгрузки', gradient: 'linear-gradient(135deg, #be185d 0%, #ec4899 100%)' },
  changes: { icon: '🧾', subtitle: 'История изменений данных', gradient: 'linear-gradient(135deg, #6b7280 0%, #94a3b8 100%)' },
  audit: { icon: '🔍', subtitle: 'Журнал аудита действий', gradient: 'linear-gradient(135deg, #374151 0%, #6b7280 100%)' },
  notes: { icon: '📝', subtitle: 'Личные и общие записи', gradient: 'linear-gradient(135deg, #c2410c 0%, #f97316 100%)' },
  masterdata: { icon: '🗂️', subtitle: 'Общие справочники системы', gradient: 'linear-gradient(135deg, #0f766e 0%, #10b981 100%)' },
  ui_control: { icon: '🎛️', subtitle: 'Визуальные настройки интерфейса', gradient: 'linear-gradient(135deg, #4338ca 0%, #818cf8 100%)' },
  admin: { icon: '🛡️', subtitle: 'Админ. раздел и полномочия', gradient: 'linear-gradient(135deg, #4b5563 0%, #9ca3af 100%)' },
  auth: { icon: '🔐', subtitle: 'Вход и авторизация', gradient: 'linear-gradient(135deg, #334155 0%, #64748b 100%)' },
  settings: { icon: '⚙️', subtitle: 'Параметры программы', gradient: 'linear-gradient(135deg, #475569 0%, #94a3b8 100%)' },
};

function clamp(n: number, min: number, max: number) {
  if (Number.isNaN(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export function deriveMenuState(availableTabs: MenuTabId[], layout?: TabsLayoutPrefs | null) {
  const rawOrder = Array.isArray(layout?.order) ? layout?.order ?? [] : [];
  const order = rawOrder.filter((t) => availableTabs.includes(t));
  for (const t of availableTabs) {
    if (!order.includes(t)) order.push(t);
  }
  const hidden = Array.isArray(layout?.hidden) ? (layout?.hidden ?? []) : [];
  const hiddenSet = new Set(hidden);
  const visibleOrdered = order.filter((t) => !hiddenSet.has(t));
  const hiddenVisible = order.filter((t) => hiddenSet.has(t));
  const visibleByGroup: Record<MenuGroupId, MenuTabId[]> = {
    history: [],
    production: [],
    supply: [],
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

function groupForTab(tab: MenuTabId): MenuGroupId {
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
  displayPrefs?: UiDisplayPrefs;
}) {
  const displayPrefs = props.displayPrefs ?? DEFAULT_UI_DISPLAY_PREFS;
  const departmentButtonActiveStyle = displayPrefs.departmentButtons.active;
  const departmentButtonInactiveStyle = displayPrefs.departmentButtons.inactive;
  const sectionButtonActiveStyle = displayPrefs.sectionButtons.active;
  const sectionButtonInactiveStyle = displayPrefs.sectionButtons.inactive;
  const departmentCardMinHeight = Math.max(96, Number(departmentButtonActiveStyle.height ?? 0), Number(departmentButtonInactiveStyle.height ?? 0));
  const sectionCardMinHeight = Math.max(46, Math.floor(departmentCardMinHeight / 2));
  const departmentButtonsGap = Math.max(0, Number(departmentButtonActiveStyle.gap ?? 8));
  const sectionButtonsGap = Math.max(0, Number(sectionButtonActiveStyle.gap ?? 6));
  const menuState = deriveMenuState(props.availableTabs, props.layout);
  const hiddenGroupsSet = useMemo(() => {
    const raw = Array.isArray(props.layout?.hiddenGroups) ? props.layout?.hiddenGroups ?? [] : [];
    return new Set(raw.filter((x): x is MenuGroupId => isGroupId(String(x))));
  }, [props.layout?.hiddenGroups]);
  const collapsedGroups = useMemo(() => {
    const raw = Array.isArray(props.layout?.collapsedGroups) ? props.layout?.collapsedGroups ?? [] : [];
    return new Set(raw.filter((x): x is MenuGroupId => isGroupId(String(x))));
  }, [props.layout?.collapsedGroups]);
  const groupOrder = useMemo(() => {
    const raw = Array.isArray(props.layout?.groupOrder) ? props.layout?.groupOrder ?? [] : [];
    const order = raw.filter((x): x is MenuGroupId => isGroupId(String(x)));
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
      business: [],
      people: [],
      control: [],
    };
    for (const tab of menuState.visibleOrdered) {
      mapped[groupForTab(tab)].push(tab);
    }
    return mapped;
  }, [menuState.visibleOrdered]);
  const groupsWithTabs = useMemo(() => groupOrder.filter((groupId) => visibleByGroup[groupId].length > 0), [groupOrder, visibleByGroup]);
  const groupsInUse = useMemo(
    () => groupsWithTabs.filter((groupId) => !hiddenGroupsSet.has(groupId)),
    [groupsWithTabs, hiddenGroupsSet],
  );
  const preferredGroupByTab = useMemo(() => {
    if (!menuState.visibleOrdered.includes(props.tab as MenuTabId)) return null;
    return groupForTab(props.tab as MenuTabId);
  }, [menuState.visibleOrdered, props.tab]);
  const activeGroup = useMemo(() => {
    const byLayout = props.layout?.activeGroup;
    if (byLayout && isGroupId(byLayout) && groupsInUse.includes(byLayout) && !collapsedGroups.has(byLayout)) return byLayout;
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
  const activeGroupAnchorLeft = useMemo(() => {
    if (activeGroupIndex < 0 || groupsInUse.length <= 0) return '50%';
    const columnsCount = groupsInUse.length;
    const gridGap = departmentButtonsGap;
    const gapTotal = (columnsCount - 1) * gridGap;
    return `calc(((100% - ${gapTotal}px) / ${columnsCount}) * ${activeGroupIndex + 0.5} + ${activeGroupIndex * gridGap}px)`;
  }, [activeGroupIndex, departmentButtonsGap, groupsInUse.length]);
  const menuItemsKey = groupMenuItems.join('|');
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const movePopupRef = useRef<HTMLDivElement | null>(null);
  const sectionsViewportRef = useRef<HTMLDivElement | null>(null);
  const sectionsTrackRef = useRef<HTMLDivElement | null>(null);
  const [contextMenu, setContextMenu] = useState<{ target: ContextTarget; x: number; y: number } | null>(null);
  const [moveId, setMoveId] = useState<ContextTarget | null>(null);
  const [moveRect, setMoveRect] = useState<DOMRect | null>(null);
  const [sectionsLeftPx, setSectionsLeftPx] = useState<number | null>(null);

  function keyOfTarget(target: ContextTarget) {
    return `${target.kind}:${target.id}`;
  }

  const labels: Record<MenuTabId, string> = {
    history: 'История',
    masterdata: 'Справочники',
    contracts: 'Контракты',
    changes: 'Изменения',
    engines: 'Двигатели',
    engine_brands: 'Марки двигателей',
    counterparties: 'Контрагенты',
    requests: 'Заявки',
    work_orders: 'Наряды',
    parts: 'Детали',
    tools: 'Инструменты',
    products: 'Товары',
    services: 'Услуги',
    employees: 'Сотрудники',
    reports: 'Отчёты',
    audit: 'Журнал',
    admin: 'Админ',
    auth: 'Вход',
    notes: 'Заметки',
    settings: 'Настройки',
    ui_control: 'UI Control Center',
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
          ? { activeGroup: props.layout.activeGroup }
          : {}),
    });
  }

  function toggleGroup(groupId: MenuGroupId) {
    const nextCollapsed = new Set(collapsedGroups);
    const isCollapsed = nextCollapsed.has(groupId);
    if (isCollapsed) nextCollapsed.delete(groupId);
    else if (activeGroup === groupId) nextCollapsed.add(groupId);
    const nextActive = isCollapsed ? groupId : activeGroup === groupId ? null : groupId;
    updateGroupPrefs({
      activeGroup: nextActive,
      collapsedGroups: Array.from(nextCollapsed),
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
    const active = props.tab === id;
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
                minWidth: Math.max(130, Math.floor(Number(sectionButtonActiveStyle.width ?? 130) * 0.78)),
                padding: `${sectionButtonActiveStyle.paddingY}px ${sectionButtonActiveStyle.paddingX}px`,
                fontSize: sectionButtonActiveStyle.fontSize,
                textAlign: 'left',
              }
            : {
                border: '1px solid rgba(148, 163, 184, 0.34)',
                background: parentVisual?.gradient ?? visual?.gradient ?? 'linear-gradient(135deg, #1d4ed8 0%, #0ea5e9 100%)',
                color: '#ffffff',
                boxShadow: '0 6px 18px rgba(15, 23, 42, 0.09)',
                minHeight: sectionCardMinHeight,
                minWidth: Math.max(130, Math.floor(Number(sectionButtonInactiveStyle.width ?? 130) * 0.78)),
                padding: `${sectionButtonInactiveStyle.paddingY}px ${sectionButtonInactiveStyle.paddingX}px`,
                fontSize: sectionButtonInactiveStyle.fontSize,
                textAlign: 'left',
              }
        }
      >
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 3, minWidth: 130 }}>
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <span style={{ fontSize: 17, lineHeight: 1 }}>{visual?.icon ?? '📁'}</span>
            {notesCount > 0 ? (
              <span
                style={{
                  fontSize: 11,
                  borderRadius: 999,
                  padding: '2px 7px',
                  background: active ? 'rgba(255,255,255,0.24)' : 'rgba(255,255,255,0.24)',
                  fontWeight: 700,
                }}
              >
                {notesCount} недавн.
              </span>
            ) : null}
          </span>
          <span style={{ fontSize: 13, fontWeight: 800, lineHeight: 1.15 }}>{label}</span>
          {notesCount > 0 ? (
            <span style={{ color: '#ffffff', fontWeight: 800, fontSize: 10 }}>Есть непрочитанные</span>
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
      if (viewportWidth <= 0 || trackWidth <= 0) {
        setSectionsLeftPx(0);
        return;
      }
      const columnsCount = groupsInUse.length;
      const gap = departmentButtonsGap;
      const totalGap = Math.max(0, (columnsCount - 1) * gap);
      const colWidth = Math.max(0, (viewportWidth - totalGap) / Math.max(1, columnsCount));
      const desiredCenter = colWidth * (activeGroupIndex + 0.5) + gap * activeGroupIndex;
      const unclampedLeft = desiredCenter - trackWidth / 2;
      const minLeft = 0;
      const maxLeft = Math.max(0, viewportWidth - trackWidth);
      const clampedLeft = Math.max(minLeft, Math.min(maxLeft, unclampedLeft));
      setSectionsLeftPx(clampedLeft);
    };

    recalc();
    window.addEventListener('resize', recalc);
    return () => window.removeEventListener('resize', recalc);
  }, [activeGroup, activeGroupIndex, groupsInUse.length, departmentButtonsGap, menuItemsKey]);

  return (
    <div style={{ position: 'relative' }}>
      <div
        style={{
          marginTop: 6,
          borderRadius: 14,
          border: '1px solid rgba(59, 130, 246, 0.25)',
          background:
            'radial-gradient(circle at 8% 20%, rgba(125, 211, 252, 0.16), transparent 40%), radial-gradient(circle at 92% 80%, rgba(196, 181, 253, 0.18), transparent 42%), #ffffff',
          padding: 12,
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${Math.max(1, groupsInUse.length)}, minmax(0, 1fr))`,
            gap: departmentButtonsGap,
            alignItems: 'stretch',
          }}
        >
          {groupsInUse.map((groupId) => {
            const isActive = activeGroup === groupId && !collapsedGroups.has(groupId);
            const isCollapsed = collapsedGroups.has(groupId);
            return (
              <div
                key={groupId}
                ref={(el) => {
                  itemRefs.current[keyOfTarget({ kind: 'group', id: groupId })] = el;
                }}
              >
                <Button
                  variant="ghost"
                  onClick={() => toggleGroup(groupId)}
                  onContextMenu={(e) => openContextMenu({ kind: 'group', id: groupId }, e)}
                  style={
                    isActive
                      ? {
                          width: '100%',
                          minHeight: departmentCardMinHeight,
                          minWidth: departmentButtonActiveStyle.width,
                          padding: `${departmentButtonActiveStyle.paddingY}px ${departmentButtonActiveStyle.paddingX}px`,
                          border: '1px solid rgba(15, 23, 42, 0.14)',
                          background: '#0f2f72',
                          color: '#ffffff',
                          fontWeight: 800,
                          fontSize: departmentButtonActiveStyle.fontSize,
                          boxShadow: '0 10px 24px rgba(15,23,42,0.18)',
                          textAlign: 'left',
                        }
                      : {
                          width: '100%',
                          minHeight: departmentCardMinHeight,
                          minWidth: departmentButtonInactiveStyle.width,
                          padding: `${departmentButtonInactiveStyle.paddingY}px ${departmentButtonInactiveStyle.paddingX}px`,
                          border: '1px solid rgba(148, 163, 184, 0.34)',
                          background: GROUP_VISUALS[groupId].gradient,
                          color: '#ffffff',
                          fontWeight: 700,
                          fontSize: departmentButtonInactiveStyle.fontSize,
                          boxShadow: '0 6px 18px rgba(15, 23, 42, 0.09)',
                          textAlign: 'left',
                        }
                  }
                  title={isCollapsed ? 'Развернуть отдел' : 'Свернуть отдел'}
                >
                  <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 5 }}>
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <span style={{ fontSize: 20, lineHeight: 1 }}>{GROUP_VISUALS[groupId].icon}</span>
                      <span
                        style={{
                          fontSize: 11,
                          borderRadius: 999,
                          padding: '2px 7px',
                          background: 'rgba(255,255,255,0.24)',
                          fontWeight: 700,
                        }}
                      >
                        {visibleByGroup[groupId].length} разд.
                      </span>
                    </span>
                    <span style={{ fontSize: 14, fontWeight: 800, lineHeight: 1.2 }}>{GROUP_LABELS[groupId]}</span>
                    <span style={{ fontSize: 12, opacity: 0.95, lineHeight: 1.2 }}>{GROUP_VISUALS[groupId].subtitle}</span>
                  </span>
                </Button>
              </div>
            );
          })}
        </div>
      </div>

      <div
        ref={sectionsViewportRef}
        style={{
          position: 'relative',
          display: 'block',
          marginTop: 10,
          borderRadius: 14,
          border: '1px solid rgba(59, 130, 246, 0.22)',
          background: '#ffffff',
          padding: '10px 12px',
          minHeight: 82,
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
              top: 8,
              left: sectionsLeftPx != null ? `${sectionsLeftPx}px` : activeGroupAnchorLeft,
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


