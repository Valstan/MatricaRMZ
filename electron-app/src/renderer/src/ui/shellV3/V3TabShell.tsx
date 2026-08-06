import React, { useMemo } from 'react';
import { Group, Panel, Separator, type Layout, type LayoutChangedMeta } from 'react-resizable-panels';
import { v3ShowTabsWarning } from '@matricarmz/shared';

import { resolveMenuTab, type MenuTabId, type TabId } from '../layout/Tabs.js';
import { ButtonPanel } from '../shellV2/ButtonPanel.js';
import type { V2ButtonLayout } from '@matricarmz/shared';
import { V2_LIST_TABS, buildV2Buttons } from '../shellV2/v2ButtonCatalog.js';
import { ChromeDrawer } from '../shell/ChromeDrawer.js';
import { useChromeVisibility } from '../shell/ChromeVisibilityContext.js';
import './shellV3.css';

/**
 * Дефолтная ширина колонки «РАЗДЕЛЫ» — ровно под кнопку раздела (самая длинная подпись
 * каталога + иконка + 📌), остаток уходит списку. Оператор растягивает разделителем,
 * выбранная ширина персистится (`sectionsPct`) и с этого момента главнее дефолта.
 */
const V3_SECTIONS_DEFAULT_WIDTH_PX = 236;

function suspenseFallback() {
  return (
    <div style={{ padding: 24, display: 'flex', alignItems: 'center', gap: 10, color: 'var(--muted)' }}>
      <span className="mx-spinner" style={{ width: 24, height: 24 }} aria-hidden="true" />
      Загрузка раздела...
    </div>
  );
}

