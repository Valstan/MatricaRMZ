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
import { isAndroidPlatform } from '../platform.js';
import type { V2ButtonDescriptor, V2Buttons } from './v2ButtonCatalog.js';
// Стили панели живут рядом с компонентом, а не в оболочке: прежний общий shellV2.css
// импортировался снесённой v2-оболочкой и после её удаления (#398) осиротел — панель
// полсуток рендерилась голыми браузерными кнопками.
import './buttonPanel.css';

type ButtonMenuState = { id: MenuTabId; x: number; y: number; pinned: boolean } | null;

function SortableMenuButton(props: {
  btn: V2ButtonDescriptor;
  active: boolean;
  listOpen: boolean;
  pinned: boolean;
  onClick: () => void;
  onTogglePin: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.btn.id });
  return (
    <div
      ref={setNodeRef}
      className="v2-menu-row"
      data-dragging={isDragging ? '1' : undefined}
      // На планшете строка обязана прокручиваться пальцем: `touch-action: none` из
      // buttonPanel.css нужен только перетаскиванию, а его на Android нет (см. sensors).
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
      <button
        type="button"
        className="v2-menu-pin"
        data-pinned={props.pinned ? '1' : undefined}
        title={props.pinned ? 'Открепить' : 'Закрепить наверху'}
        onClick={props.onTogglePin}
      >
        📌
      </button>
    </div>
  );
}

/**
 * Колонка «РАЗДЕЛЫ»: вертикальный список кнопок одинаковой ширины. Перетаскивание
 * (dnd-kit) меняет личный порядок — отдельно в закреплённой группе сверху и отдельно
 * в основной; 📌 закрепляет/открепляет, правый клик — то же плюс «скрыть».
 * Раскладка персистится в аккаунте оператора (ui:prefs, ключ — userId).
 */
export function ButtonPanel(props: {
  buttons: V2Buttons;
  layout: V2ButtonLayout;
  onLayoutChange: (next: V2ButtonLayout) => void;
  activeMenuTab: MenuTabId | null;
  listOpenTab: MenuTabId | null;
  onTab: (id: MenuTabId) => void;
}) {
  const [menu, setMenu] = useState<ButtonMenuState>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  // Перетаскивание разделов — только мышью. На планшете сенсор отключён: он держит
  // строку под `touch-action: none`, и панель перестаёт скроллиться пальцем, а сама
  // панель там выдвижная (свайп по ней закрывает её, а не тащит кнопку).
  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 6 } });
  const sensors = useSensors(...(isAndroidPlatform() ? [] : [pointerSensor]));

  const pinnedIds = useMemo(() => props.buttons.pinned.map((b) => b.id), [props.buttons.pinned]);
  const mainIds = useMemo(() => props.buttons.main.map((b) => b.id), [props.buttons.main]);

  const closeMenu = () => setMenu(null);

  function reorder(ids: MenuTabId[], activeId: MenuTabId, overId: MenuTabId): MenuTabId[] | null {
    const from = ids.indexOf(activeId);
    const to = ids.indexOf(overId);
    if (from < 0 || to < 0) return null;
    const next = [...ids];
    const moved = next.splice(from, 1)[0];
    if (!moved) return null;
    next.splice(to, 0, moved);
    return next;
  }

  // Сохраняемый порядок включает закреплённые в начале: открепление возвращает
  // кнопку наверх списка, а не на дефолтное место.
  function fullOrder(pinned: string[], main: string[]): string[] {
    return [...pinned, ...main];
  }

  function onMainDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const next = reorder(mainIds, active.id as MenuTabId, over.id as MenuTabId);
    if (next) props.onLayoutChange({ ...props.layout, order: fullOrder(pinnedIds, next) });
  }

  function onPinnedDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const next = reorder(pinnedIds, active.id as MenuTabId, over.id as MenuTabId);
    if (next) props.onLayoutChange({ ...props.layout, pinned: next, order: fullOrder(next, mainIds) });
  }

  function togglePinned(id: MenuTabId) {
    const pinned = props.layout.pinned.includes(id)
      ? props.layout.pinned.filter((x) => x !== id)
      : [...props.layout.pinned, id];
    // Порядок пишем по текущему видимому (закреплённые + основные): открепление
    // возвращает кнопку наверх основного списка, а не на дефолтное место.
    props.onLayoutChange({ ...props.layout, pinned, order: fullOrder(pinnedIds, mainIds) });
  }

  function hideButton(id: MenuTabId) {
    if (props.layout.hidden.includes(id)) return;
    props.onLayoutChange({
      ...props.layout,
      hidden: [...props.layout.hidden, id],
      pinned: props.layout.pinned.filter((x) => x !== id),
      order: fullOrder(pinnedIds, mainIds),
    });
  }

  function restoreButton(id: MenuTabId) {
    props.onLayoutChange({ ...props.layout, hidden: props.layout.hidden.filter((x) => x !== id) });
  }

  const renderButton = (btn: V2ButtonDescriptor, opts: { pinned: boolean }) => (
    <SortableMenuButton
      key={btn.id}
      btn={btn}
      active={props.activeMenuTab === btn.id}
      listOpen={props.listOpenTab === btn.id}
      pinned={opts.pinned}
      onClick={() => props.onTab(btn.id)}
      onTogglePin={() => togglePinned(btn.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ id: btn.id, x: e.clientX, y: e.clientY, pinned: opts.pinned });
      }}
    />
  );

  return (
    <div className="v2-button-panel" onClick={() => { if (menu) closeMenu(); }}>
      {props.buttons.pinned.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onPinnedDragEnd}>
          <SortableContext items={pinnedIds} strategy={verticalListSortingStrategy}>
            <div className="v2-button-section v2-button-section-pinned">
              {props.buttons.pinned.map((btn) => renderButton(btn, { pinned: true }))}
            </div>
          </SortableContext>
        </DndContext>
      )}
      {props.buttons.pinned.length > 0 && <div className="v2-button-divider" />}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onMainDragEnd}>
        <SortableContext items={mainIds} strategy={verticalListSortingStrategy}>
          <div className="v2-button-section v2-button-section-main">
            {props.buttons.main.map((btn) => renderButton(btn, { pinned: false }))}
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
