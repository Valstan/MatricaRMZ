import React, { useMemo } from 'react';
import { Group, Panel, Separator, type Layout, type LayoutChangedMeta } from 'react-resizable-panels';
import { shouldWarnTabsCount } from '@matricarmz/shared';

import { resolveMenuTab, type MenuTabId, type TabId } from '../layout/Tabs.js';
import { ButtonPanel } from '../shellV2/ButtonPanel.js';
import type { V2ButtonLayout } from '@matricarmz/shared';
import { buildV2Buttons } from '../shellV2/v2ButtonCatalog.js';
import type { ActionButtonId } from '../shellV2/menuActions.js';
import { useChromeVisibility } from '../shell/ChromeVisibilityContext.js';
import { TabVisibilityProvider } from '../shell/TabVisibilityContext.js';
import { matricaPlatform } from '../platform.js';
import { shouldKeepAliveTab } from './keepAlive.js';
import rmzLogo from '../../assets/logo_rmz.png';
import './shellV3.css';

const RMZ_LOGO_SRC = rmzLogo;

/**
 * Скрытая панель не перерисовывается при изменениях сверху. Объявлена НА УРОВНЕ МОДУЛЯ:
 * тип, созданный внутри компонента, был бы новым на каждый рендер, и React перемонтировал
 * бы всё поддерево — ровно то, что keep-alive обязан предотвратить.
 */