/**
 * V3 shell («Вкладки»): одно окно с панелью вкладок.
 * Две закреплённые вкладки — «РАЗДЕЛЫ» и «Список …» — делят экран в сплит-режиме
 * (разделитель тянется мышкой, ширина персистится); карточка открывается собственной
 * вкладкой на весь экран, при этом сплит остаётся смонтированным (display:none) и не
 * теряет наполнение/скролл/фокус. Кнопка ⑃ на вкладке карточки открывает её второй
 * панелью рядом с активной — сравнение «2 рядом» (дефолт пополам, разделитель тянется).
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
  openCards: Array<{ kind: TabId; entityId: string; title: string }>;
  focusedCardKey: string | null;
  onFocusCard: (card: { kind: TabId; entityId: string }) => void;
  onCloseCard: (card: { kind: TabId; entityId: string }) => void;
  /** Лимит вкладок достигнут — открытие заблокировано, показать красное уведомление. */
  limitNotice: boolean;
  /** Фокус на закреплённых вкладках (карточка при этом остаётся смонтированной, но скрыта). */
  pinnedFocus: boolean;
  /** Вернуть фокус со вкладки-карточки на закреплённые (список/разделы). */
  onFocusPinned: () => void;
  /** Вернуть фокус на эфемерную вкладку-страницу (клик по её шапке при pinnedFocus). */
  onFocusPage: () => void;
  /** Закрыть эфемерную вкладку-страницу (Настройки/История/…) — вернуться к списку. */
  onClosePage: () => void;
  /** Сравнение «2 рядом»: вторая (правая) карточка. */
  secondaryCard: { kind: TabId; entityId: string; title: string } | null;
  renderSecondaryCard: () => React.ReactNode;
  onSplitCard: (card: { kind: TabId; entityId: string; title: string }) => void;
  onCloseSecondary: () => void;
  /** Ширина «РАЗДЕЛЫ» в сплите закреплённых, % (персистится; null — по ширине кнопок). */
  sectionsPct: number | null;
  onSectionsPctChange: (pct: number) => void;
  /** Ширина левой карточки в сравнении «2 рядом», % (персистится). */
  comparePct: number;
  onComparePctChange: (pct: number) => void;
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

  const secondary = props.secondaryCard;
  const secondaryKey = secondary ? `${secondary.kind}:${secondary.entityId}` : null;

  // defaultSize читается панелью один раз на маунт; во время drag'а source of truth у
  // самих панелей — пересборка на каждое изменение pct вызвала бы прыжки. Стейл сознательный.
  // Ширину «по кнопкам» переводим в проценты от окна: панель живёт в одних единицах
  // и на маунте, и после перетаскивания.
  const sectionsDefaultSize = useMemo(
    () =>
      props.sectionsPct != null
        ? `${props.sectionsPct}%`
        : `${Math.min(60, (V3_SECTIONS_DEFAULT_WIDTH_PX / Math.max(600, window.innerWidth)) * 100)}%`,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const compareLayout: Layout = useMemo(
    () => ({ 'v3-compare-primary': props.comparePct, 'v3-compare-secondary': 100 - props.comparePct }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [secondaryKey],
  );

  const workspaceBody = workspaceTab && (
    <React.Suspense fallback={suspenseFallback()}>{props.renderTabContent(workspaceTab)}</React.Suspense>
  );

  // Планшетный режим: «РАЗДЕЛЫ» перестают быть колонкой сплита и становятся выдвижной
  // панелью поверх данных — список занимает всю ширину, а разделы доступны и из карточки
  // (в сплит-раскладке они прячутся вместе с ним). Сплит с Group/Panel остаётся ровно
  // прежним на десктопе: ветки соседние, десктопная не переписывается.
  const chrome = useChromeVisibility();
  const setShellMounted = chrome.setShellMounted;
  // useLayoutEffect, а не useEffect: режим включается до первой отрисовки, иначе
  // сплит-раскладка успевает мигнуть перед переходом на выдвижную панель.
  React.useLayoutEffect(() => {
    setShellMounted(true);
    return () => setShellMounted(false);
  }, [setShellMounted]);
  const drawerSections = chrome.enabled;

  const sectionsPanel = (
    <ButtonPanel
      buttons={buttons}
      layout={props.buttonLayout}
      onLayoutChange={props.onButtonLayoutChange}
      activeMenuTab={activeMenuTab}
      listOpenTab={listOpenTab}
      onTab={(t) => {
        if (drawerSections) chrome.hide('sections');
        props.onMenuTab(t);
      }}
    />
  );

  const listBody = listTab ? (
    <React.Suspense fallback={suspenseFallback()}>{props.renderTabContent(listTab)}</React.Suspense>
  ) : (
    <div className="v3-list-empty">
      <div style={{ fontSize: 34 }}>🗂️</div>
      <div>Выберите раздел слева — список откроется здесь.</div>
    </div>
  );

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
          <div className="v3-tab v3-tab-card v3-tab-page" data-active={cardActive ? '1' : undefined} title={pageLabel}>
            <button
              type="button"
              className="v3-tab-label"
              onClick={() => { if (!cardActive) props.onFocusPage(); }}
            >
              📄 {pageLabel}
            </button>
            <button
              type="button"
              className="v3-tab-close"
              title="Закрыть вкладку"
              onClick={props.onClosePage}
            >
              ✕
            </button>
          </div>
        )}
        {props.openCards.map((card) => {
          const key = `${card.kind}:${card.entityId}`;
          const active = cardActive && cardFocused && key === props.focusedCardKey;
          const isSecondary = key === secondaryKey;
          return (
            <div key={key} className="v3-tab v3-tab-card" data-active={active ? '1' : undefined} title={card.title}>
              <button
                type="button"
                className="v3-tab-label"
                onClick={() => { if (!active) props.onFocusCard(card); }}
              >
                {isSecondary ? '▐ ' : ''}{card.title}
              </button>
              {/* ⑃ сравнить: закрепить карточку второй панелью рядом с активной. */}
              {!active && !isSecondary && (
                <button
                  type="button"
                  className="v3-tab-split"
                  title="Открыть рядом для сравнения (пополам)"
                  onClick={() => props.onSplitCard(card)}
                >
                  ⑃
                </button>
              )}
              <button
                type="button"
                className="v3-tab-close"
                title="Закрыть карточку"
                onClick={() => (isSecondary ? props.onCloseSecondary() : props.onCloseCard(card))}
              >
                ✕
              </button>
            </div>
          );
        })}
        {props.limitNotice ? (
          <div className="v3-tabs-warning" role="alert">
            ⛔ Лимит 10 вкладок — закройте одну из открытых, чтобы открыть новую.
          </div>
        ) : v3ShowTabsWarning(props.openCards.length) ? (
          <div className="v3-tabs-warning" role="alert">
            ⚠ Открытых вкладок многовато — закройте отработанные, чтобы не наплодить конфликтов и не забыть сохранить.
          </div>
        ) : null}
      </div>
      {drawerSections && (
        <ChromeDrawer open={!chrome.state.hidden.sections}>
          <div className="v3-split-sections">{sectionsPanel}</div>
        </ChromeDrawer>
      )}
      {/* Сплит «РАЗДЕЛЫ | Список» всегда смонтирован — скрывается, когда активна карточка.
          Разделитель тянется мышкой, ширина запоминается. */}
      {drawerSections ? (
        <div className="v3-split" style={cardActive ? { display: 'none' } : undefined}>
          <div className="v3-split-list">{listBody}</div>
        </div>
      ) : (
      <div className="v3-split" style={cardActive ? { display: 'none' } : undefined}>
        <Group orientation="horizontal" className="v3-split-group"
          onLayoutChanged={(layout: Layout, meta: LayoutChangedMeta) => {
            // Только завершённое перетаскивание оператора: onLayoutChange звал бы персист
            // на каждый пиксель, а ре-рендер посреди drag'а сбивал первую же тягу.
            if (!meta.isUserInteraction) return;
            const pct = layout['v3-sections'];
            if (typeof pct === 'number' && Number.isFinite(pct)) props.onSectionsPctChange(pct);
          }}
        >
          <Panel id="v3-sections" className="v3-panel-body" minSize="150px" defaultSize={sectionsDefaultSize}>
            <div className="v3-split-sections">{sectionsPanel}</div>
          </Panel>
          <Separator className="v3-resize-handle" />
          <Panel id="v3-list" className="v3-panel-body" minSize={240}>
            <div className="v3-split-list">{listBody}</div>
          </Panel>
        </Group>
      </div>
      )}
      {workspaceTab && (
        secondary ? (
          /* Сравнение «2 рядом»: активная карточка слева, закреплённая ⑃ справа, дефолт пополам. */
          <div className="v3-card-compare" style={!cardActive ? { display: 'none' } : undefined}>
            <Group key={secondaryKey} orientation="horizontal" className="v3-split-group" defaultLayout={compareLayout}
              onLayoutChanged={(layout: Layout, meta: LayoutChangedMeta) => {
                if (!meta.isUserInteraction) return;
                const pct = layout['v3-compare-primary'];
                if (typeof pct === 'number' && Number.isFinite(pct)) props.onComparePctChange(pct);
              }}
            >
              <Panel id="v3-compare-primary" className="v3-panel-body" minSize={220}>
                <div className="v3-card-body v3-compare-pane">{workspaceBody}</div>
              </Panel>
              <Separator className="v3-resize-handle" />
              <Panel id="v3-compare-secondary" className="v3-panel-body" minSize={220}>
                <div className="v3-compare-pane v3-compare-secondary">
                  <div className="v3-compare-header">
                    <span className="v3-compare-title">▐ {secondary.title}</span>
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
          <div className="v3-card-body" style={!cardActive ? { display: 'none' } : undefined}>{workspaceBody}</div>
        )
      )}
    </div>
  );
}
