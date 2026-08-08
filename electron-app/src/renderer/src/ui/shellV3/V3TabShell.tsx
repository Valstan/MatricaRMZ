import React, { useMemo } from 'react';
import { Group, Panel, Separator, type Layout, type LayoutChangedMeta } from 'react-resizable-panels';
import { shouldWarnTabsCount } from '@matricarmz/shared';

import { resolveMenuTab, type MenuTabId, type TabId } from '../layout/Tabs.js';
import { ButtonPanel } from '../shellV2/ButtonPanel.js';
import type { V2ButtonLayout } from '@matricarmz/shared';
import { buildV2Buttons } from '../shellV2/v2ButtonCatalog.js';
import type { ActionButtonId } from '../shellV2/menuActions.js';
import { useChromeVisibility } from '../shell/ChromeVisibilityContext.js';
import rmzLogo from '../../assets/logo_rmz.png';
import './shellV3.css';

const RMZ_LOGO_SRC = rmzLogo;

function suspenseFallback() {
  return (
    <div style={{ padding: 24, display: 'flex', alignItems: 'center', gap: 10, color: 'var(--muted)' }}>
      <span className="mx-spinner" style={{ width: 24, height: 24 }} aria-hidden="true" />
      Загрузка раздела...
    </div>
  );
}

export interface OpenTab {
  id: string;
  kind: 'menu' | 'list' | 'card' | 'chat' | 'ai_chat' | 'settings';
  label: string;
  tabId?: TabId;
  entityId?: string;
  cardKind?: TabId;
  canClose: boolean;
}

