// Явная модель полосы вкладок оболочки v3 «Вкладки» (этап R3-PR1 большого рефакторинга).
//
// Состав вкладок и активная вкладка — ОДНО состояние, меняемое ОДНИМ действием.
// Производных tabList/activeTabKey (App.tsx:5228-5269) больше нет, поэтому исчезает
// окно рассинхрона, в котором активный ключ указывал на несуществующую вкладку
// (V3TabShell.tsx:139,241 — пустой экран без единой ошибки).
//
// Чистый домен: ни React, ни DOM, ни часов, ни случайности. Раздел и вид карточки
// (в renderer это union TabId) здесь непрозрачные строки — union живёт в
// electron-app/src/renderer/src/ui/layout/Tabs.tsx; прецедент — V2SessionCard.kind.

import { V3_MAX_CARD_TABS, V3_WARN_TOTAL_TABS, type V2SessionCard } from './uiShellV2.js';

/** Идентификатор раздела / вида карточки: renderer TabId, для домена — строка. */
export type TabSectionId = string;

export const MENU_TAB_ID = 'menu';
export const CHAT_TAB_ID = 'chat';
export const AI_CHAT_TAB_ID = 'ai_chat';
export const SETTINGS_TAB_ID = 'settings';

export const LIST_TAB_PREFIX = 'list:';
export const CARD_TAB_PREFIX = 'card:';

export const DEFAULT_MENU_LABEL = 'МЕНЮ';

/** Карточек больше этого числа не открываем: ОТКАЗ, а не молчаливое вытеснение. */
export const MAX_CARD_TABS = V3_MAX_CARD_TABS;

/**
 * Единственный раздел без собственной вкладки — экран входа. 'history' сюда НЕ входит:
 * это полноценный раздел («История»), который открывается вкладкой из МЕНЮ. Его вторая
 * роль — нейтральный «дом» после закрытия карточки — выражается действием FOCUS_SECTION,
 * а не отсутствием вкладки.
 */
export const NO_TAB_SECTIONS: readonly TabSectionId[] = ['auth'];

export type SingletonTabId = typeof CHAT_TAB_ID | typeof AI_CHAT_TAB_ID | typeof SETTINGS_TAB_ID;

export type MenuTab = { id: typeof MENU_TAB_ID; kind: 'menu'; label: string };
export type ChatTab = { id: typeof CHAT_TAB_ID; kind: 'chat'; label: string };
export type AiChatTab = { id: typeof AI_CHAT_TAB_ID; kind: 'ai_chat'; label: string };
export type SettingsTab = { id: typeof SETTINGS_TAB_ID; kind: 'settings'; label: string };
export type ListTab = { id: string; kind: 'list'; label: string; tabId: TabSectionId };

export type CardTab = {
  id: string;
  kind: 'card';
  label: string;
  cardKind: TabSectionId;
  entityId: string;
  /** Заголовок ещё фолбэк («Вид · id6»): таким нельзя затирать резолвнутое имя. */
  titleIsFallback: boolean;
};

export type WorkTab = MenuTab | ChatTab | AiChatTab | SettingsTab | ListTab | CardTab;
export type WorkTabKind = WorkTab['kind'];

export type TabsNoticeCode = 'card_limit';

/**
 * Уведомление об отказе. seq растёт в пределах непрерывной серии отказов (после
 * DISMISS_NOTICE отсчёт начинается заново) — оболочке достаточно смены ссылки,
 * чтобы перезапустить таймер снятия баннера: часов в домене нет.
 */
export type TabsNotice = { code: TabsNoticeCode; seq: number };

export type TabsState = {
  /** Порядок массива = порядок отрисовки полосы; tabs[0] всегда МЕНЮ. */
  tabs: WorkTab[];
  /** Инвариант: всегда равен id одной из tabs. */
  activeId: string;
  /** Вторая панель («2 рядом»): дескриптор ВНЕ полосы вкладок (App.tsx:5271-5279). */
  secondary: CardTab | null;
  notice: TabsNotice | null;
};

export type CardRef = {
  cardKind: TabSectionId;
  entityId: string;
  title: string;
  titleIsFallback: boolean;
};

