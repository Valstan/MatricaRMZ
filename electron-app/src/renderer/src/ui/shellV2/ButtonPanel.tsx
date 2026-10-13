import React, { useEffect, useMemo, useState } from 'react';
import { formatAppVersionLabel, type V2ButtonLayout } from '@matricarmz/shared';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { PopupLayer } from '../components/PopupLayer.js';
import { FavoriteStarButton } from '../components/FavoriteStarButton.js';
import type { MenuTabId } from '../layout/Tabs.js';
import { isAndroidPlatform } from '../platform.js';
import type { ActionButtonId } from './menuActions.js';
import type { MenuButtonDescriptor, MenuSection, V2Buttons } from './v2ButtonCatalog.js';
import './buttonPanel.css';

type ButtonMenuState = { btn: MenuButtonDescriptor; x: number; y: number } | null;

function SortableMenuButton(props: {
  btn: MenuButtonDescriptor;
  active: boolean;
  listOpen: boolean;
  isFavorite: boolean;
  onToggleFavorite: (() => void) | null;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.btn.id });
  return (
    <div
      ref={setNodeRef}
      className="v2-menu-row"
      data-dragging={isDragging ? '1' : undefined}
      style={{
        transform: CSS.Transform.toString(transform),
        transition: transition ?? undefined,
        ...(isAndroidPlatform() ? { touchAction: 'pan-y' as const } : {}),
      }}
      {...attributes}
      {...listeners}
    >
      <button
        type="button"
        className="v2-menu-btn"
        data-active={props.active ? '1' : undefined}
        data-list-open={props.listOpen ? '1' : undefined}
        title={`${props.btn.groupLabel} → ${props.btn.label}`}
        onClick={props.onClick}
        onContextMenu={props.onContextMenu}
      >
        <span className="v2-menu-btn-icon">{props.btn.icon}</span>
        <span className="v2-menu-btn-label">{props.btn.label}</span>
      </button>
      {props.onToggleFavorite != null && props.btn.kind === 'nav' && (
        <FavoriteStarButton
          favorite={props.isFavorite}
          dataId={props.btn.id}
          title={props.isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}
          onToggle={props.onToggleFavorite}
          size={30}
        />
      )}
    </div>
  );
}