export function V3TabShell(props: {
  availableTabs: MenuTabId[];
  tabletOperatorMenu: boolean;
  menuLabels: Partial<Record<MenuTabId, string>>;
  buttonLayout: V2ButtonLayout;
  onButtonLayoutChange: (next: V2ButtonLayout) => void;
  collapsedSections: string[];
  onCollapsedSectionsChange: (next: string[]) => void;
  onMenuTab: (t: MenuTabId) => void;
  onAction: (id: ActionButtonId) => void;
  openTabs: OpenTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onSplitCard?: (card: OpenTab) => void;
  secondaryCard: OpenTab | null;
  renderSecondaryCard: () => React.ReactNode;
  onCloseSecondary: () => void;
  comparePct: number;
  onComparePctChange: (pct: number) => void;
  renderTabContent: (t: TabId) => React.ReactNode;
  renderChatTab?: () => React.ReactNode;
  renderAiChatTab?: () => React.ReactNode;
  renderSettingsTab?: () => React.ReactNode;
  syncState: 'idle' | 'syncing' | 'done';
  syncProgress: number | null;
  syncSummary: string | null;
  onSyncClick: () => void;
  userLabel?: string | null;
  onAccountClick?: (pos: { x: number; y: number }) => void;
}) {
  const buttons = buildV2Buttons(props.availableTabs, props.menuLabels, props.buttonLayout, props.tabletOperatorMenu);
  // Подсветка раздела в МЕНЮ идёт за АКТИВНОЙ вкладкой. Раньше бралась первая list-вкладка,
  // поэтому на карточке или другом разделе подсвечивался чужой пункт.
  const activeForMenu = props.openTabs.find(t => t.id === props.activeTabId);
  const activeMenuTab = resolveMenuTab(activeForMenu?.cardKind ?? activeForMenu?.tabId ?? 'engines');

  const chrome = useChromeVisibility();
  const setShellMounted = chrome.setShellMounted;
  React.useLayoutEffect(() => {
    setShellMounted(true);
    return () => setShellMounted(false);
  }, [setShellMounted]);
  const drawerSections = chrome.enabled;

  const menuPanel = (
    <ButtonPanel
      buttons={buttons}
      layout={props.buttonLayout}
      collapsedSections={props.collapsedSections}
      onCollapsedSectionsChange={props.onCollapsedSectionsChange}
      onLayoutChange={props.onButtonLayoutChange}
      activeMenuTab={activeMenuTab}
      listOpenTab={null}
      onTab={(t) => {
        if (drawerSections) chrome.hide('sections');
        props.onMenuTab(t);
      }}
      onAction={props.onAction}
    />
  );

  const secondary = props.secondaryCard;

  const compareLayout: Layout = useMemo(
    () => ({ 'v3-compare-primary': props.comparePct, 'v3-compare-secondary': 100 - props.comparePct }),
    [props.comparePct],
  );

  const renderTabBody = (tab: OpenTab) => {
    switch (tab.kind) {
      case 'menu':
        return <div className="v3-tab-content-menu">{menuPanel}</div>;
      case 'list':
        return tab.tabId ? (
          <div className="v3-tab-content">
            <React.Suspense fallback={suspenseFallback()}>{props.renderTabContent(tab.tabId)}</React.Suspense>
          </div>
        ) : (
          <div className="v3-list-empty">
            <div style={{ fontSize: 34 }}>🗂️</div>
            <div>Выберите раздел из МЕНЮ</div>
          </div>
        );
      case 'card':
        return tab.tabId ? (
          <div className="v3-card-body">
            <React.Suspense fallback={suspenseFallback()}>{props.renderTabContent(tab.tabId)}</React.Suspense>
          </div>
        ) : null;
      case 'chat':
        return props.renderChatTab ? (
          <div className="v3-tab-content">{props.renderChatTab()}</div>
        ) : null;
      case 'ai_chat':
        return props.renderAiChatTab ? (
          <div className="v3-tab-content">{props.renderAiChatTab()}</div>
        ) : null;
      case 'settings':
        return props.renderSettingsTab ? (
          <div className="v3-tab-content">{props.renderSettingsTab()}</div>
        ) : null;
      default:
        return null;
    }
  };

  const activeTab = props.openTabs.find(t => t.id === props.activeTabId);
  const hasSecondary = secondary != null;
  const showCompare = hasSecondary && activeTab?.kind === 'card';

  return (
    <div className="v3-shell">
      <div className="v3-tab-strip" role="tablist">
        <img
          src={RMZ_LOGO_SRC}
          alt="RMZ"
          className="v3-logo"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
        {props.openTabs.map((tab) => {
          const isActive = tab.id === props.activeTabId;
          const isMenu = tab.kind === 'menu';
          return (
            <div key={tab.id} className={`v3-tab ${isMenu ? 'v3-tab-menu' : ''}`} data-active={isActive ? '1' : undefined}>
              <button
                type="button"
                className="v3-tab-label"
                onClick={() => props.onSelectTab(tab.id)}
                title={tab.label}
              >
                {isMenu ? `🧱 ${tab.label}` : tab.label}
              </button>
              {tab.canClose && (
                <button
                  type="button"
                  className="v3-tab-close"
                  title="Закрыть вкладку"
                  onClick={(e) => { e.stopPropagation(); props.onCloseTab(tab.id); }}
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
        {shouldWarnTabsCount(props.openTabs.length) ? (
          <div className="v3-tabs-warning" role="alert">
            ⚠ Много вкладок — закройте отработанные.
          </div>
        ) : null}
        <div className="v3-tab-spacer" />
        {props.userLabel ? (
          <button
            type="button"
            className="v3-account-btn"
            title="Аккаунт: настройки, смена, выход"
            onClick={(e) => props.onAccountClick?.({ x: e.clientX, y: e.clientY })}
          >
            <span aria-hidden="true">👤</span>
            <span className="v3-account-name">{props.userLabel}</span>
          </button>
        ) : null}
        <div className="v3-sync" title={props.syncSummary ?? 'Синхронизация'}>
          <button
            type="button"
            className={`v3-sync-btn ${props.syncState === 'syncing' ? 'v3-sync-spinning' : ''} ${props.syncState === 'done' ? 'v3-sync-done' : ''}`}
            onClick={props.onSyncClick}
          >
            ↻
          </button>
          {props.syncState === 'syncing' && props.syncProgress != null && (
            <span className="v3-sync-pct">{props.syncProgress}%</span>
          )}
          {props.syncState === 'done' && props.syncSummary && (
            <span className="v3-sync-done-text">{props.syncSummary}</span>
          )}
        </div>
      </div>
      {showCompare && secondary ? (
        <div className="v3-card-compare">
          <Group orientation="horizontal" className="v3-split-group" defaultLayout={compareLayout}
            onLayoutChanged={(layout: Layout, meta: LayoutChangedMeta) => {
              if (!meta.isUserInteraction) return;
              const pct = layout['v3-compare-primary'];
              if (typeof pct === 'number' && Number.isFinite(pct)) props.onComparePctChange(pct);
            }}
          >
            <Panel id="v3-compare-primary" className="v3-panel-body" minSize={220}>
              <div className="v3-compare-pane">{activeTab && renderTabBody(activeTab)}</div>
            </Panel>
            <Separator className="v3-resize-handle" />
            <Panel id="v3-compare-secondary" className="v3-panel-body" minSize={220}>
              <div className="v3-compare-pane v3-compare-secondary">
                <div className="v3-compare-header">
                  <span className="v3-compare-title">{secondary.label}</span>
                  <button type="button" className="v3-tab-close" title="Закрыть вторую панель" onClick={props.onCloseSecondary}>
                    ✕
                  </button>
                </div>
                <div className="v3-card-body">
                  <React.Suspense fallback={suspenseFallback()}>{props.renderSecondaryCard()}</React.Suspense>
                </div>
              </div>
            </Panel>
          </Group>
        </div>
      ) : (
        <div className="v3-tab-body">
          {activeTab ? renderTabBody(activeTab) : null}
        </div>
      )}
    </div>
  );
}
