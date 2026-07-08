import React, { useMemo, useRef } from 'react';
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import type { V2ColumnId, V2Prefs } from '@matricarmz/shared';

import { resolveMenuTab, type MenuTabId, type TabId } from '../layout/Tabs.js';
import { ButtonPanel } from './ButtonPanel.js';
import { V2_LIST_TABS, buildV2Buttons } from './v2ButtonCatalog.js';
import './shellV2.css';

const COLLAPSED_STRIP_TITLES: Record<V2ColumnId, string> = {
  buttons: 'Меню',
  lists: 'Список',
  workspace: 'Рабочая область',
};

function suspenseFallback() {
  return <div style={{ padding: 16, color: 'var(--muted)' }}>Загрузка раздела...</div>;
}

/**
 * V2 shell («Трезубец»): 3 колонки — кнопки | списки | рабочая область.
 * Колонки резиновые (react-resizable-panels), сворачиваются в полоску,
 * ширины/состояние персистятся per-user через onPrefsChange.
 */
export function V2Shell(props: {
  prefs: V2Prefs;
  onPrefsChange: (next: V2Prefs) => void;
  availableTabs: MenuTabId[];
  menuLabels: Partial<Record<MenuTabId, string>>;
  tab: TabId;
  activeListTab: TabId | null;
  onMenuTab: (t: MenuTabId) => void;
  onCloseListColumn: () => void;
  renderTabContent: (t: TabId) => React.ReactNode;
  onSwitchToV1: () => void;
  openCards: Array<{ kind: TabId; entityId: string; title: string }>;
  focusedCardKey: string | null;
  onFocusCard: (card: { kind: TabId; entityId: string }) => void;
  onCloseCard: (card: { kind: TabId; entityId: string }) => void;
  secondaryCard: { kind: TabId; entityId: string; title: string } | null;
  renderSecondaryCard: () => React.ReactNode;
  onSplitCard: (card: { kind: TabId; entityId: string; title: string }) => void;
  onCloseSecondary: () => void;
}) {
  const { prefs } = props;
  const saveTimer = useRef<number | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const buttons = useMemo(
    () => buildV2Buttons(props.availableTabs, props.menuLabels, prefs.buttonLayout),
    [props.availableTabs, props.menuLabels, prefs.buttonLayout],
  );

  // Рабочая область показывает карточку/страницу; если фокус на списке — заглушку.
  const workspaceTab = V2_LIST_TABS.has(props.tab) ? null : props.tab;
  const listTab = props.activeListTab && V2_LIST_TABS.has(props.activeListTab) ? props.activeListTab : null;
  const activeMenuTab = resolveMenuTab(props.tab);
  const listOpenTab = listTab ? resolveMenuTab(listTab) : null;

  const overlayPinned = prefs.buttonPanelPinned;
  const columnsInGroup: V2ColumnId[] = prefs.columnOrder.filter((id) => {
    if (prefs.columns[id].collapsed) return false;
    if (id === 'lists' && !listTab) return false;
    if (id === 'buttons' && overlayPinned) return false;
    return true;
  });
  const groupKey = columnsInGroup.join('|');

  function scheduleSave(next: V2Prefs) {
    prefsRef.current = next;
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      props.onPrefsChange(prefsRef.current);
    }, 400);
  }

  // Layout карты react-resizable-panels v4: { panelId: flexGrow } — пропорции колонок.
  // groupKey меняется при смене набора видимых колонок; Group ремоунтится по key,
  // поэтому пересчитывать layout на каждый чих prefs не нужно.
  const defaultLayout: Layout = useMemo(
    () => Object.fromEntries(prefsRef.current.columnOrder.filter((id) => columnsInGroup.includes(id)).map((id) => [id, prefsRef.current.columns[id].sizePct])),
    [groupKey],
  );

  function onLayoutChanged(layout: Layout, meta: { isUserInteraction: boolean }) {
    if (!meta.isUserInteraction) return;
    const next: V2Prefs = { ...prefsRef.current, columns: { ...prefsRef.current.columns } };
    for (const id of columnsInGroup) {
      const size = layout[id];
      if (typeof size === 'number' && Number.isFinite(size)) {
        next.columns[id] = { ...next.columns[id], sizePct: size };
      }
    }
    scheduleSave(next);
  }

  function setCollapsed(id: V2ColumnId, collapsed: boolean) {
    // Нельзя свернуть последнюю развёрнутую колонку — иначе пустой экран.
    if (collapsed && columnsInGroup.filter((x) => x !== id).length === 0) return;
    const next: V2Prefs = {
      ...prefs,
      columns: { ...prefs.columns, [id]: { ...prefs.columns[id], collapsed } },
    };
    props.onPrefsChange(next);
  }

  function setButtonLayout(buttonLayout: V2Prefs['buttonLayout']) {
    props.onPrefsChange({ ...prefs, buttonLayout });
  }

  function toggleOverlayPinned() {
    props.onPrefsChange({ ...prefs, buttonPanelPinned: !prefs.buttonPanelPinned });
  }

  const buttonPanel = (
    <ButtonPanel
      buttons={buttons}
      layout={prefs.buttonLayout}
      onLayoutChange={setButtonLayout}
      activeMenuTab={activeMenuTab}
      listOpenTab={listOpenTab}
      collapsed={false}
      overlayPinned={overlayPinned}
      onToggleOverlayPinned={toggleOverlayPinned}
      onTab={props.onMenuTab}
      onSwitchToV1={props.onSwitchToV1}
    />
  );

  function renderColumnBody(id: V2ColumnId) {
    if (id === 'buttons') {
      return (
        <div className="v2-col v2-col-buttons">
          <div className="v2-col-header">
            <span className="v2-col-title">Меню</span>
            <button type="button" className="v2-col-tool" title="Свернуть панель" onClick={() => setCollapsed('buttons', true)}>
              ⇤
            </button>
          </div>
          {buttonPanel}
        </div>
      );
    }
    if (id === 'lists') {
      return (
        <div className="v2-col v2-col-lists">
          <div className="v2-col-header">
            <span className="v2-col-title">
              {listTab ? `📋 ${props.menuLabels[listTab as MenuTabId] ?? listTab}` : 'Список'}
            </span>
            <button type="button" className="v2-col-tool" title="Свернуть колонку" onClick={() => setCollapsed('lists', true)}>
              ⇤
            </button>
            <button type="button" className="v2-col-tool" title="Закрыть список" onClick={props.onCloseListColumn}>
              ✕
            </button>
          </div>
          <div className="v2-col-body">
            <React.Suspense fallback={suspenseFallback()}>{listTab ? props.renderTabContent(listTab) : null}</React.Suspense>
          </div>
        </div>
      );
    }
    const secondary = props.secondaryCard;
    const secondaryKey = secondary ? `${secondary.kind}:${secondary.entityId}` : null;
    const primaryBody = workspaceTab ? (
      props.renderTabContent(workspaceTab)
    ) : (
      <div className="v2-workspace-empty">
        <div style={{ fontSize: 34 }}>🗂️</div>
        <div>Выберите элемент из списка — карточка откроется здесь.</div>
      </div>
    );
    return (
      <div className="v2-col v2-col-workspace">
        {props.openCards.length > 0 && (
          <div className="v2-card-tabs" role="tablist">
            {props.openCards.map((card) => {
              const key = `${card.kind}:${card.entityId}`;
              const active = key === props.focusedCardKey;
              const isSecondary = key === secondaryKey;
              return (
                <div key={key} className="v2-card-tab" data-active={active ? '1' : undefined} title={card.title}>
                  <button
                    type="button"
                    className="v2-card-tab-label"
                    onClick={() => { if (!active) props.onFocusCard(card); }}
                  >
                    {card.title}
                  </button>
                  {/* ⑃ разделить: закрепить карточку во второй панели (только если это не текущая
                      левая и не уже вторая панель). */}
                  {!active && !isSecondary && (
                    <button
                      type="button"
                      className="v2-card-tab-split"
                      title="Открыть рядом (разделить)"
                      onClick={() => props.onSplitCard(card)}
                    >
                      ⑃
                    </button>
                  )}
                  <button
                    type="button"
                    className="v2-card-tab-close"
                    title="Закрыть карточку"
                    onClick={() => props.onCloseCard(card)}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {secondary ? (
          <Group orientation="horizontal" className="v2-split-group">
            <Panel id="split-primary" className="v2-panel-body" minSize={200}>
              <div className="v2-split-pane">
                <div className="v2-col-body">
                  <React.Suspense fallback={suspenseFallback()}>{primaryBody}</React.Suspense>
                </div>
              </div>
            </Panel>
            <Separator className="v2-resize-handle" />
            <Panel id="split-secondary" className="v2-panel-body" minSize={200}>
              <div className="v2-split-pane v2-split-secondary">
                <div className="v2-col-header">
                  <span className="v2-col-title">▐ {secondary.title}</span>
                  <button type="button" className="v2-col-tool" title="Закрыть вторую панель" onClick={props.onCloseSecondary}>
                    ✕
                  </button>
                </div>
                <div className="v2-col-body">
                  <React.Suspense fallback={suspenseFallback()}>{props.renderSecondaryCard()}</React.Suspense>
                </div>
              </div>
            </Panel>
          </Group>
        ) : (
          <div className="v2-col-body">
            <React.Suspense fallback={suspenseFallback()}>{primaryBody}</React.Suspense>
          </div>
        )}
      </div>
    );
  }

  function renderCollapsedStrip(id: V2ColumnId) {
    if (id === 'buttons') {
      return (
        <div key={`strip-${id}`} className="v2-strip">
          <button type="button" className="v2-col-tool" title="Развернуть панель кнопок" onClick={() => setCollapsed('buttons', false)}>
            ⇥
          </button>
          <ButtonPanel
            buttons={buttons}
            layout={prefs.buttonLayout}
            onLayoutChange={setButtonLayout}
            activeMenuTab={activeMenuTab}
            listOpenTab={listOpenTab}
            collapsed
            overlayPinned={overlayPinned}
            onToggleOverlayPinned={toggleOverlayPinned}
            onTab={props.onMenuTab}
            onSwitchToV1={props.onSwitchToV1}
          />
        </div>
      );
    }
    return (
      <div key={`strip-${id}`} className="v2-strip">
        <button
          type="button"
          className="v2-col-tool"
          title={`Развернуть: ${COLLAPSED_STRIP_TITLES[id]}`}
          onClick={() => setCollapsed(id, false)}
        >
          ⇥
        </button>
        <div className="v2-strip-label">{COLLAPSED_STRIP_TITLES[id]}</div>
      </div>
    );
  }

  // Сворачивание «в уголок»: свёрнутые колонки рендерятся полосками слева/справа от группы
  // в порядке columnOrder (полоска списков не показывается, если список не открыт).
  const strips = prefs.columnOrder.filter((id) => {
    if (id === 'buttons') return prefs.columns.buttons.collapsed && !overlayPinned;
    if (id === 'lists') return prefs.columns.lists.collapsed && !!listTab;
    return prefs.columns.workspace.collapsed;
  });

  return (
    <div className="v2-shell">
      {overlayPinned && (
        <div className="v2-overlay-buttons">
          <div className="v2-col v2-col-buttons">
            <div className="v2-col-header">
              <span className="v2-col-title">Меню 📌</span>
            </div>
            {buttonPanel}
          </div>
        </div>
      )}
      {strips.map((id) => renderCollapsedStrip(id))}
      <Group
        key={groupKey}
        orientation="horizontal"
        className="v2-panel-group"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        {columnsInGroup.map((id, i) => (
          <React.Fragment key={id}>
            {i > 0 && <Separator className="v2-resize-handle" />}
            <Panel id={id} className="v2-panel-body" minSize={id === 'buttons' ? 140 : 240}>
              {renderColumnBody(id)}
            </Panel>
          </React.Fragment>
        ))}
      </Group>
    </div>
  );
}