export function ButtonPanel(props: {
  buttons: V2Buttons;
  layout: V2ButtonLayout;
  collapsedSections: string[];
  onCollapsedSectionsChange: (next: string[]) => void;
  onLayoutChange: (next: V2ButtonLayout) => void;
  activeMenuTab: MenuTabId | null;
  listOpenTab: MenuTabId | null;
  onTab: (id: MenuTabId) => void;
  onAction: (id: ActionButtonId) => void;
  /** Звёздочки избранного (только nav-кнопки разделов). Пусто — звёздочек нет. */
  favoriteTabs?: readonly MenuTabId[];
  onToggleFavoriteTab?: (id: MenuTabId) => void;
}) {
  const [menu, setMenu] = useState<ButtonMenuState>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  // Версия клиента спрашивается у моста: на планшете она приходит из сборки, в Electron — от
  // самого приложения. Единственная точка показа для обеих платформ.
  const [appVersionLabel, setAppVersionLabel] = useState('');
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await window.matrica.app.version();
        if (alive && r?.ok && r.version) setAppVersionLabel(formatAppVersionLabel(r.version));
      } catch {
        /* версия — справочная строка, её отсутствие не ломает меню */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 6 } });
  const sensors = useSensors(...(isAndroidPlatform() ? [] : [pointerSensor]));

  const closeMenu = () => setMenu(null);

  function reorder<T>(ids: T[], activeId: T, overId: T): T[] | null {
    const from = ids.indexOf(activeId);
    const to = ids.indexOf(overId);
    if (from < 0 || to < 0) return null;
    const next = [...ids];
    const moved = next.splice(from, 1)[0];
    if (!moved) return null;
    next.splice(to, 0, moved);
    return next;
  }

  function hideButton(id: string) {
    if (props.layout.hidden.includes(id)) return;
    props.onLayoutChange({ ...props.layout, hidden: [...props.layout.hidden, id] });
  }

  function restoreButton(id: string) {
    props.onLayoutChange({ ...props.layout, hidden: props.layout.hidden.filter((x) => x !== id) });
  }

  function onSectionDragEnd(sectionId: string) {
    return (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const section = props.buttons.sections.find((s) => s.id === sectionId);
      if (!section) return;
      const ids = section.items.map((b) => b.id);
      const nextIds = reorder(ids, active.id as string, over.id as string);
      if (!nextIds) return;
      const nextSection: MenuSection = { ...section, items: nextIds.map((id) => section.items.find((b) => b.id === id)!).filter(Boolean) };
      const nextSections = props.buttons.sections.map((s) => (s.id === sectionId ? nextSection : s));
      const newOrder = nextSections.flatMap((s) => s.items.map((b) => b.id));
      props.onLayoutChange({ ...props.layout, order: newOrder });
    };
  }

  function toggleSection(id: string) {
    // Аккордеон (решение владельца 2026-08-11): развёрнут максимум один раздел.
    // Набор «всех прочих» считается от ЖИВЫХ props.buttons.sections — состав секций
    // зависит от прав и планшетного режима, сохранённому state доверять нельзя.
    const next = props.collapsedSections.includes(id)
      ? props.buttons.sections.map((s) => s.id).filter((s) => s !== id)
      : Array.from(new Set([...props.collapsedSections, id]));
    props.onCollapsedSectionsChange(next);
  }

  // Закреплённые сверху (B8) — это избранное: отдельных пинов больше нет, блок
  // показывает разделы со звёздочкой в порядке избранного. Порядок DnD не правится —
  // он живёт в самом избранном.
  const starredButtons = useMemo(() => {
    const byId = new Map<string, MenuButtonDescriptor>();
    for (const section of props.buttons.sections) for (const btn of section.items) byId.set(btn.id, btn);
    for (const btn of props.buttons.pinned) if (!byId.has(btn.id)) byId.set(btn.id, btn);
    return (props.favoriteTabs ?? []).map((id) => byId.get(id)).filter((b): b is MenuButtonDescriptor => Boolean(b));
  }, [props.buttons.sections, props.buttons.pinned, props.favoriteTabs]);

  const renderButton = (btn: MenuButtonDescriptor) => (
    <SortableMenuButton
      key={btn.id}
      btn={btn}
      active={btn.kind === 'nav' && props.activeMenuTab === btn.id}
      listOpen={btn.kind === 'nav' && props.listOpenTab === btn.id}
      isFavorite={btn.kind === 'nav' && (props.favoriteTabs ?? []).includes(btn.id as MenuTabId)}
      onToggleFavorite={
        btn.kind === 'nav' && props.onToggleFavoriteTab ? () => props.onToggleFavoriteTab?.(btn.id as MenuTabId) : null
      }
      onClick={() => {
        if (btn.kind === 'nav') props.onTab(btn.id as MenuTabId);
        else props.onAction(btn.id as ActionButtonId);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ btn, x: e.clientX, y: e.clientY });
      }}
    />
  );

  return (
    <div className="v2-button-panel" onClick={() => { if (menu) closeMenu(); }}>
      {/* Версия — первая строка меню (просьба владельца 08.09.2026): на планшете её негде было
          увидеть вовсе, а на Windows приходилось идти в настройки. Одинаково в обоих клиентах. */}
      <div className="v2-app-version" data-app-version title="Версия программы на этом компьютере">
        {appVersionLabel || 'Версия: —'}
      </div>
      {/* Закреплённая область — всегда видна и развёрнута, живёт ВНЕ скролла:
          при прокрутке остальных секций остаётся наверху (владелец 2026-08-11).
          Состав — избранное (B8), без DnD: порядок правится самим избранным. */}
      {starredButtons.length > 0 && (
        <div className="v2-button-panel-fixed">
          <div className="v2-section-header v2-section-pinned-header" data-pinned="1">
            <span className="v2-section-header-label">Закреплённые</span>
          </div>
          <div className="v2-button-section v2-button-section-pinned">
            {starredButtons.map((btn) => renderButton(btn))}
          </div>
          <div className="v2-button-divider" />
        </div>
      )}

      <div className="v2-button-panel-scroll">
      {/* Секции навигации и действий — аккордеон: развёрнута максимум одна */}
      {props.buttons.sections.map((section) => {
        const collapsed = props.collapsedSections.includes(section.id);
        const sectionIds = section.items.map((b) => b.id);
        return (
          <div key={section.id} className="v2-menu-section" data-collapsed={collapsed ? '1' : undefined}>
            <button
              type="button"
              className="v2-section-header"
              onClick={() => toggleSection(section.id)}
              title={collapsed ? 'Развернуть' : 'Свернуть'}
            >
              <span className="v2-section-chevron">{collapsed ? '▸' : '▾'}</span>
              <span className="v2-section-header-label">{section.label}</span>
              <span className="v2-section-count">{section.items.length}</span>
            </button>
            {!collapsed && section.items.length > 0 && (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onSectionDragEnd(section.id)}>
                <SortableContext items={sectionIds} strategy={verticalListSortingStrategy}>
                  <div className="v2-button-section">
                    {section.items.map((btn) => renderButton(btn))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </div>
        );
      })}

      <div className="v2-button-footer">
        {props.buttons.hidden.length > 0 && (
          <button type="button" className="v2-footer-btn" onClick={() => setRestoreOpen((v) => !v)}>
            🗑 Скрытые ({props.buttons.hidden.length})
          </button>
        )}
        {restoreOpen && props.buttons.hidden.length > 0 && (
          <div className="v2-hidden-list">
            {props.buttons.hidden.map((btn) => (
              <button key={btn.id} type="button" className="v2-footer-btn" onClick={() => restoreButton(btn.id)}>
                {btn.icon} {btn.label} ↩
              </button>
            ))}
          </div>
        )}
      </div>
      </div>
      {menu && (
        // Портал в body: панель МЕНЮ — это `.v3-menu-overlay` со своим `z-index`,
        // и меню кнопки внутри него выше ЭТОГО слоя подняться не может (PopupLayer).
        // Пинов здесь больше нет (B8): звезда — в самой строке, ярлык — звездой.
        <PopupLayer>
          <div className="v2-context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="v2-footer-btn"
              onClick={() => {
                hideButton(menu.btn.id);
                closeMenu();
              }}
            >
              🗑 Скрыть кнопку
            </button>
          </div>
        </PopupLayer>
      )}
    </div>
  );
}
