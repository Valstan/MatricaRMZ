import React, { useMemo } from 'react';
import { Group, Panel, Separator, type Layout, type LayoutChangedMeta } from 'react-resizable-panels';
import { shouldWarnTabsCount } from '@matricarmz/shared';

import { resolveMenuTab, type MenuTabId, type TabId } from '../layout/Tabs.js';
import { ButtonPanel } from '../shellV2/ButtonPanel.js';
import type { V2ButtonLayout } from '@matricarmz/shared';
import { buildV2Buttons } from '../shellV2/v2ButtonCatalog.js';
import type { ActionButtonId } from '../shellV2/menuActions.js';
import type { MenuButtonDescriptor } from '../shellV2/v2ButtonCatalog.js';
import { useChromeVisibility } from '../shell/ChromeVisibilityContext.js';
import type { ShellNotice } from '../shell/shellNotice.js';
import { TabVisibilityProvider } from '../shell/TabVisibilityContext.js';
import { matricaPlatform } from '../platform.js';
import { FavoriteStarButton } from '../components/FavoriteStarButton.js';
import { ListContextMenu } from '../components/ListContextMenu.js';
import { emojiAttrs } from '../utils/labelEmoji.js';
import { shouldKeepAliveTab } from './keepAlive.js';
import { MatrixRain } from './MatrixRain.js';
import rmzLogo from '../../assets/logo_rmz.png';
import './shellV3.css';

const RMZ_LOGO_SRC = rmzLogo;

