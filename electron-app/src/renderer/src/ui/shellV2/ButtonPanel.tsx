import React, { useMemo, useState } from 'react';
import type { V2ButtonLayout } from '@matricarmz/shared';
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

import type { MenuTabId } from '../layout/Tabs.js';
import type { V2ButtonDescriptor, V2Buttons } from './v2ButtonCatalog.js';

type ButtonMenuState = { id: MenuTabId; x: number; y: number; pinned: boolean } | null;

function SortableMenuButton(props: {
  btn: V2ButtonDescriptor;
  active: boolean;
  listOpen: boolean;
  pinned: boolean;
  sortable: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.btn.id,
    disabled: !props.sortable,
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      className="v2-menu-btn"
      data-active={props.active ? '1' : undefined}
      data-list-open={props.listOpen ? '1' : undefined}
      data-dragging={isDragging ? '1' : undefined}
      style={{ transform: CSS.Transform.toString(transform), transition: transition ?? undefined }}
      title={`${props.btn.groupLabel} → ${props.btn.label}`}
      onClick={props.onClick}
      onContextMenu={props.onContextMenu}
      {...attributes}
      {...listeners}
    >
      <span className="v2-menu-btn-icon">{props.btn.icon}</span>
      <span className="v2-menu-btn-label">{props.btn.label}</span>
      {props.pinned ? <span className="v2-menu-btn-pin">📌</span> : null}
    </button>
  );
}

/**
 * V2 колонка 1: панель кнопок. Перетаскивание (dnd-kit) меняет личный порядок,
 * правый клик — закрепить/скрыть. Свёрнутый режим — иконки без подписей (кликабельны).
 */
export function ButtonPanel(props: {
  buttons: V2Buttons;
  layout: V2ButtonLayout;
  onLayoutChange: (next: V2ButtonLayout) => void;
  activeMenuTab: MenuTabId | null;
  listOpenTab: MenuTabId | null;
  collapsed: boolean;
  overlayPinned: boolean;
  onToggleOverlayPinned: () => void;
  onTab: (id: MenuTabId) => void;
  onSwitchToV1: () => void;
}) {
  const [menu, setMenu] = useState<ButtonMenuState>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const mainIds = useMemo(() => props.buttons.main.map((b) => b.id), [props.buttons.main]);

  const closeMenu = () => setMenu(null);

  // Сохраняемый порядок включает закреплённые в начале: открепление возвращает
  // кнопку наверх списка, а не на дефолтное место.
  function fullOrder(main: MenuTabId[]): string[] {
    return [...props.buttons.pinned.map((b) => b.id), ...main];
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = mainIds.indexOf(active.id as MenuTabId);
    const to = mainIds.indexOf(over.id as MenuTabId);
    if (from < 0 || to < 0) return;
    const next = [...mainIds];
    const moved = next.splice(from, 1)[0];
    if (!moved) return;
    next.splice(to, 0, moved);
    props.onLayoutChange({ ...props.layout, order: fullOrder(next) });
  }

  function togglePinned(id: MenuTabId) {
    const pinned = props.layout.pinned.includes(id)
      ? props.layout.pinned.filter((x) => x !== id)
      : [...props.layout.pinned, id];
    props.onLayoutChange({ ...props.layout, pinned, order: fullOrder(mainIds) });
  }

  function hideButton(id: MenuTabId) {
    if (props.layout.hidden.includes(id)) return;
    props.onLayoutChange({
      ...props.layout,
      hidden: [...props.layout.hidden, id],
      pinned: props.layout.pinned.filter((x) => x !== id),
      order: fullOrder(mainIds),
    });
  }

  function restoreButton(id: MenuTabId) {
    props.onLayoutChange({ ...props.layout, hidden: props.layout.hidden.filter((x) => x !== id) });
  }

  const renderButton = (btn: V2ButtonDescriptor, opts: { pinned: boolean; sortable: boolean }) => (
    <SortableMenuButton
      key={btn.id}
      btn={btn}
      active={props.activeMenuTab === btn.id}
      listOpen={props.listOpenTab === btn.id}
      pinned={opts.pinned}
      sortable={opts.sortable}
      onClick={() => props.onTab(btn.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ id: btn.id, x: e.clientX, y: e.clientY, pinned: opts.pinned });
      }}
    />
  );

  if (props.collapsed) {
    const compact = [...props.buttons.pinned, ...props.buttons.main];
    return (
      <div className="v2-button-panel v2-button-panel-collapsed">
        {compact.map((btn) => (
          <button
            key={btn.id}
            type="button"
            className="v2-menu-btn v2-menu-btn-compact"
            data-active={props.activeMenuTab === btn.id ? '1' : undefined}
            data-list-open={props.listOpenTab === btn.id ? '1' : undefined}
            title={`${btn.groupLabel} → ${btn.label}`}
            onClick={() => props.onTab(btn.id)}
          >
            <span className="v2-menu-btn-icon">{btn.icon}</span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="v2-button-panel" onClick={() => { if (menu) closeMenu(); }}>
      {props.buttons.pinned.length > 0 && (
        <div className="v2-button-section">
          {props.buttons.pinned.map((btn) => renderButton(btn, { pinned: true, sortable: false }))}
          <div className="v2-button-divider" />
        </div>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={mainIds} strategy={verticalListSortingStrategy}>
          <div className="v2-button-section v2-button-section-main">
            {props.buttons.main.map((btn) => renderButton(btn, { pinned: false, sortable: true }))}
          </div>
        </SortableContext>
      </DndContext>
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
        <button
          type="button"
          className="v2-footer-btn"
          data-active={props.overlayPinned ? '1' : undefined}
          title="Панель кнопок поверх остальных колонок"
          onClick={props.onToggleOverlayPinned}
        >
          {props.overlayPinned ? '📌 Открепить панель' : '📌 Поверх колонок'}
        </button>
        <button type="button" className="v2-footer-btn" onClick={props.onSwitchToV1} title="Вернуться на старый интерфейс">
          ↩️ Старый интерфейс
        </button>
      </div>
      {menu && (
        <div className="v2-context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="v2-footer-btn"
            onClick={() => {
              togglePinned(menu.id);
              closeMenu();
            }}
          >
            {menu.pinned ? 'Открепить' : '📌 Закрепить сверху'}
          </button>
          <button
            type="button"
            className="v2-footer-btn"
            onClick={() => {
              hideButton(menu.id);
              closeMenu();
            }}
          >
            🗑 Скрыть кнопку
          </button>
        </div>
      )}
    </div>
  );
}