const FrozenWhileHidden = React.memo(
  (p: { active: boolean; render: () => React.ReactNode }) => <>{p.render()}</>,
  (prev, next) => !prev.active && !next.active,
);
FrozenWhileHidden.displayName = 'FrozenWhileHidden';

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
  /** Раздел, который подсвечивается в панели МЕНЮ: «где оператор был», а не активная вкладка. */
  activeSectionTabId: TabId;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** Закрепить карточку второй панелью рядом с активной («2 рядом»). */
  onSplitCard?: (card: OpenTab) => void;
  /** Вторая панель умеет не все виды карточек — у остальных ⑃ не показываем. */
  canSplitCard?: (card: OpenTab) => boolean;
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
  // Панель МЕНЮ видна только когда активна вкладка МЕНЮ, поэтому подсвечивать надо раздел,
  // НА КОТОРОМ оператор находится (App.tab), а не активную вкладку — иначе подсветка всегда
  // указывала бы на фолбэк. Раньше бралась первая list-вкладка: на карточке или другом
  // разделе подсвечивался чужой пункт.
  const activeMenuTab = resolveMenuTab(props.activeSectionTabId);

  const chrome = useChromeVisibility();
  const setShellMounted = chrome.setShellMounted;
  React.useLayoutEffect(() => {
    setShellMounted(true);
    return () => setShellMounted(false);
  }, [setShellMounted]);

  const menuPanel = (
    <ButtonPanel
      buttons={buttons}
      layout={props.buttonLayout}
      collapsedSections={props.collapsedSections}
      onCollapsedSectionsChange={props.onCollapsedSectionsChange}
      onLayoutChange={props.onButtonLayoutChange}
      activeMenuTab={activeMenuTab}
      listOpenTab={null}
      onTab={(t) => props.onMenuTab(t)}
      onAction={props.onAction}
    />
  );

  const secondary = props.secondaryCard;

  const compareLayout: Layout = useMemo(
    () => ({ 'v3-compare-primary': props.comparePct, 'v3-compare-secondary': 100 - props.comparePct }),
    [props.comparePct],
  );

  // «Панельность» — параметр, а не свойство вида вкладки: внутри сравнения «2 рядом»
  // абсолютно позиционированная панель накрыла бы сплит (у .v3-compare-pane своя
  // раскладка), поэтому там renderTabBody зовётся с pane:false.
  const renderTabBody = (tab: OpenTab, opts: { pane: boolean; active: boolean }) => {
    const cls = (base: string) => (opts.pane ? `${base} v3-tab-pane` : base);
    const paneAttrs = opts.pane ? { 'data-pane-active': opts.active ? '1' : undefined } : {};
    // Ключ обязателен: панели рендерятся списком, и без него React сверял бы их по
    // индексу — закрытие вкладки из середины полосы переносило бы состояние живой
    // панели на соседнюю.
    const wrap = (node: React.ReactNode) =>
      opts.pane ? (
        <TabVisibilityProvider key={tab.id} visible={opts.active}>
          {node}
        </TabVisibilityProvider>
      ) : (
        node
      );
    // Suspense обязателен всем: страницы ленивые (lazyPage), и без границы React
    // отвечает «A component suspended while responding to synchronous input» и сносит
    // всё дерево — оператор видит белый экран (ловилось на «⚙️ Настройки» меню аккаунта).
    // Содержимое уходит в thunk: у скрытой панели render() не вызывается вовсе.
    const frozen = (render: () => React.ReactNode) => (
      <FrozenWhileHidden active={opts.active} render={() => <React.Suspense fallback={suspenseFallback()}>{render()}</React.Suspense>} />
    );
    switch (tab.kind) {
      case 'menu':
        return wrap(
          <div key={tab.id} className={cls('v3-tab-content-menu')} {...paneAttrs}>
            {menuPanel}
          </div>,
        );
      case 'list':
        return wrap(
          tab.tabId ? (
            <div key={tab.id} className={cls('v3-tab-content ui-content-viewport')} {...paneAttrs}>
              {frozen(() => props.renderTabContent(tab.tabId as TabId))}
            </div>
          ) : (
            <div key={tab.id} className={cls('v3-list-empty')} {...paneAttrs}>
              <div style={{ fontSize: 34 }}>🗂️</div>
              <div>Выберите раздел из МЕНЮ</div>
            </div>
          ),
        );
      case 'card':
        return tab.tabId
          ? wrap(
              <div key={tab.id} className={cls('v3-card-body')} {...paneAttrs}>
                {frozen(() => props.renderTabContent(tab.tabId as TabId))}
              </div>,
            )
          : null;
      case 'chat':
        return props.renderChatTab
          ? wrap(
              <div key={tab.id} className={cls('v3-tab-content ui-content-viewport')} {...paneAttrs}>
                {frozen(() => props.renderChatTab?.())}
              </div>,
            )
          : null;
      case 'ai_chat':
        return props.renderAiChatTab
          ? wrap(
              <div key={tab.id} className={cls('v3-tab-content ui-content-viewport')} {...paneAttrs}>
                {frozen(() => props.renderAiChatTab?.())}
              </div>,
            )
          : null;
      case 'settings':
        return props.renderSettingsTab
          ? wrap(
              <div key={tab.id} className={cls('v3-tab-content ui-content-viewport')} {...paneAttrs}>
                {frozen(() => props.renderSettingsTab?.())}
              </div>,
            )
          : null;
      default:
        return null;
    }
  };

  const activeTab = props.openTabs.find(t => t.id === props.activeTabId);
  const hasSecondary = secondary != null;
  const showCompare = hasSecondary && activeTab?.kind === 'card';

  // Ленивый набор живых панелей: вкладка попадает сюда, только когда её впервые
  // открыли (восстановленная сессия из восьми вкладок не монтирует восемь страниц
  // на старте). Мутация ref идемпотентна и безопасна в StrictMode; render-phase
  // setState дал бы лишний рендер и мигание.
  const aliveRef = React.useRef<Set<string>>(new Set());
  if (activeTab && shouldKeepAliveTab(matricaPlatform(), activeTab.kind)) {
    aliveRef.current.add(activeTab.id);
  }
  const openIds = new Set(props.openTabs.map((t) => t.id));
  for (const id of aliveRef.current) {
    if (!openIds.has(id)) aliveRef.current.delete(id);
  }
  const alivePanes = props.openTabs.filter((t) => aliveRef.current.has(t.id));
  const activeIsAlive = activeTab != null && aliveRef.current.has(activeTab.id);

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
          const isSecondary = secondary != null && secondary.id === tab.id;
          // ⑃ показываем, только когда клик действительно даст сравнение: рядом можно
          // закрепить лишь карточку, и лишь когда активна ДРУГАЯ карточка (иначе панель
          // сравнения не рендерится и кнопка была бы молча мёртвой).
          const canSplit =
            tab.kind === 'card' &&
            !isActive &&
            !isSecondary &&
            activeTab?.kind === 'card' &&
            props.onSplitCard != null &&
            (props.canSplitCard?.(tab) ?? true);
          return (
            <div key={tab.id} className={`v3-tab ${isMenu ? 'v3-tab-menu' : ''}`} data-active={isActive ? '1' : undefined}>
              <button
                type="button"
                className="v3-tab-label"
                onClick={() => props.onSelectTab(tab.id)}
                title={isSecondary ? `${tab.label} — открыта во второй панели` : tab.label}
              >
                {isMenu ? `🧱 ${tab.label}` : isSecondary ? `▐ ${tab.label}` : tab.label}
              </button>
              {canSplit && (
                <button
                  type="button"
                  className="v3-tab-split"
                  title="Открыть рядом для сравнения (пополам)"
                  onClick={(e) => { e.stopPropagation(); props.onSplitCard?.(tab); }}
                >
                  ⑃
                </button>
              )}
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
      {/* Сравнение живёт ВНУТРИ общего контейнера: будь оно другой веткой тернарника,
          включение «2 рядом» размонтировало бы все живые панели разом. */}
      <div className="v3-tab-body">
        {alivePanes.map((t) =>
          renderTabBody(t, { pane: true, active: !showCompare && t.id === props.activeTabId }),
        )}
        {showCompare && secondary ? (
          <div key="v3-compare" className="v3-card-compare v3-tab-pane" data-pane-active="1">
            <Group orientation="horizontal" className="v3-split-group" defaultLayout={compareLayout}
              onLayoutChanged={(layout: Layout, meta: LayoutChangedMeta) => {
                if (!meta.isUserInteraction) return;
                const pct = layout['v3-compare-primary'];
                if (typeof pct === 'number' && Number.isFinite(pct)) props.onComparePctChange(pct);
              }}
            >
              <Panel id="v3-compare-primary" className="v3-panel-body" minSize={220}>
                <div className="v3-compare-pane">{activeTab && renderTabBody(activeTab, { pane: false, active: true })}</div>
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
        ) : activeTab && !activeIsAlive ? (
          renderTabBody(activeTab, { pane: true, active: true })
        ) : null}
      </div>
    </div>
  );
}