/** Напоминание про вкладки: сколько висит и как часто повторяется. */
const TABS_HINT_VISIBLE_MS = 3_000;
const TABS_HINT_PERIOD_MS = 60_000;

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
  /** Заголовок карточки ещё фолбэк («Вид · id6») — галстук гаснет, чтобы не обещать ярлык с техническим именем. */
  titleIsFallback?: boolean;
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
  /** Избранные разделы (золотые звёздочки): рельса слева + звёзды в МЕНЮ и на вкладках. */
  sectionFavorites: readonly MenuTabId[];
  onToggleSectionFavorite: (id: MenuTabId) => void;
  /** Непрочитанные сообщения чата — бейдж на вкладке Верстака (владелец 08.09.2026). */
  chatUnread?: number;
  /** Черновики на машине: красный бейдж на вкладке «Черновики» (владелец 21.10.2026). */
  draftsCount?: number;
  /** Расхождение часов компьютера с сервером — плашка в шапке (владелец 21.10.2026). */
  clockSkew?: { problem: boolean; text: string; rttMs: number | null } | null;
  onClockSync?: () => void;
  onClockOpenSettings?: () => void;
  /** Перезапуск программы из шапки — для оператора, который не может выгрузить её из трея. */
  onRestartApp?: () => void;
  /** Прогресс фоновой загрузки обновления: заливка под вкладками. `null` — ничего не качается. */
  updateProgress?: { pct: number; version?: string | null } | null;
  /** Короткое сообщение оператору — всплывает над телом вкладки и гаснет само. */
  notice?: ShellNotice | null;
  openTabs: OpenTab[];
  activeTabId: string;
  /** Раздел, который подсвечивается в панели МЕНЮ: «где оператор был», а не активная вкладка. */
  activeSectionTabId: TabId;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** Галстук «На Верстак»: лежит ли ярлык этой вкладки на Верстаке (тумблер). */
  isOnDesktop?: (tab: OpenTab) => boolean;
  onToggleDesktop?: (tab: OpenTab) => void;
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
  onProgramFeedback?: () => void;
}) {
  const buttons = buildV2Buttons(props.availableTabs, props.menuLabels, props.buttonLayout, props.tabletOperatorMenu);
  // Панель МЕНЮ видна только когда активна вкладка МЕНЮ, поэтому подсвечивать надо раздел,
  // НА КОТОРОМ оператор находится (App.tab), а не активную вкладку — иначе подсветка всегда
  // указывала бы на фолбэк. Раньше бралась первая list-вкладка: на карточке или другом
  // разделе подсвечивался чужой пункт.
  const activeMenuTab = resolveMenuTab(props.activeSectionTabId);
  const isAndroid = matricaPlatform() === 'android';

  const chrome = useChromeVisibility();
  const setShellMounted = chrome.setShellMounted;
  React.useLayoutEffect(() => {
    setShellMounted(true);
    return () => setShellMounted(false);
  }, [setShellMounted]);

  // МЕНЮ — узкий оверлей ПОВЕРХ активной вкладки (решение владельца 2026-08-11),
  // а не полотно на всю панель. Вкладка «menu» осталась в модели (tabsModel держит
  // её как неубиваемый tabs[0] и фолбэк activeId) — когда она активна (свежий вход,
  // закрыта последняя вкладка), оверлей раскрывается сам, и CDP-смоуки по-прежнему
  // видят span.v2-menu-btn-label сразу после загрузки.
  const [menuOverlayOpen, setMenuOverlayOpen] = React.useState(false);
  // Контекстное меню вкладки (B8): ярлык на Верстак живёт здесь, а не булавкой.
  const [tabMenu, setTabMenu] = React.useState<{ x: number; y: number; tabId: string } | null>(null);
  const activeForOverlay = props.openTabs.find((t) => t.id === props.activeTabId);
  const activeKindForOverlay = activeForOverlay?.kind;
  React.useEffect(() => {
    if (activeKindForOverlay === 'menu') setMenuOverlayOpen(true);
  }, [activeKindForOverlay, props.activeTabId]);
  React.useEffect(() => {
    if (!menuOverlayOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOverlayOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menuOverlayOpen]);

  // «Много вкладок» больше не живёт в полосе вкладок (решение владельца 2026-08-11):
  // там она отъедала ширину, и на планшете вкладки схлопывались до нечитаемых. Теперь —
  // короткая всплывашка над телом вкладки: показывается TABS_HINT_VISIBLE_MS и повторяется
  // не чаще TABS_HINT_PERIOD_MS, пока вкладок много. Кликам не мешает (pointer-events: none).
  const tooManyTabs = shouldWarnTabsCount(props.openTabs.length);
  const [tabsHintVisible, setTabsHintVisible] = React.useState(false);
  const tabsHintShownAtRef = React.useRef(0);
  React.useEffect(() => {
    if (!tooManyTabs) return;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    let nextTimer: ReturnType<typeof setTimeout> | null = null;
    const cycle = () => {
      tabsHintShownAtRef.current = Date.now();
      setTabsHintVisible(true);
      hideTimer = setTimeout(() => setTabsHintVisible(false), TABS_HINT_VISIBLE_MS);
      nextTimer = setTimeout(cycle, TABS_HINT_PERIOD_MS);
    };
    // Первый показ — сразу, но если напоминание уже было недавно (счётчик вкладок
    // попрыгал через порог), ждём остаток периода.
    const sinceLast = Date.now() - tabsHintShownAtRef.current;
    nextTimer = setTimeout(cycle, Math.max(0, TABS_HINT_PERIOD_MS - sinceLast));
    return () => {
      setTabsHintVisible(false);
      if (hideTimer) clearTimeout(hideTimer);
      if (nextTimer) clearTimeout(nextTimer);
    };
  }, [tooManyTabs]);

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
        // Выбор пункта сворачивает оверлей — вкладка раздела откроется под ним.
        setMenuOverlayOpen(false);
        props.onMenuTab(t);
      }}
      onAction={(id) => {
        setMenuOverlayOpen(false);
        props.onAction(id);
      }}
      favoriteTabs={props.sectionFavorites}
      onToggleFavoriteTab={props.onToggleSectionFavorite}
    />
  );

  // Большие карточки избранных разделов для левой рельсы — в порядке меню,
  // только nav-разделы из доступных (уже с учётом прав: availableTabs).
  const favoriteCards = useMemo(() => {
    const fav = new Set<string>(props.sectionFavorites);
    const out: MenuButtonDescriptor[] = [];
    for (const section of buttons.sections) {
      for (const btn of section.items) {
        if (btn.kind === 'nav' && fav.has(btn.id)) out.push(btn);
      }
    }
    return out;
  }, [buttons, props.sectionFavorites]);

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
        // Сам ButtonPanel живёт в оверлее (см. v3-menu-overlay ниже); панель вкладки
        // «menu» — домашний экран-подсказка на случаи, когда activeId падает на неё
        // (свежий вход, закрыта последняя вкладка, dirty-guard defer).
        return wrap(
          <div key={tab.id} className={cls('v3-list-empty')} {...paneAttrs}>
            <div style={{ fontSize: 34 }}>🧱</div>
            <div>Выберите раздел в МЕНЮ</div>
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
        // v3-tab-content-ai-chat глушит скролл обёртки: скроллится только лента
        // сообщений внутри чата, композер остаётся прижат к низу панели.
        return props.renderAiChatTab
          ? wrap(
              <div key={tab.id} className={cls('v3-tab-content v3-tab-content-ai-chat ui-content-viewport')} {...paneAttrs}>
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
      {/* Часы компьютера расходятся с часами сервера — плашка в шапке, не модалка:
          работать можно, но подписи и «свежесть» записей будут врать. */}
      {props.clockSkew?.problem ? (
        <div className="v3-clock-skew" data-clock-skew="problem" role="status">
          <span>
            🔴 Время на компьютере расходится с сервером на {props.clockSkew.text}
            {props.clockSkew.rttMs != null ? ` (сеть ${Math.round(props.clockSkew.rttMs / 100) / 10} с)` : ''} — документы
            подписываются неверным временем, изменения могут не уйти на сервер.
          </span>
          {props.onClockSync ? (
            <button type="button" className="v3-clock-skew-btn" onClick={() => props.onClockSync?.()}>
              Синхронизировать
            </button>
          ) : null}
          {props.onClockOpenSettings ? (
            <button type="button" className="v3-clock-skew-btn" onClick={() => props.onClockOpenSettings?.()}>
              Открыть настройки времени
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="v3-tab-strip" role="tablist">
        {/* Прогресс фонового обновления — заливка ПОД вкладками во всю ширину (владелец
            08.09.2026): видно, что программа что-то качает и скоро может перезагрузиться,
            но подписи вкладок читаются как обычно. */}
        {props.updateProgress != null && (
          <div
            className="v3-tabs-progress"
            data-update-progress={String(props.updateProgress.pct)}
            style={{ width: `${Math.max(0, Math.min(100, props.updateProgress.pct))}%` }}
            title={`Загружается обновление ${props.updateProgress.version ?? ''} — ${props.updateProgress.pct}%`}
            aria-hidden="true"
          />
        )}
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
            <div
              key={tab.id}
              className={`v3-tab ${isMenu ? 'v3-tab-menu' : ''}`}
              data-active={isActive ? '1' : undefined}
              onContextMenu={
                (tab.kind === 'card' || tab.kind === 'list') && props.onToggleDesktop && !isAndroid
                  ? (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setTabMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
                    }
                  : undefined
              }
            >
              <button
                type="button"
                className="v3-tab-label"
                onClick={() => {
                  // МЕНЮ — переключатель оверлея, активную вкладку не трогает;
                  // выбор любой другой вкладки сворачивает открытый оверлей.
                  if (isMenu) {
                    setMenuOverlayOpen((v) => !v);
                    return;
                  }
                  setMenuOverlayOpen(false);
                  props.onSelectTab(tab.id);
                }}
                title={isSecondary ? `${tab.label} — открыта во второй панели` : tab.label}
                {...(isMenu || isSecondary ? {} : emojiAttrs(tab.label))}
              >
                {isMenu ? `🧱 ${tab.label}` : isSecondary ? `▐ ${tab.label}` : tab.label}
                {/* Непрочитанные сообщения видны, даже когда оператор в другой вкладке
                    (владелец 08.09.2026): раньше о письме узнавали, только зайдя в чат. */}
                {tab.kind === 'chat' && Number(props.chatUnread ?? 0) > 0 && (
                  <span className="v3-tab-bell" data-chat-unread={String(props.chatUnread)} title={`Непрочитанных сообщений: ${props.chatUnread}`}>
                    🔔{props.chatUnread}
                  </span>
                )}
                {/* Черновики: красный бейдж со счётчиком (владелец 21.10.2026). */}
                {tab.kind === 'list' && tab.tabId === 'drafts' && Number(props.draftsCount ?? 0) > 0 && (
                  <span className="v3-tab-drafts-badge" data-drafts-count={String(props.draftsCount)} title={`Черновиков: ${props.draftsCount} — вкладку нельзя закрыть, пока они есть`}>
                    ●{props.draftsCount}
                  </span>
                )}
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
              {/* Золотая звёздочка избранного — ДО кнопки закрытия (B8). У списков —
                  звезда своего раздела; у карточек — звезда родительского раздела
                  (все карточки двигателей делят звезду «Двигатели»). Булавки-ярлыки
                  сняты: ярлык вкладки — через её контекстное меню. */}
              {(tab.kind === 'list' || tab.kind === 'card') &&
                (tab.kind === 'list' ? tab.tabId : tab.cardKind) != null &&
                (() => {
                  const menuId = resolveMenuTab(String(tab.kind === 'list' ? tab.tabId : tab.cardKind));
                  if (menuId == null) return null;
                  const fav = props.sectionFavorites.includes(menuId);
                  return (
                    <FavoriteStarButton
                      favorite={fav}
                      dataId={menuId}
                      size={26}
                      title={fav ? `Убрать «${tab.label}» из избранного` : `Добавить «${tab.label}» в избранное`}
                      onToggle={() => props.onToggleSectionFavorite(menuId)}
                    />
                  );
                })()}
              {tab.kind === 'list' && tab.tabId === 'drafts' && Number(props.draftsCount ?? 0) > 0 ? (
                // Пока есть черновики, вкладку закрывать нельзя — но крестик показываем
                // (иначе оператор не понимает, почему вкладка не закрывается).
                <button
                  type="button"
                  className="v3-tab-close v3-tab-close-locked"
                  disabled
                  title="Пока есть черновики, вкладку закрыть нельзя — разберите черновики"
                >
                  ✕
                </button>
              ) : null}
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
        <div className="v3-tab-spacer" />
        {/* Перезапуск программы (владелец 21.10.2026): программа живёт в трее и сама
            не выгружается — после правок или зависания оператору нужен свой restart
            без перезагрузки компьютера. */}
        {props.onRestartApp ? (
          <button
            type="button"
            className="v3-account-btn"
            data-restart-app-btn
            title="Перезапустить программу: закрыть всё и открыть заново (компьютер перезагружать не нужно)"
            onClick={() => props.onRestartApp?.()}
          >
            <span aria-hidden="true">⟳</span>
            <span className="v3-account-name">Перезапустить программу</span>
          </button>
        ) : null}
        {/* «Правка программы» — рядом с аккаунтом: доступна с любого экрана, а не
            только из МЕНЮ; раздел в письмо подставляется сам. */}
        {props.userLabel && props.onProgramFeedback ? (
          <button
            type="button"
            className="v3-account-btn"
            data-program-feedback-btn
            title="Заметка разработчику: замечание, вопрос или просьба по программе"
            onClick={() => props.onProgramFeedback?.()}
          >
            <span aria-hidden="true">✏️</span>
            <span className="v3-account-name">Заметка разработчику</span>
          </button>
        ) : null}
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
            {/* Стрелка — отдельным элементом: вращение вешается на неё, иначе крутилась
                бы вся кнопка вместе с рамкой (владелец 18.09.2026). */}
            <span className="v3-sync-glyph" aria-hidden="true">
              ↻
            </span>
          </button>
          {props.syncState === 'syncing' && props.syncProgress != null && (
            <span className="v3-sync-pct">{props.syncProgress}%</span>
          )}
          {props.syncState === 'done' && props.syncSummary && (
            <span className="v3-sync-done-text">{props.syncSummary}</span>
          )}
        </div>
      </div>
      {tabMenu &&
        (() => {
          const target = props.openTabs.find((t) => t.id === tabMenu.tabId);
          if (!target || (target.kind !== 'card' && target.kind !== 'list') || props.onToggleDesktop == null) return null;
          // Ярлык с техническим именем не обещаем: пока заголовок карточки — фолбэк,
          // пункт меню гаснет (та же честность, что была у булавки).
          const pending = target.kind === 'card' && target.titleIsFallback;
          const onDesktop = !pending && (props.isOnDesktop?.(target) ?? false);
          return (
            <ListContextMenu
              x={tabMenu.x}
              y={tabMenu.y}
              items={[
                {
                  id: 'desktop',
                  label: onDesktop ? `Убрать с Верстака «${target.label}»` : `Добавить на Верстак «${target.label}»`,
                  ...(pending ? { disabled: true as const } : {}),
                  onClick: () => {
                    props.onToggleDesktop?.(target);
                  },
                },
              ]}
              onClose={() => setTabMenu(null)}
            />
          );
        })()}
      {/* Левая рельса избранного (владелец 12.10.2026): большие карточки разделов
          со звёздочкой — переключение в один клик. МЕНЮ-оверлей живёт внутри
          .v3-tab-body и рельсу не накрывает. */}
      <div className="v3-body-row">
        <div className="v3-fav-rail" data-fav-rail="1">
          <div className="v3-fav-rail-list" title="Избранные разделы">
            {favoriteCards.map((btn) => (
              <button
                key={btn.id}
                type="button"
                className="v3-fav-card"
                data-fav-card={btn.id}
                data-fav-active={activeMenuTab === btn.id ? '1' : undefined}
                title={btn.label}
                onClick={() => { setMenuOverlayOpen(false); props.onMenuTab(btn.id as MenuTabId); }}
              >
                <span className="v3-fav-card-icon" aria-hidden="true">{btn.icon}</span>
                <span className="v3-fav-card-label">{btn.label}</span>
              </button>
            ))}
            {favoriteCards.length === 0 && (
              <div className="v3-fav-rail-hint">Поставьте ★ в МЕНЮ — раздел появится здесь</div>
            )}
          </div>
          {/* Постоянные плашки — не избранное: они не хранятся в профиле (иначе их можно было бы
              удалить или не получить на новой машине), а показываются у всех, на всех машинах и
              аккаунтах (владелец 21.10.2026). Вкладки при этом закрываемые — вернуться можно
              отсюда. */}
          <div className="v3-fav-rail-builtins" data-rail-builtin="1">
            <button
              type="button"
              className="v3-fav-card v3-fav-card-ai"
              data-fav-card="ai_chat"
              aria-label="Ииваныч — спроси меня про что угодно"
              onClick={() => { setMenuOverlayOpen(false); props.onAction('ai_chat'); }}
            >
              <MatrixRain className="v3-fav-ai-rain" />
              <span className="v3-fav-card-icon" aria-hidden="true">🧠</span>
              <span className="v3-fav-card-label">Ииваныч</span>
              <span className="v3-fav-tip" role="tooltip">Спроси меня про что угодно, я знаю ответ!</span>
            </button>
            <button
              type="button"
              className="v3-fav-card v3-fav-card-workshop"
              data-fav-card="chat"
              aria-label="Верстак"
              onClick={() => { setMenuOverlayOpen(false); props.onAction('chat'); }}
            >
              <span className="v3-fav-card-icon" aria-hidden="true">🛠️</span>
              <span className="v3-fav-card-label">ВЕРСТАК</span>
            </button>
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
        {menuOverlayOpen && (
          <>
            <div className="v3-menu-overlay-backdrop" onClick={() => setMenuOverlayOpen(false)} />
            <div className="v3-menu-overlay">{menuPanel}</div>
          </>
        )}
        {/* Обе плашки висят в одной точке над телом вкладки. Ответ на действие оператора
            важнее периодического напоминания — на время сообщения напоминание уступает,
            иначе они наложились бы друг на друга нечитаемой кашей. */}
        {tabsHintVisible && !props.notice && (
          <div className="v3-tabs-hint" role="status">
            ⚠ Много вкладок — проверьте, что всё сохранено, и закройте отработанные.
          </div>
        )}
        {props.notice && (
          <div
            className={`v3-tabs-hint v3-shell-notice${props.notice.tone === 'error' ? ' v3-shell-notice-error' : ''}`}
            role="status"
          >
            {props.notice.text}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
