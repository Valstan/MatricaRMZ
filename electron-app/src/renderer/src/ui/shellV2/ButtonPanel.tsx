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
import type { ActionButtonId } from './menuActions.js';
import type { MenuButtonDescriptor, MenuSection, V2Buttons } from './v2ButtonCatalog.js';
import './buttonPanel.css';

type ButtonMenuState = { id: string; x: number; y: number; pinned: boolean } | null;

function SortableMenuButton(props: {
  btn: MenuButtonDescriptor;
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
}) {
  const [menu, setMenu] = useState<ButtonMenuState>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 6 } });
  const sensors = useSensors(...(isAndroidPlatform() ? [] : [pointerSensor]));

  const pinnedIds = useMemo(() => props.buttons.pinned.map((b) => b.id), [props.buttons.pinned]);

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

  function isPinnedId(id: string): boolean {
    return props.layout.pinned.includes(id);
  }

  function togglePin(id: string) {
    const pinned = props.layout.pinned.includes(id)
      ? props.layout.pinned.filter((x) => x !== id)
      : [...props.layout.pinned, id];
    props.onLayoutChange({ ...props.layout, pinned });
  }

  function hideButton(id: string) {
    if (props.layout.hidden.includes(id)) return;
    props.onLayoutChange({
      ...props.layout,
      hidden: [...props.layout.hidden, id],
      pinned: props.layout.pinned.filter((x) => x !== id),
    });
  }

  function restoreButton(id: string) {
    props.onLayoutChange({ ...props.layout, hidden: props.layout.hidden.filter((x) => x !== id) });
  }

  function onPinnedDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const next = reorder(pinnedIds, active.id as string, over.id as string);
    if (!next) return;
    // Пере-упорядочиваем только ВИДИМЫЕ id, не выбрасывая скрытые/недоступные в
    // этом релизе: раньше запись отфильтрованного списка молча стирала пины при
    // id-чурне между релизами — они обязаны вернуться вместе со своим id.
    const visible = new Set(pinnedIds);
    let k = 0;
    const merged = props.layout.pinned.map((id) => (visible.has(id) ? next[k++]! : id));
    for (; k < next.length; k += 1) merged.push(next[k]!);
    props.onLayoutChange({ ...props.layout, pinned: merged });
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

  const renderButton = (btn: MenuButtonDescriptor, pinned: boolean) => (
    <SortableMenuButton
      key={btn.id}
      btn={btn}
      active={btn.kind === 'nav' && props.activeMenuTab === btn.id}
      listOpen={btn.kind === 'nav' && props.listOpenTab === btn.id}
      pinned={pinned}
      onClick={() => {
        if (btn.kind === 'nav') props.onTab(btn.id as MenuTabId);
        else props.onAction(btn.id as ActionButtonId);
      }}
      onTogglePin={() => togglePin(btn.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ id: btn.id, x: e.clientX, y: e.clientY, pinned: isPinnedId(btn.id) });
      }}
    />
  );

  return (
    <div className="v2-button-panel" onClick={() => { if (menu) closeMenu(); }}>
      {/* Закреплённая область — всегда видна и развёрнута, живёт ВНЕ скролла:
          при прокрутке остальных секций остаётся наверху (владелец 2026-08-11). */}
      {props.buttons.pinned.length > 0 && (
        <div className="v2-button-panel-fixed">
          <div className="v2-section-header v2-section-pinned-header" data-pinned="1">
            <span className="v2-section-header-label">Закреплённые</span>
          </div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onPinnedDragEnd}>
            <SortableContext items={pinnedIds} strategy={verticalListSortingStrategy}>
              <div className="v2-button-section v2-button-section-pinned">
                {props.buttons.pinned.map((btn) => renderButton(btn, true))}
              </div>
            </SortableContext>
          </DndContext>
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
                    {section.items.map((btn) => renderButton(btn, isPinnedId(btn.id)))}
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
        <div className="v2-context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="v2-footer-btn"
            onClick={() => {
              togglePin(menu.id);
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
