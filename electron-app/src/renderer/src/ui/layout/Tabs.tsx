import React, { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../components/Button.js';
import { tabAccent, theme } from '../theme.js';

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
  | 'settings';

export type MenuTabId = Exclude<
  TabId,
  | 'engine'
  | 'request'
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
  collapsedGroups?: MenuGroupId[];
  activeGroup?: MenuGroupId | null;
};

type MenuItemId = MenuTabId | 'trash';
export type MenuGroupId =
  | 'production'
  | 'supply'
  | 'business'
  | 'people'
  | 'control'
  | 'interaction'
  | 'admin';

const GROUP_LABELS: Record<MenuGroupId, string> = {
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
  supply: ['requests', 'tools', 'products', 'services'],
  business: ['contracts', 'counterparties'],
  people: ['employees'],
  control: ['reports', 'changes'],
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
  const trashIndex = clamp(layout?.trashIndex ?? visibleOrdered.length, 0, visibleOrdered.length);
  return { order, hidden, hiddenSet, visibleOrdered, hiddenVisible, trashIndex };
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
}) {
  const menuState = deriveMenuState(props.availableTabs, props.layout);
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
  const groupsInUse = useMemo(
    () => groupOrder.filter((groupId) => visibleByGroup[groupId].length > 0),
    [groupOrder, visibleByGroup],
  );
  const preferredGroupByTab = useMemo(() => {
    if (!menuState.visibleOrdered.includes(props.tab as MenuTabId)) return null;
    return groupForTab(props.tab as MenuTabId);
  }, [menuState.visibleOrdered, props.tab]);
  const activeGroup = useMemo(() => {
    if (preferredGroupByTab && groupsInUse.includes(preferredGroupByTab) && !collapsedGroups.has(preferredGroupByTab)) {
      return preferredGroupByTab;
    }
    const byLayout = props.layout?.activeGroup;
    if (byLayout && isGroupId(byLayout) && groupsInUse.includes(byLayout) && !collapsedGroups.has(byLayout)) return byLayout;
    for (const groupId of groupsInUse) {
      if (!collapsedGroups.has(groupId)) return groupId;
    }
    return groupsInUse[0] ?? null;
  }, [collapsedGroups, groupsInUse, preferredGroupByTab, props.layout?.activeGroup]);
  const menuItems: MenuItemId[] = useMemo(() => {
    const base: MenuItemId[] = [...menuState.visibleOrdered];
    const next: MenuItemId[] = [...base];
    next.splice(menuState.trashIndex, 0, 'trash' as MenuItemId);
    return next;
  }, [menuState.trashIndex, menuState.visibleOrdered]);
  const groupMenuItems: MenuItemId[] = useMemo(() => {
    if (!activeGroup) return [];
    return menuItems.filter((id) => id === 'trash' || groupForTab(id) === activeGroup);
  }, [activeGroup, menuItems]);
  const menuItemsKey = groupMenuItems.join('|');
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const trashPopupRef = useRef<HTMLDivElement | null>(null);
  const movePopupRef = useRef<HTMLDivElement | null>(null);
  const [contextMenu, setContextMenu] = useState<{ id: MenuItemId; x: number; y: number } | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashRect, setTrashRect] = useState<DOMRect | null>(null);
  const [moveId, setMoveId] = useState<MenuItemId | null>(null);
  const [moveRect, setMoveRect] = useState<DOMRect | null>(null);

  const labels: Record<MenuTabId, string> = {
    masterdata: 'Справочники',
    contracts: 'Контракты',
    changes: 'Изменения',
    engines: 'Двигатели',
    engine_brands: 'Марки двигателей',
    counterparties: 'Контрагенты',
    requests: 'Заявки',
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
      ...(props.layout?.collapsedGroups ? { collapsedGroups: props.layout.collapsedGroups } : {}),
      ...(props.layout?.activeGroup != null ? { activeGroup: props.layout.activeGroup } : {}),
    });
  }

  function updateGroupPrefs(next: { activeGroup?: MenuGroupId | null; collapsedGroups?: MenuGroupId[] }) {
    props.onLayoutChange({
      order: menuState.order,
      hidden: menuState.hidden,
      trashIndex: menuState.trashIndex,
      ...(props.layout?.groupOrder ? { groupOrder: props.layout.groupOrder } : {}),
      ...(next.collapsedGroups ? { collapsedGroups: next.collapsedGroups } : props.layout?.collapsedGroups ? { collapsedGroups: props.layout.collapsedGroups } : {}),
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

  useEffect(() => {
    if (!preferredGroupByTab) return;
    if (activeGroup === preferredGroupByTab) return;
    const nextCollapsed = new Set(collapsedGroups);
    if (nextCollapsed.has(preferredGroupByTab)) nextCollapsed.delete(preferredGroupByTab);
    updateGroupPrefs({
      activeGroup: preferredGroupByTab,
      collapsedGroups: Array.from(nextCollapsed),
    });
  }, [activeGroup, collapsedGroups, preferredGroupByTab]);

  function openContextMenu(id: MenuItemId, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setTrashOpen(false);
    setContextMenu({ id, x: e.clientX, y: e.clientY });
  }

  function hideTab(id: MenuTabId) {
    const nextHidden = Array.from(new Set([...menuState.hidden, id]));
    updateLayout(menuState.visibleOrdered, menuState.trashIndex, nextHidden);
  }

  function restoreTab(id: MenuTabId) {
    const nextHidden = menuState.hidden.filter((t) => t !== id);
    updateLayout(menuState.visibleOrdered, menuState.trashIndex, nextHidden);
    setTrashOpen(false);
  }

  function restoreAllTabs() {
    if (menuState.hidden.length === 0) return;
    updateLayout(menuState.visibleOrdered, menuState.trashIndex, []);
    setTrashOpen(false);
  }

  function startMove(id: MenuItemId) {
    setContextMenu(null);
    setTrashOpen(false);
    setMoveId(id);
  }

  function moveItem(delta: -1 | 1) {
    if (!moveId) return;
    const currentIndex = menuItems.indexOf(moveId);
    const nextIndex = currentIndex + delta;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= menuItems.length) return;
    const nextItems = [...menuItems];
    const [item] = nextItems.splice(currentIndex, 1);
    if (!item) return;
    nextItems.splice(nextIndex, 0, item);
    const nextVisibleOrder = nextItems.filter((x): x is MenuTabId => x !== 'trash');
    const nextTrashIndex = nextItems.indexOf('trash');
    updateLayout(nextVisibleOrder, nextTrashIndex, menuState.hidden);
  }

  function tabButton(id: MenuTabId, label: string, opts?: { onContextMenu?: (e: React.MouseEvent) => void }) {
    const acc = theme.accents[tabAccent(id)];
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
                border: '2px dashed #dc2626',
                background: `linear-gradient(135deg, ${acc.bg} 0%, ${acc.border} 120%)`,
                color: acc.text,
                boxShadow: '0 14px 24px rgba(0,0,0,0.18)',
                fontWeight: 800,
                fontSize: 16,
                transform: 'scale(1.06)',
              }
            : {
                border: `1px solid ${acc.border}`,
                background: theme.colors.surface2,
                color: acc.border,
                boxShadow: '0 10px 18px rgba(15, 23, 42, 0.08)',
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

  function menuItemButton(id: MenuItemId) {
    if (id === 'trash') {
      return (
        <Button
          variant="ghost"
          onClick={() => {
            setContextMenu(null);
            setTrashOpen((prev) => !prev);
          }}
          onContextMenu={(e) => openContextMenu('trash', e)}
          title="Корзина кнопок"
        >
          🗑 Корзина
        </Button>
      );
    }
    return tabButton(id, labels[id], { onContextMenu: (e) => openContextMenu(id, e) });
  }

  useEffect(() => {
    if (!trashOpen) return;
    const el = itemRefs.current.trash;
    if (el) setTrashRect(el.getBoundingClientRect());
    const sync = () => {
      const nextEl = itemRefs.current.trash;
      if (nextEl) setTrashRect(nextEl.getBoundingClientRect());
    };
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    return () => {
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync, true);
    };
  }, [trashOpen, menuItemsKey]);

  useEffect(() => {
    if (!moveId) return;
    const el = itemRefs.current[moveId];
    if (el) setMoveRect(el.getBoundingClientRect());
    const sync = () => {
      const nextEl = itemRefs.current[moveId];
      if (nextEl) setMoveRect(nextEl.getBoundingClientRect());
    };
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    return () => {
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync, true);
    };
  }, [moveId, menuItemsKey]);

  useEffect(() => {
    if (!contextMenu && !trashOpen && !moveId) return;
    const handler = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (contextMenu && contextMenuRef.current?.contains(target)) return;
      if (trashOpen && (trashPopupRef.current?.contains(target) || itemRefs.current.trash?.contains(target as Node))) return;
      if (moveId && movePopupRef.current?.contains(target)) return;
      setContextMenu(null);
      setTrashOpen(false);
      if (moveId) setMoveId(null);
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [contextMenu, moveId, trashOpen]);

  const authDot =
    props.authStatus?.online == null ? null : (
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: 999,
          display: 'inline-block',
          background: props.authStatus.online ? 'var(--success)' : 'var(--danger)',
          boxShadow: '0 0 0 2px rgba(0,0,0,0.08)',
        }}
        title={props.authStatus.online ? 'В сети' : 'Не в сети'}
      />
    );

  return (
    <div style={{ position: 'relative' }}>
      <div
        style={{
          display: 'flex',
          gap: 6,
          rowGap: 6,
          flexWrap: 'wrap',
          alignItems: 'center',
          marginTop: 8,
          padding: '6px 8px',
          borderRadius: 12,
          background: 'rgba(148, 163, 184, 0.2)',
          border: '1px solid rgba(148, 163, 184, 0.35)',
        }}
      >
        {groupsInUse.map((groupId) => {
          const isActive = activeGroup === groupId && !collapsedGroups.has(groupId);
          const isCollapsed = collapsedGroups.has(groupId);
          return (
            <Button
              key={groupId}
              variant="ghost"
              onClick={() => toggleGroup(groupId)}
              style={
                isActive
                  ? {
                      border: '2px solid #2563eb',
                      background: 'rgba(37, 99, 235, 0.15)',
                      color: '#1d4ed8',
                      fontWeight: 800,
                    }
                  : {
                      border: '1px solid rgba(37, 99, 235, 0.35)',
                      background: theme.colors.surface2,
                      color: '#334155',
                    }
              }
              title={isCollapsed ? 'Развернуть отдел' : 'Свернуть отдел'}
            >
              {`${GROUP_LABELS[groupId]} ${isCollapsed ? '▸' : '▾'}`}
            </Button>
          );
        })}
        <span style={{ flex: 1 }} />
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {authDot}
          {tabButton(props.userTab, props.userLabel?.trim() ? props.userLabel.trim() : 'Вход')}
        </div>
        {props.right}
      </div>

      <div
        style={{
          display: 'flex',
          gap: 6,
          rowGap: 6,
          flexWrap: 'wrap',
          alignItems: 'center',
          marginTop: 6,
          padding: '6px 8px',
          borderRadius: 12,
          background: 'rgba(148, 163, 184, 0.12)',
          border: '1px solid rgba(148, 163, 184, 0.28)',
          minHeight: 44,
        }}
      >
        {activeGroup == null ? (
          <span style={{ color: theme.colors.muted }}>Выберите отдел, чтобы показать разделы.</span>
        ) : null}
        {groupMenuItems.map((id) => (
          <div
            key={id}
            ref={(el) => {
              itemRefs.current[id] = el;
            }}
            style={{ display: 'inline-flex' }}
          >
            {menuItemButton(id)}
          </div>
        ))}
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
          {contextMenu.id !== 'trash' && (
            <Button
              variant="ghost"
              onClick={() => {
                hideTab(contextMenu.id as MenuTabId);
                setContextMenu(null);
              }}
            >
              Скрыть
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              startMove(contextMenu.id);
            }}
          >
            Переместить
          </Button>
        </div>
      )}

      {trashOpen && trashRect && (
        <div
          ref={trashPopupRef}
          style={{
            position: 'fixed',
            top: trashRect.bottom + 6,
            left: trashRect.left,
            background: theme.colors.surface2,
            border: '1px solid var(--border)',
            borderRadius: 10,
            boxShadow: '0 16px 40px rgba(15,23,42,0.18)',
            padding: 8,
            zIndex: 1900,
            minWidth: 220,
            maxWidth: 320,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <div style={{ fontWeight: 700 }}>Скрытые кнопки</div>
            <Button variant="ghost" onClick={restoreAllTabs} disabled={menuState.hidden.length === 0}>
              Восстановить
            </Button>
          </div>
          {menuState.hiddenVisible.length === 0 ? (
            <div style={{ color: theme.colors.muted }}>Нет скрытых кнопок</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {menuState.hiddenVisible.map((id) => (
                <Button key={id} variant="ghost" onClick={() => restoreTab(id)}>
                  {labels[id]}
                </Button>
              ))}
            </div>
          )}
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
          <Button variant="ghost" onClick={() => moveItem(-1)} disabled={menuItems.indexOf(moveId) <= 0}>
            ←
          </Button>
          <Button
            variant="ghost"
            onClick={() => moveItem(1)}
            disabled={menuItems.indexOf(moveId) >= menuItems.length - 1}
          >
            →
          </Button>
        </div>
      )}
    </div>
  );
}