// Поля экшенов намеренно обязательные (в т.ч. focus): под exactOptionalPropertyTypes
// любое `focus: cond ? true : undefined` у вызывающего — ошибка компиляции.
export type TabsAction =
  | { type: 'OPEN_LIST'; tabId: TabSectionId; label: string; focus: boolean }
  | {
      type: 'OPEN_CARD';
      cardKind: TabSectionId;
      entityId: string;
      title: string;
      titleIsFallback: boolean;
      focus: boolean;
    }
  | { type: 'OPEN_SINGLETON'; id: SingletonTabId; label: string; focus: boolean }
  | { type: 'FOCUS'; id: string }
  | { type: 'FOCUS_SECTION'; tabId: TabSectionId }
  | { type: 'CLOSE'; id: string }
  | { type: 'CLOSE_CARD'; cardKind: TabSectionId; entityId: string }
  | { type: 'CLOSE_ALL_CARDS' }
  | { type: 'RETITLE'; id: string; title: string; titleIsFallback: boolean }
  | { type: 'SET_SECONDARY'; card: CardRef | null }
  | { type: 'RESTORE'; cards: CardRef[]; focusedCardId: string | null; secondary: CardRef | null }
  | { type: 'RESET' }
  | { type: 'DISMISS_NOTICE' };

/** `rejected: … | null` вместо `rejected?:` — конвенция пакета под exactOptionalPropertyTypes. */
export type TabsResult = { state: TabsState; rejected: TabsNoticeCode | null };

// ---------------------------------------------------------------------------
// Ключи вкладок — фактический контракт с оболочкой, персистом и CDP-смоуками.
// Строятся и разбираются одной парой функций; разбор по ПЕРВОМУ разделителю,
// поэтому entityId с ':' не теряет хвост (id.split(':')[2] в App.tsx:5151,5204 терял).
// ---------------------------------------------------------------------------

export function listTabId(tabId: TabSectionId): string {
  return `${LIST_TAB_PREFIX}${tabId}`;
}

export function cardTabId(cardKind: TabSectionId, entityId: string): string {
  return `${CARD_TAB_PREFIX}${cardKind}:${entityId}`;
}

/** Ключ карточки в персисте v2.session — `${kind}:${entityId}`, без префикса. */
export function cardSessionKey(cardKind: TabSectionId, entityId: string): string {
  return `${cardKind}:${entityId}`;
}

/** Ключ персиста → id вкладки; null, если ключ битый. */
export function tabIdFromSessionKey(key: string): string | null {
  const sep = key.indexOf(':');
  if (sep <= 0) return null;
  const cardKind = key.slice(0, sep);
  const entityId = key.slice(sep + 1);
  return entityId ? cardTabId(cardKind, entityId) : null;
}

export type ParsedTabId =
  | { kind: 'menu' }
  | { kind: 'chat' }
  | { kind: 'ai_chat' }
  | { kind: 'settings' }
  | { kind: 'list'; tabId: TabSectionId }
  | { kind: 'card'; cardKind: TabSectionId; entityId: string };

