import React from 'react';
import { v3ShowTabsWarning } from '@matricarmz/shared';

import { resolveMenuTab, type MenuTabId, type TabId } from '../layout/Tabs.js';
import { ButtonPanel } from '../shellV2/ButtonPanel.js';
import type { V2ButtonLayout } from '@matricarmz/shared';
import { V2_LIST_TABS, buildV2Buttons } from '../shellV2/v2ButtonCatalog.js';
import './shellV3.css';

function suspenseFallback() {
  return <div style={{ padding: 16, color: 'var(--muted)' }}>Загрузка раздела...</div>;
}

/**
 * V3 shell («Вкладки»): одно окно с панелью вкладок.
 * Две закреплённые вкладки — «РАЗДЕЛЫ» (¼ слева) и «Список …» (¾ справа) — делят экран
 * в сплит-режиме; карточка открывается собственной вкладкой на весь экран, при этом
 * сплит остаётся смонтированным (display:none) и не теряет наполнение/скролл/фокус.
 */
export function V3TabShell(props: {
  availableTabs: MenuTabId[];
  tabletOperatorMenu: boolean;
  menuLabels: Partial<Record<MenuTabId, string>>;
  buttonLayout: V2ButtonLayout;
  onButtonLayoutChange: (next: V2ButtonLayout) => void;
  tab: TabId;
  activeListTab: TabId | null;
  onMenuTab: (t: MenuTabId) => void;
  renderTabContent: (t: TabId) => React.ReactNode;
  onSwitchToV2: () => void;
  openCards: Array<{ kind: TabId; entityId: string; title: string }>;
  focusedCardKey: string | null;
  onFocusCard: (card: { kind: TabId; entityId: string }) => void;
  onCloseCard: (card: { kind: TabId; entityId: string }) => void;
  /** Фокус на закреплённых вкладках (карточка при этом остаётся смонтированной, но скрыта). */
  pinnedFocus: boolean;
  /** Вернуть фокус со вкладки-карточки на закреплённые (список/разделы). */
  onFocusPinned: () => void;
}) {
  const buttons = buildV2Buttons(props.availableTabs, props.menuLabels, props.buttonLayout, props.tabletOperatorMenu);
  const listTab = props.activeListTab && V2_LIST_TABS.has(props.activeListTab) ? props.activeListTab : null;
  const listLabel = listTab ? (props.menuLabels[resolveMenuTab(listTab) as MenuTabId] ?? String(listTab)) : null;
  const activeMenuTab = resolveMenuTab(props.tab);
  const listOpenTab = listTab ? resolveMenuTab(listTab) : null;

  // Fullscreen-контент = любой НЕ-списочный tab: карточка (focusedCardKey задан) либо
  // обычная страница (История/Настройки/Заметки/…). Активен он, только когда фокус не
  // уведён на закреплённые: при pinnedFocus контент остаётся смонтированным (несохранённые
  // правки/скролл живы), но скрыт.
  const pageMounted = !V2_LIST_TABS.has(props.tab);
  const cardFocused = pageMounted && props.focusedCardKey != null;
  const cardActive = pageMounted && !props.pinnedFocus;
  const workspaceTab = pageMounted ? props.tab : null;
  // Страница без карточки (Настройки/История/…) — эфемерная вкладка со своим заголовком.
  const pageLabel = pageMounted && !cardFocused
    ? (props.menuLabels[resolveMenuTab(props.tab) as MenuTabId] ?? String(props.tab))
    : null;

  return (
    <div className="v3-shell">
      <div className="v3-tab-strip" role="tablist">
        <button
          type="button"
          className="v3-tab v3-tab-pinned"
          data-active={!cardActive ? '1' : undefined}
          onClick={props.onFocusPinned}
          title="Разделы программы"
        >
          РАЗДЕЛЫ
        </button>
        <button
          type="button"
          className="v3-tab v3-tab-pinned"
          data-active={!cardActive && listTab ? '1' : undefined}
          onClick={props.onFocusPinned}
          title={listLabel ? `Список: ${listLabel}` : 'Список не открыт'}
        >
          {listLabel ? `Список ${listLabel}` : 'Список …'}
        </button>
        {pageLabel && (
          <button
            type="button"
            className="v3-tab v3-tab-page"
            data-active={cardActive ? '1' : undefined}
            onClick={() => {}}
            title={pageLabel}
          >
            📄 {pageLabel}
          </button>
        )}
        {props.openCards.map((card) => {
          const key = `${card.kind}:${card.entityId}`;
          const active = cardActive && cardFocused && key === props.focusedCardKey;
          return (
            <div key={key} className="v3-tab v3-tab-card" data-active={active ? '1' : undefined} title={card.title}>
              <button
                type="button"
                className="v3-tab-label"
                onClick={() => { if (!active) props.onFocusCard(card); }}
              >
                {card.title}
              </button>
              <button
                type="button"
                className="v3-tab-close"
                title="Закрыть карточку"
                onClick={() => props.onCloseCard(card)}
              >
                ✕
              </button>
            </div>
          );
        })}
        {v3ShowTabsWarning(props.openCards.length) && (
          <div className="v3-tabs-warning" role="alert">
            ⚠ Открытых вкладок многовато — закройте отработанные, чтобы не наплодить конфликтов и не забыть сохранить.
          </div>
        )}
      </div>
      {/* Сплит «РАЗДЕЛЫ ¼ | Список ¾» всегда смонтирован — скрывается, когда активна карточка. */}
      <div className="v3-split" style={cardActive ? { display: 'none' } : undefined}>
        <div className="v3-split-sections">
          <ButtonPanel
            buttons={buttons}
            layout={props.buttonLayout}
            onLayoutChange={props.onButtonLayoutChange}
            activeMenuTab={activeMenuTab}
            listOpenTab={listOpenTab}
            collapsed={false}
            overlayPinned={false}
            onToggleOverlayPinned={() => {}}
            onTab={props.onMenuTab}
            onSwitchToV1={props.onSwitchToV2}
          />
        </div>
        <div className="v3-split-list">
          {listTab ? (
            <React.Suspense fallback={suspenseFallback()}>{props.renderTabContent(listTab)}</React.Suspense>
          ) : (
            <div className="v3-list-empty">
              <div style={{ fontSize: 34 }}>🗂️</div>
              <div>Выберите раздел слева — список откроется здесь.</div>
            </div>
          )}
        </div>
      </div>
      {workspaceTab && (
        <div className="v3-card-body" style={!cardActive ? { display: 'none' } : undefined}>
          <React.Suspense fallback={suspenseFallback()}>{props.renderTabContent(workspaceTab)}</React.Suspense>
        </div>
      )}
    </div>
  );
}
