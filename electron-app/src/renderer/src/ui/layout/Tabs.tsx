import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { UiDisplayPrefs } from '@matricarmz/shared';
import { DEFAULT_UI_DISPLAY_PREFS } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { theme } from '../theme.js';

export type TabId =
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
  | 'production'
  | 'supply'
  | 'business'
  | 'people'
  | 'control'
  | 'interaction'
  | 'admin';

export const GROUP_LABELS: Record<MenuGroupId, string> = {
  production: 'Производство',
  supply: 'Снабжение и склад',
  business: 'Договоры и контрагенты',
  people: 'Персонал и доступ',
  control: 'Контроль и аналитика',
  interaction: 'Взаимодействие',
  admin: 'Администрирование',
};

const DEFAULT_GROUP_ORDER: MenuGroupId[] = ['production', 'supply', 'business', 'people', 'control', 'interaction', 'admin'];
const DEFAULT_GROUP_TABS: Record<MenuGroupId, MenuTabId[]> = {
  production: ['engines', 'engine_brands', 'parts'],
  supply: ['requests', 'work_orders', 'tools', 'products', 'services'],
  business: ['contracts', 'counterparties'],
  people: ['employees'],
  control: ['reports', 'changes', 'audit', 'ui_control'],
  interaction: ['notes'],
  admin: ['masterdata'],
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
    production: [],
    supply: [],
    business: [],
    people: [],
    control: [],
    interaction: [],
    admin: [],
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
  return 'admin';
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
    return order;
  }, [props.layout?.groupOrder]);
  const visibleByGroup = useMemo(() => {
    const mapped: Record<MenuGroupId, MenuTabId[]> = {
      production: [],
      supply: [],
      business: [],
      people: [],
      control: [],
      interaction: [],
      admin: [],
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
                border: '1px solid #0f2f72',
                background: '#0f2f72',
                color: '#ffffff',
                boxShadow: '0 8px 18px rgba(15, 47, 114, 0.24)',
                fontWeight: 800,
                transform: 'scale(1.04)',
                minHeight: sectionButtonActiveStyle.height,
                minWidth: sectionButtonActiveStyle.width,
                padding: `${sectionButtonActiveStyle.paddingY}px ${sectionButtonActiveStyle.paddingX}px`,
                fontSize: sectionButtonActiveStyle.fontSize,
              }
            : {
                border: '1px solid rgba(71, 85, 105, 0.34)',
                background: 'rgba(148, 163, 184, 0.35)',
                color: '#111827',
                boxShadow: '0 3px 10px rgba(15, 23, 42, 0.09)',
                minHeight: sectionButtonInactiveStyle.height,
                minWidth: sectionButtonInactiveStyle.width,
                padding: `${sectionButtonInactiveStyle.paddingY}px ${sectionButtonInactiveStyle.paddingX}px`,
                fontSize: sectionButtonInactiveStyle.fontSize,
              }
        }
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {label}
          {notesCount > 0 ? (
            <span style={{ color: 'var(--danger)', fontWeight: 900 }}>{notesCount}</span>
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
          display: 'grid',
          gap: departmentButtonsGap,
          marginTop: 4,
          padding: '4px 6px',
          background: '#ffffff',
          border: '1px solid rgba(148, 163, 184, 0.24)',
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
                        minHeight: departmentButtonActiveStyle.height,
                        minWidth: departmentButtonActiveStyle.width,
                        padding: `${departmentButtonActiveStyle.paddingY}px ${departmentButtonActiveStyle.paddingX}px`,
                        border: '1px solid #0b2d63',
                        background: 'linear-gradient(160deg, #143d86 0%, #0f2f72 55%, #0b254f 100%)',
                        color: '#ffffff',
                        fontWeight: 800,
                        fontSize: departmentButtonActiveStyle.fontSize,
                        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12), 0 4px 10px rgba(15, 47, 114, 0.28)',
                        letterSpacing: 0.1,
                      }
                    : {
                        width: '100%',
                        minHeight: departmentButtonInactiveStyle.height,
                        minWidth: departmentButtonInactiveStyle.width,
                        padding: `${departmentButtonInactiveStyle.paddingY}px ${departmentButtonInactiveStyle.paddingX}px`,
                        border: '1px solid #8f99a7',
                        background: 'linear-gradient(160deg, #d5d9df 0%, #bec4cd 45%, #e8ebef 100%)',
                        color: '#111827',
                        fontWeight: 500,
                        fontSize: departmentButtonInactiveStyle.fontSize,
                        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.7), 0 2px 7px rgba(15, 23, 42, 0.14)',
                        letterSpacing: 0,
                      }
                }
                  title={isCollapsed ? 'Развернуть отдел' : 'Свернуть отдел'}
                >
                  <span
                  style={{
                    display: 'block',
                    textAlign: 'center',
                    lineHeight: 1.2,
                    whiteSpace: 'normal',
                    wordBreak: 'break-word',
                    overflowWrap: 'anywhere',
                    hyphens: 'auto',
                    fontSize: isActive ? departmentButtonActiveStyle.fontSize : departmentButtonInactiveStyle.fontSize,
                  }}
                  >
                    {GROUP_LABELS[groupId]}
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
          marginTop: 2,
          padding: '3px 6px',
          background: 'transparent',
          border: 'none',
          minHeight: 74,
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
              top: 5,
              left: sectionsLeftPx != null ? `${sectionsLeftPx}px` : activeGroupAnchorLeft,
              transform: sectionsLeftPx != null ? 'none' : 'translateX(-50%)',
              display: 'inline-flex',
              gap: sectionButtonsGap,
              flexWrap: 'nowrap',
              alignItems: 'center',
              justifyContent: 'flex-start',
              minHeight: 38,
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