export function parseTabId(id: string): ParsedTabId | null {
  if (id === MENU_TAB_ID) return { kind: 'menu' };
  if (id === CHAT_TAB_ID) return { kind: 'chat' };
  if (id === AI_CHAT_TAB_ID) return { kind: 'ai_chat' };
  if (id === SETTINGS_TAB_ID) return { kind: 'settings' };
  if (id.startsWith(LIST_TAB_PREFIX)) {
    const tabId = id.slice(LIST_TAB_PREFIX.length);
    return tabId ? { kind: 'list', tabId } : null;
  }
  if (id.startsWith(CARD_TAB_PREFIX)) {
    const rest = id.slice(CARD_TAB_PREFIX.length);
    const sep = rest.indexOf(':');
    if (sep <= 0) return null;
    const entityId = rest.slice(sep + 1);
    return entityId ? { kind: 'card', cardKind: rest.slice(0, sep), entityId } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Конструкторы
// ---------------------------------------------------------------------------

function createMenuTab(label: string): MenuTab {
  return { id: MENU_TAB_ID, kind: 'menu', label: label.trim() || DEFAULT_MENU_LABEL };
}

function createSingletonTab(id: SingletonTabId, label: string): WorkTab {
  const text = label.trim() || id;
  if (id === CHAT_TAB_ID) return { id: CHAT_TAB_ID, kind: 'chat', label: text };
  if (id === AI_CHAT_TAB_ID) return { id: AI_CHAT_TAB_ID, kind: 'ai_chat', label: text };
  return { id: SETTINGS_TAB_ID, kind: 'settings', label: text };
}

function makeCardTab(ref: CardRef): CardTab | null {
  const cardKind = ref.cardKind.trim();
  const entityId = ref.entityId.trim();
  if (!cardKind || !entityId) return null;
  return {
    id: cardTabId(cardKind, entityId),
    kind: 'card',
    label: ref.title.trim() || cardKind,
    cardKind,
    entityId,
    titleIsFallback: ref.titleIsFallback,
  };
}

export function createTabsState(menuLabel: string = DEFAULT_MENU_LABEL): TabsState {
  return { tabs: [createMenuTab(menuLabel)], activeId: MENU_TAB_ID, secondary: null, notice: null };
}

// ---------------------------------------------------------------------------
// Нормализация — ЕДИНСТВЕННЫЙ выход редьюсера. Держит инварианты:
//   1) МЕНЮ существует и стоит на индексе 0 (значит у любой вкладки есть сосед слева);
//   2) id вкладок уникальны;
//   3) канонический порядок полосы: МЕНЮ → Чат → ИИваныч → Настройки → карточки → списки
//      (1:1 с App.tsx:5228-5256; внутри ранга — порядок открытия, сортировка стабильна);
//   4) activeId ∈ tabs (иначе 'menu') — «пустой экран» невозможен;
//   5) secondary.id !== activeId — одна сущность не висит слева и справа одновременно.
// ---------------------------------------------------------------------------

const TAB_RANK: Record<WorkTabKind, number> = {
  menu: 0,
  chat: 1,
  ai_chat: 2,
  settings: 3,
  card: 4,
  list: 5,
};

function normalize(state: TabsState): TabsState {
  let tabs = state.tabs;

  if (!tabs.some((t) => t.kind === 'menu')) {
    tabs = [createMenuTab(DEFAULT_MENU_LABEL), ...tabs];
  }

  const seen = new Set<string>();
  const deduped: WorkTab[] = [];
  for (const t of tabs) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    deduped.push(t);
  }
  if (deduped.length !== tabs.length) tabs = deduped;

  const sorted = tabs.slice().sort((a, b) => TAB_RANK[a.kind] - TAB_RANK[b.kind]);
  if (sorted.some((t, i) => t !== tabs[i])) tabs = sorted;

  const activeId = tabs.some((t) => t.id === state.activeId) ? state.activeId : MENU_TAB_ID;
  const secondary = state.secondary !== null && state.secondary.id !== activeId ? state.secondary : null;

  if (tabs === state.tabs && activeId === state.activeId && secondary === state.secondary) {
    return state;
  }
  return { tabs, activeId, secondary, notice: state.notice };
}

function keep(state: TabsState): TabsResult {
  return { state, rejected: null };
}

/**
 * Возврат результативной ветки. Если после нормализации ничего не изменилось —
 * отдаём ПРЕЖНЮЮ ссылку: адаптеры дёргают dispatch из эффектов на каждый рендер,
 * новая ссылка означала бы бесконечный цикл ре-рендеров.
 */
function ok(prev: TabsState, candidate: TabsState): TabsResult {
  const next = normalize(candidate);
  if (
    next.tabs === prev.tabs &&
    next.activeId === prev.activeId &&
    next.secondary === prev.secondary &&
    next.notice === prev.notice
  ) {
    return { state: prev, rejected: null };
  }
  return { state: next, rejected: null };
}

function raiseNotice(state: TabsState, code: TabsNoticeCode): TabsState {
  const seq = (state.notice === null ? 0 : state.notice.seq) + 1;
  return { tabs: state.tabs, activeId: state.activeId, secondary: state.secondary, notice: { code, seq } };
}

function replaceAt(tabs: WorkTab[], index: number, tab: WorkTab): WorkTab[] {
  const next = tabs.slice();
  next[index] = tab;
  return next;
}

/** null — менять нечего (ссылка на state сохранится). */
function withLabel(tab: WorkTab, label: string): WorkTab | null {
  const text = label.trim();
  if (!text || tab.label === text) return null;
  switch (tab.kind) {
    case 'menu':
      return { id: MENU_TAB_ID, kind: 'menu', label: text };
    case 'chat':
      return { id: CHAT_TAB_ID, kind: 'chat', label: text };
    case 'ai_chat':
      return { id: AI_CHAT_TAB_ID, kind: 'ai_chat', label: text };
    case 'settings':
      return { id: SETTINGS_TAB_ID, kind: 'settings', label: text };
    case 'list':
      return { id: tab.id, kind: 'list', label: text, tabId: tab.tabId };
    default:
      return { ...tab, label: text };
  }
}

/** Правило App.tsx:3025 — фолбэк «Вид · id6» не затирает уже резолвнутое имя. */
function withCardTitle(tab: CardTab, title: string, titleIsFallback: boolean): CardTab | null {
  const text = title.trim();
  if (!text) return null;
  if (titleIsFallback && !tab.titleIsFallback) return null;
  if (tab.label === text && tab.titleIsFallback === titleIsFallback) return null;
  return { ...tab, label: text, titleIsFallback };
}

function countCards(tabs: readonly WorkTab[]): number {
  let n = 0;
  for (const t of tabs) if (t.kind === 'card') n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// Редьюсер
// ---------------------------------------------------------------------------

export function reduceTabs(state: TabsState, action: TabsAction): TabsResult {
  switch (action.type) {
    case 'OPEN_LIST': {
      const tabId = action.tabId.trim();
      if (!tabId || NO_TAB_SECTIONS.includes(tabId)) return keep(state);
      // 'settings' — не список: у него собственная вкладка-синглтон (App.tsx:5236-5238).
      if (tabId === SETTINGS_TAB_ID) {
        return reduceTabs(state, {
          type: 'OPEN_SINGLETON',
          id: SETTINGS_TAB_ID,
          label: action.label,
          focus: action.focus,
        });
      }
      const id = listTabId(tabId);
      const idx = state.tabs.findIndex((t) => t.id === id);
      const existing = idx >= 0 ? state.tabs[idx] : undefined;
      if (existing !== undefined) {
        const relabeled = withLabel(existing, action.label);
        const tabs = relabeled === null ? state.tabs : replaceAt(state.tabs, idx, relabeled);
        return ok(state, {
          tabs,
          activeId: action.focus ? id : state.activeId,
          secondary: state.secondary,
          notice: state.notice,
        });
      }
      const tab: ListTab = { id, kind: 'list', label: action.label.trim() || tabId, tabId };
      return ok(state, {
        tabs: [...state.tabs, tab],
        activeId: action.focus ? id : state.activeId,
        secondary: state.secondary,
        notice: state.notice,
      });
    }

    case 'OPEN_SINGLETON': {
      const id = action.id;
      const idx = state.tabs.findIndex((t) => t.id === id);
      const existing = idx >= 0 ? state.tabs[idx] : undefined;
      if (existing !== undefined) {
        const relabeled = withLabel(existing, action.label);
        const tabs = relabeled === null ? state.tabs : replaceAt(state.tabs, idx, relabeled);
        return ok(state, {
          tabs,
          activeId: action.focus ? id : state.activeId,
          secondary: state.secondary,
          notice: state.notice,
        });
      }
      return ok(state, {
        tabs: [...state.tabs, createSingletonTab(id, action.label)],
        activeId: action.focus ? id : state.activeId,
        secondary: state.secondary,
        notice: state.notice,
      });
    }

    case 'OPEN_CARD': {
      const card = makeCardTab({
        cardKind: action.cardKind,
        entityId: action.entityId,
        title: action.title,
        titleIsFallback: action.titleIsFallback,
      });
      if (card === null) return keep(state);
      const idx = state.tabs.findIndex((t) => t.id === card.id);
      const existing = idx >= 0 ? state.tabs[idx] : undefined;
      if (existing !== undefined && existing.kind === 'card') {
        // Рефокус уже открытой карточки лимитом НЕ гейтится — обход через ref не нужен.
        const retitled = withCardTitle(existing, action.title, action.titleIsFallback);
        const tabs = retitled === null ? state.tabs : replaceAt(state.tabs, idx, retitled);
        return ok(state, {
          tabs,
          activeId: action.focus ? card.id : state.activeId,
          secondary: state.secondary,
          notice: state.notice,
        });
      }
      if (countCards(state.tabs) >= MAX_CARD_TABS) {
        // Отказ, а не вытеснение: состав вкладок не трогаем вообще (дефект L).
        return { state: raiseNotice(state, 'card_limit'), rejected: 'card_limit' };
      }
      return ok(state, {
        tabs: [...state.tabs, card],
        activeId: action.focus ? card.id : state.activeId,
        secondary: state.secondary,
        notice: state.notice,
      });
    }

    case 'FOCUS': {
      // FOCUS никогда не меняет состав вкладок и не создаёт новых.
      if (!state.tabs.some((t) => t.id === action.id)) return keep(state);
      return ok(state, {
        tabs: state.tabs,
        activeId: action.id,
        secondary: state.secondary,
        notice: state.notice,
      });
    }

    case 'FOCUS_SECTION': {
      // «Уйти в раздел, ничего не открывая»: если вкладка раздела открыта — на неё,
      // иначе на МЕНЮ. Это ровно поведение сегодняшнего activeTabKey (App.tsx:5268 →
      // дефолт 'menu') и единственный корректный смысл targetTab='history' у
      // closeCardSession: «домой», а не «открой раздел История».
      const id = listTabId(action.tabId.trim());
      const target = state.tabs.some((t) => t.id === id) ? id : MENU_TAB_ID;
      return ok(state, {
        tabs: state.tabs,
        activeId: target,
        secondary: state.secondary,
        notice: state.notice,
      });
    }

    case 'CLOSE': {
      const idx = state.tabs.findIndex((t) => t.id === action.id);
      const target = idx >= 0 ? state.tabs[idx] : undefined;
      if (target === undefined || target.kind === 'menu') return keep(state);
      const tabs = state.tabs.filter((_, i) => i !== idx);
      // Фокус двигаем ТОЛЬКО если закрыли активную вкладку — сосед слева, дно МЕНЮ.
      const activeId =
        state.activeId === target.id ? (state.tabs[idx - 1]?.id ?? MENU_TAB_ID) : state.activeId;
      const secondary =
        state.secondary !== null && state.secondary.id === target.id ? null : state.secondary;
      return ok(state, { tabs, activeId, secondary, notice: state.notice });
    }

    case 'CLOSE_CARD': {
      const cardKind = action.cardKind.trim();
      const entityId = action.entityId.trim();
      if (!cardKind || !entityId) return keep(state);
      return reduceTabs(state, { type: 'CLOSE', id: cardTabId(cardKind, entityId) });
    }

    case 'CLOSE_ALL_CARDS': {
      const tabs = state.tabs.filter((t) => t.kind !== 'card');
      if (tabs.length === state.tabs.length) return keep(state);
      return ok(state, {
        tabs,
        activeId: state.activeId,
        secondary: null,
        notice: state.notice,
      });
    }

    case 'RETITLE': {
      const idx = state.tabs.findIndex((t) => t.id === action.id);
      const existing = idx >= 0 ? state.tabs[idx] : undefined;
      if (existing === undefined) return keep(state);
      const next =
        existing.kind === 'card'
          ? withCardTitle(existing, action.title, action.titleIsFallback)
          : withLabel(existing, action.title);
      if (next === null) return keep(state);
      return ok(state, {
        tabs: replaceAt(state.tabs, idx, next),
        activeId: state.activeId,
        secondary: state.secondary,
        notice: state.notice,
      });
    }

    case 'SET_SECONDARY': {
      const card = action.card === null ? null : makeCardTab(action.card);
      const next = card !== null && card.id !== state.activeId ? card : null;
      const prev = state.secondary;
      const same =
        next === null
          ? prev === null
          : prev !== null && prev.id === next.id && prev.label === next.label;
      if (same) return keep(state);
      return ok(state, {
        tabs: state.tabs,
        activeId: state.activeId,
        secondary: next,
        notice: state.notice,
      });
    }

    case 'RESTORE': {
      // Заменяем ТОЛЬКО карточные вкладки: синглтоны и списки, уже открытые к моменту
      // восстановления (ИИваныч из resetUserScopedState, App.tsx:1822), обязаны выжить.
      const kept = state.tabs.filter((t) => t.kind !== 'card');
      const cards: CardTab[] = [];
      const seen = new Set<string>();
      let truncated = false;
      for (const ref of action.cards) {
        const card = makeCardTab(ref);
        if (card === null || seen.has(card.id)) continue;
        if (cards.length >= MAX_CARD_TABS) {
          truncated = true;
          continue;
        }
        seen.add(card.id);
        cards.push(card);
      }
      const focused = action.focusedCardId;
      const activeId = focused !== null && seen.has(focused) ? focused : state.activeId;
      const secondaryRef = action.secondary === null ? null : makeCardTab(action.secondary);
      const secondary = secondaryRef !== null && secondaryRef.id !== activeId ? secondaryRef : null;
      const candidate: TabsState = {
        tabs: [...kept, ...cards],
        activeId,
        secondary,
        notice: state.notice,
      };
      // Обрезка сессии тоже не молчит — тот же код уведомления, что и у отказа лимита.
      const base = truncated ? raiseNotice(candidate, 'card_limit') : candidate;
      return { state: normalize(base), rejected: truncated ? 'card_limit' : null };
    }

    case 'RESET': {
      const menu = state.tabs.find((t) => t.kind === 'menu');
      if (
        state.tabs.length === 1 &&
        state.activeId === MENU_TAB_ID &&
        state.secondary === null &&
        state.notice === null
      ) {
        return keep(state);
      }
      return { state: createTabsState(menu === undefined ? DEFAULT_MENU_LABEL : menu.label), rejected: null };
    }

    case 'DISMISS_NOTICE': {
      if (state.notice === null) return keep(state);
      return keep({
        tabs: state.tabs,
        activeId: state.activeId,
        secondary: state.secondary,
        notice: null,
      });
    }

    default: {
      return keep(state);
    }
  }
}

/** Форма для useReducer: вердикт дублируется в state.notice, поэтому не теряется. */
export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  return reduceTabs(state, action).state;
}

// ---------------------------------------------------------------------------
// Селекторы: заменяют v2CurrentCardIdentity / v2SelectedByKind / openedListTabs /
// menuFocused / chatOpen / aiChatOpen и питают персист сессии.
// ---------------------------------------------------------------------------

export function hasTab(state: TabsState, id: string): boolean {
  return state.tabs.some((t) => t.id === id);
}

export function activeTab(state: TabsState): WorkTab | null {
  return state.tabs.find((t) => t.id === state.activeId) ?? null;
}

export function activeCardTab(state: TabsState): CardTab | null {
  const tab = activeTab(state);
  return tab !== null && tab.kind === 'card' ? tab : null;
}

export function cardTabs(state: TabsState): CardTab[] {
  return state.tabs.filter((t): t is CardTab => t.kind === 'card');
}

/** Гейт для вызывающего ДО записи selected*Id: уже открытая карточка лимитом не гейтится. */
export function canOpenCardTab(state: TabsState, cardKind: TabSectionId, entityId: string): boolean {
  return hasTab(state, cardTabId(cardKind, entityId)) || countCards(state.tabs) < MAX_CARD_TABS;
}

/**
 * Куда уедет фокус при закрытии вкладки id. Экспортируется, чтобы императивный слой
 * (reopenV2Card, загрузка данных соседней карточки) знал ответ ДО диспатча и не
 * расходился с редьюсером — сегодня этот выбор считается отдельно в App.tsx:2957.
 */
export function focusAfterClose(state: TabsState, id: string): string {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx <= 0) return state.activeId;
  if (state.activeId !== id) return state.activeId;
  return state.tabs[idx - 1]?.id ?? MENU_TAB_ID;
}

/** Подсветка раздела в МЕНЮ — от АКТИВНОЙ вкладки, а не от первой list-вкладки (дефект M). */
export function activeMenuSourceTabId(state: TabsState): TabSectionId | null {
  const tab = activeTab(state);
  if (tab === null) return null;
  if (tab.kind === 'list') return tab.tabId;
  if (tab.kind === 'card') return tab.cardKind;
  return null;
}

/** Предупреждение «вкладок многовато» — по РЕАЛЬНОМУ числу вкладок полосы (дефект N). */
export function shouldWarnTabsCount(totalTabs: number): boolean {
  return totalTabs > V3_WARN_TOTAL_TABS;
}

/** Снимок карточек для персиста сессии (формат V2SessionCard, App.tsx:3064-3070). */
export function sessionCards(state: TabsState): V2SessionCard[] {
  return cardTabs(state).map((t) => ({ kind: t.cardKind, entityId: t.entityId, title: t.label }));
}

export function sessionSecondaryCard(state: TabsState): V2SessionCard | null {
  const s = state.secondary;
  return s === null ? null : { kind: s.cardKind, entityId: s.entityId, title: s.label };
}

/** focusedKey персиста: `${kind}:${entityId}` активной карточки либо null. */
export function focusedCardKey(state: TabsState): string | null {
  const card = activeCardTab(state);
  return card === null ? null : cardSessionKey(card.cardKind, card.entityId);
}
