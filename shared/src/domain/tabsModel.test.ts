import { describe, expect, it } from 'vitest';

import {
  MAX_CARD_TABS,
  MENU_TAB_ID,
  activeCardTab,
  activeMenuSourceTabId,
  cardSessionKey,
  cardTabId,
  cardTabs,
  canOpenCardTab,
  createTabsState,
  focusAfterClose,
  focusedCardKey,
  hasTab,
  listTabId,
  parseTabId,
  reduceTabs,
  sessionCards,
  sessionSecondaryCard,
  sessionTabs,
  shouldWarnTabsCount,
  tabIdFromSessionKey,
  tabsReducer,
  type CardRef,
  type RestoredTab,
  type TabsAction,
  type TabsState,
} from './tabsModel.js';

function run(state: TabsState, ...actions: TabsAction[]): TabsState {
  return actions.reduce(tabsReducer, state);
}

function ids(state: TabsState): string[] {
  return state.tabs.map((t) => t.id);
}

function cardCount(state: TabsState): number {
  return cardTabs(state).length;
}

function openList(tabId: string, label: string = tabId, focus = true): TabsAction {
  return { type: 'OPEN_LIST', tabId, label, focus };
}

function openCard(
  cardKind: string,
  entityId: string,
  title: string = `${cardKind} ${entityId}`,
  titleIsFallback = false,
  focus = true,
): TabsAction {
  return { type: 'OPEN_CARD', cardKind, entityId, title, titleIsFallback, focus };
}

function openSingleton(id: 'chat' | 'ai_chat' | 'settings', label: string, focus = true): TabsAction {
  return { type: 'OPEN_SINGLETON', id, label, focus };
}

function cardRef(cardKind: string, entityId: string, title = `${cardKind} ${entityId}`): CardRef {
  return { cardKind, entityId, title, titleIsFallback: false };
}

describe('tabsModel: состав полосы вкладок', () => {
  it('МЕНЮ незакрываемо и всегда стоит первым', () => {
    const s = run(
      createTabsState(),
      openList('engines', 'Двигатели'),
      openCard('engine', 'E1'),
      openSingleton('chat', 'Чат'),
    );
    const closed = reduceTabs(s, { type: 'CLOSE', id: MENU_TAB_ID });
    expect(closed.state).toBe(s);
    expect(closed.rejected).toBeNull();
    expect(s.tabs[0]?.id).toBe(MENU_TAB_ID);
  });

  it('канонический порядок полосы: МЕНЮ → Чат → ИИваныч → Настройки → карточки → списки', () => {
    const s = run(
      createTabsState(),
      openList('engines', 'Двигатели'),
      openCard('engine', 'E1'),
      openSingleton('settings', 'Настройки'),
      openSingleton('ai_chat', 'ИИваныч'),
      openSingleton('chat', 'Чат'),
      openList('tools', 'Инструмент'),
    );
    expect(ids(s)).toEqual([
      'menu',
      'chat',
      'ai_chat',
      'settings',
      'card:engine:E1',
      'list:engines',
      'list:tools',
    ]);
  });

  it('внутри группы сохраняется порядок открытия', () => {
    const s = run(
      createTabsState(),
      openCard('engine', 'E1'),
      openList('tools', 'Инструмент'),
      openCard('request', 'R1'),
      openList('engines', 'Двигатели'),
      openCard('engine', 'E2'),
    );
    expect(ids(s)).toEqual([
      'menu',
      'card:engine:E1',
      'card:request:R1',
      'card:engine:E2',
      'list:tools',
      'list:engines',
    ]);
  });

  it('дедуп по id: повторное открытие вкладки не плодит вторую', () => {
    const s = run(
      createTabsState(),
      openList('engines', 'Двигатели'),
      openList('engines', 'Двигатели'),
      openCard('engine', 'E1'),
      openCard('engine', 'E1'),
    );
    expect(ids(s)).toEqual(['menu', 'card:engine:E1', 'list:engines']);
  });

  it('«settings» — синглтон, а не список', () => {
    const s = run(createTabsState(), openList('settings', 'Настройки'));
    expect(ids(s)).toEqual(['menu', 'settings']);
    expect(s.tabs[1]?.kind).toBe('settings');
  });

  it('вкладки не заводит только «auth»; «История» — полноценный раздел', () => {
    const base = createTabsState();
    expect(run(base, openList('auth', 'Вход'))).toBe(base);
    const withHistory = run(base, openList('history', 'История'));
    expect(ids(withHistory)).toEqual(['menu', 'list:history']);
    expect(withHistory.activeId).toBe('list:history');
  });

  it('вкладку получает ЛЮБОЙ раздел — белых списков в модели нет', () => {
    const s = run(
      createTabsState(),
      openList('repair_fund_audit', 'Ремфонд'),
      openList('notes', 'Заметки'),
      openList('раздел_которого_нет', 'X'),
    );
    expect(ids(s)).toEqual(['menu', 'list:repair_fund_audit', 'list:notes', 'list:раздел_которого_нет']);
  });

  it('повторный OPEN_LIST обновляет подпись существующей вкладки', () => {
    const s = run(createTabsState(), openList('engines', 'Двигатели'));
    const next = tabsReducer(s, openList('engines', 'Двигатели (12)'));
    expect(ids(next)).toEqual(['menu', 'list:engines']);
    expect(next.tabs[1]?.label).toBe('Двигатели (12)');
  });
});

describe('tabsModel: фокус', () => {
  it('activeId валиден после каждого шага длинного сценария', () => {
    let s = createTabsState();
    const script: TabsAction[] = [
      openList('engines', 'Двигатели'),
      openCard('engine', 'E1'),
      openCard('engine', 'E2'),
      { type: 'CLOSE', id: 'card:engine:E2' },
      { type: 'FOCUS', id: 'list:engines' },
      { type: 'CLOSE_ALL_CARDS' },
      { type: 'RESTORE', cards: [cardRef('engine', 'E9')], focusedCardId: 'card:нет:такой', secondary: null },
      { type: 'FOCUS_SECTION', tabId: 'history' },
      { type: 'CLOSE', id: 'list:engines' },
    ];
    for (const action of script) {
      s = tabsReducer(s, action);
      expect(s.tabs.some((t) => t.id === s.activeId)).toBe(true);
    }
  });

  it('CLOSE активной уводит фокус на соседа слева, дно — МЕНЮ', () => {
    let s = run(createTabsState(), openList('a', 'A'), openList('b', 'B'));
    expect(s.activeId).toBe('list:b');
    s = tabsReducer(s, { type: 'CLOSE', id: 'list:b' });
    expect(s.activeId).toBe('list:a');
    s = tabsReducer(s, { type: 'CLOSE', id: 'list:a' });
    expect(s.activeId).toBe(MENU_TAB_ID);
  });

  it('CLOSE фоновой вкладки фокус не двигает', () => {
    const s = run(createTabsState(), openList('a', 'A'), openCard('engine', 'E1'));
    const next = tabsReducer(s, { type: 'CLOSE', id: 'list:a' });
    expect(next.activeId).toBe('card:engine:E1');
    expect(ids(next)).toEqual(['menu', 'card:engine:E1']);
  });

  it('FOCUS не меняет состав вкладок', () => {
    const s = run(createTabsState(), openList('a', 'A'), openCard('engine', 'E1'), openSingleton('chat', 'Чат'));
    for (const tab of s.tabs) {
      const next = reduceTabs(s, { type: 'FOCUS', id: tab.id });
      expect(next.state.tabs).toBe(s.tabs);
    }
  });

  it('FOCUS на несуществующую вкладку — no-op', () => {
    const s = run(createTabsState(), openList('a', 'A'));
    expect(reduceTabs(s, { type: 'FOCUS', id: 'card:engine:нет' }).state).toBe(s);
  });

  it('FOCUS_SECTION уводит на вкладку раздела, если она открыта, иначе на МЕНЮ', () => {
    const withHistory = run(createTabsState(), openList('history', 'История'), openCard('engine', 'E1'));
    expect(withHistory.activeId).toBe('card:engine:E1');
    expect(tabsReducer(withHistory, { type: 'FOCUS_SECTION', tabId: 'history' }).activeId).toBe('list:history');

    const noHistory = run(createTabsState(), openCard('engine', 'E1'));
    expect(tabsReducer(noHistory, { type: 'FOCUS_SECTION', tabId: 'history' }).activeId).toBe(MENU_TAB_ID);
  });

  it('FOCUS_SECTION вкладок не создаёт', () => {
    const s = run(createTabsState(), openCard('engine', 'E1'));
    const next = tabsReducer(s, { type: 'FOCUS_SECTION', tabId: 'engines' });
    expect(ids(next)).toEqual(['menu', 'card:engine:E1']);
    expect(next.activeId).toBe(MENU_TAB_ID);
  });

  it('focusAfterClose согласован с CLOSE для каждой вкладки', () => {
    const s = run(createTabsState(), openList('a', 'A'), openCard('engine', 'E1'), openCard('engine', 'E2'));
    for (const tab of s.tabs) {
      expect(focusAfterClose(s, tab.id)).toBe(reduceTabs(s, { type: 'CLOSE', id: tab.id }).state.activeId);
    }
  });

  it('OPEN_SINGLETON с focus:false открывает вкладку, не забирая фокус', () => {
    const s = run(createTabsState(), openList('engines', 'Двигатели'), openSingleton('ai_chat', 'ИИваныч', false));
    expect(hasTab(s, 'ai_chat')).toBe(true);
    expect(s.activeId).toBe('list:engines');
  });

  it('OPEN_CARD с focus:false заводит вкладку карточки, но фокус остаётся прежним', () => {
    const s = run(createTabsState(), openCard('engine', 'E1', 'Двигатель E1', false, false));
    expect(ids(s)).toEqual(['menu', 'card:engine:E1']);
    expect(s.activeId).toBe(MENU_TAB_ID);
  });

  it('OPEN_LIST с focus:false заводит вкладку раздела в фоне', () => {
    const s = run(createTabsState(), openCard('engine', 'E1'), openList('engines', 'Двигатели', false));
    expect(ids(s)).toEqual(['menu', 'card:engine:E1', 'list:engines']);
    expect(s.activeId).toBe('card:engine:E1');
  });
});

describe('tabsModel: лимит карточек', () => {
  it('девятая карточка отклоняется, состав вкладок не меняется', () => {
    let s = createTabsState();
    for (let i = 0; i < MAX_CARD_TABS; i += 1) s = tabsReducer(s, openCard('engine', `E${i}`));
    const res = reduceTabs(s, openCard('engine', 'E999'));
    expect(res.rejected).toBe('card_limit');
    expect(res.state.tabs).toBe(s.tabs);
    expect(cardCount(res.state)).toBe(MAX_CARD_TABS);
    expect(res.state.tabs[1]?.id).toBe('card:engine:E0');
  });

  it('отказ не молчит: notice поднимается и seq растёт в серии отказов', () => {
    let s = createTabsState();
    for (let i = 0; i < MAX_CARD_TABS; i += 1) s = tabsReducer(s, openCard('engine', `E${i}`));
    const first = tabsReducer(s, openCard('engine', 'X1'));
    expect(first.notice).toEqual({ code: 'card_limit', seq: 1 });
    const second = tabsReducer(first, openCard('engine', 'X2'));
    expect(second.notice).toEqual({ code: 'card_limit', seq: 2 });
    const dismissed = tabsReducer(second, { type: 'DISMISS_NOTICE' });
    expect(dismissed.notice).toBeNull();
    expect(tabsReducer(dismissed, openCard('engine', 'X3')).notice).toEqual({ code: 'card_limit', seq: 1 });
  });

  it('рефокус уже открытой карточки лимитом не гейтится', () => {
    let s = createTabsState();
    for (let i = 0; i < MAX_CARD_TABS; i += 1) s = tabsReducer(s, openCard('engine', `E${i}`));
    const res = reduceTabs(s, openCard('engine', 'E0'));
    expect(res.rejected).toBeNull();
    expect(res.state.activeId).toBe('card:engine:E0');
    expect(cardCount(res.state)).toBe(MAX_CARD_TABS);
  });

  it('canOpenCardTab: на полном лимите новую нельзя, уже открытую можно', () => {
    let s = createTabsState();
    for (let i = 0; i < MAX_CARD_TABS; i += 1) s = tabsReducer(s, openCard('engine', `E${i}`));
    expect(canOpenCardTab(s, 'engine', 'НОВАЯ')).toBe(false);
    expect(canOpenCardTab(s, 'engine', 'E3')).toBe(true);
  });
});

describe('tabsModel: заголовки', () => {
  it('фолбэк «Вид · id6» не затирает уже резолвнутый заголовок', () => {
    const s = run(createTabsState(), openCard('engine', 'E1', '⚙️ 123', false));
    const next = tabsReducer(s, openCard('engine', 'E1', 'Двигатель · abc123', true));
    expect(next.tabs[1]?.label).toBe('⚙️ 123');
    expect(next).toBe(s);
  });

  it('резолвнутый заголовок заменяет фолбэк', () => {
    const s = run(createTabsState(), openCard('engine', 'E1', 'Двигатель · abc123', true));
    const next = tabsReducer(s, {
      type: 'RETITLE',
      id: cardTabId('engine', 'E1'),
      title: '⚙️ 123',
      titleIsFallback: false,
    });
    expect(next.tabs[1]?.label).toBe('⚙️ 123');
  });

  it('RETITLE не меняет фокус', () => {
    const s = run(createTabsState(), openCard('engine', 'E1', 'Двигатель · abc123', true), {
      type: 'FOCUS',
      id: MENU_TAB_ID,
    });
    const next = tabsReducer(s, {
      type: 'RETITLE',
      id: cardTabId('engine', 'E1'),
      title: '⚙️ 123',
      titleIsFallback: false,
    });
    expect(next.activeId).toBe(MENU_TAB_ID);
    expect(next.tabs[1]?.label).toBe('⚙️ 123');
  });

  it('RETITLE переименовывает и не-карточную вкладку', () => {
    const s = run(createTabsState(), openList('engines', 'Двигатели'));
    const next = tabsReducer(s, {
      type: 'RETITLE',
      id: listTabId('engines'),
      title: 'Двигатели · 1600',
      titleIsFallback: false,
    });
    expect(next.tabs[1]?.label).toBe('Двигатели · 1600');
    expect(next.activeId).toBe('list:engines');
  });

  it('RETITLE несуществующей вкладки — no-op', () => {
    const s = run(createTabsState(), openList('engines', 'Двигатели'));
    expect(reduceTabs(s, { type: 'RETITLE', id: 'card:engine:нет', title: 'X', titleIsFallback: false }).state).toBe(s);
  });
});

describe('tabsModel: ключи вкладок', () => {
  it('round-trip ключа карточки переживает entityId с двоеточиями', () => {
    expect(parseTabId(cardTabId('engine', 'a:b:c'))).toEqual({
      kind: 'card',
      cardKind: 'engine',
      entityId: 'a:b:c',
    });
    expect(parseTabId(listTabId('stock_documents'))).toEqual({ kind: 'list', tabId: 'stock_documents' });
    expect(parseTabId('menu')).toEqual({ kind: 'menu' });
    expect(parseTabId('ai_chat')).toEqual({ kind: 'ai_chat' });
  });

  it('битые ключи не разбираются', () => {
    expect(parseTabId('card:engine')).toBeNull();
    expect(parseTabId('card:engine:')).toBeNull();
    expect(parseTabId('card::1')).toBeNull();
    expect(parseTabId('list:')).toBeNull();
    expect(parseTabId('мусор')).toBeNull();
  });

  it('ключ персиста конвертируется в id вкладки и обратно', () => {
    expect(tabIdFromSessionKey(cardSessionKey('engine', 'a:b'))).toBe(cardTabId('engine', 'a:b'));
    expect(tabIdFromSessionKey('engine')).toBeNull();
    expect(tabIdFromSessionKey(':x')).toBeNull();
  });
});

describe('tabsModel: вторая панель', () => {
  it('карточка не может быть одновременно активной и во второй панели', () => {
    const active = run(createTabsState(), openCard('engine', 'E1'));
    expect(reduceTabs(active, { type: 'SET_SECONDARY', card: cardRef('engine', 'E1') }).state).toBe(active);
    const parked = run(active, { type: 'FOCUS', id: MENU_TAB_ID }, {
      type: 'SET_SECONDARY',
      card: cardRef('engine', 'E1'),
    });
    expect(parked.secondary?.id).toBe(cardTabId('engine', 'E1'));
    expect(tabsReducer(parked, { type: 'FOCUS', id: cardTabId('engine', 'E1') }).secondary).toBeNull();
  });

  it('CLOSE вкладки, лежащей во второй панели, панель обнуляет', () => {
    const s = run(
      createTabsState(),
      openCard('engine', 'E1'),
      openCard('engine', 'E2'),
      { type: 'SET_SECONDARY', card: cardRef('engine', 'E1') },
    );
    expect(s.secondary?.id).toBe(cardTabId('engine', 'E1'));
    expect(tabsReducer(s, { type: 'CLOSE', id: cardTabId('engine', 'E1') }).secondary).toBeNull();
  });
});

describe('tabsModel: сессия и сброс', () => {
  it('RESTORE заменяет только карточки, сохраняя открытые синглтоны и списки', () => {
    const s = run(
      createTabsState(),
      openSingleton('ai_chat', 'ИИваныч', false),
      openList('engines', 'Двигатели'),
      openCard('engine', 'СТАРАЯ'),
    );
    const next = tabsReducer(s, {
      type: 'RESTORE',
      cards: [cardRef('engine', 'E1'), cardRef('work_order', 'W1')],
      focusedCardId: cardTabId('work_order', 'W1'),
      secondary: null,
    });
    expect(ids(next)).toEqual([
      'menu',
      'ai_chat',
      'card:engine:E1',
      'card:work_order:W1',
      'list:engines',
    ]);
    expect(next.activeId).toBe(cardTabId('work_order', 'W1'));
  });

  it('RESTORE обрезает сессию громко и отбрасывает битые карточки', () => {
    const cards: CardRef[] = Array.from({ length: 12 }, (_, i) => cardRef('engine', `E${i}`));
    cards.push({ cardKind: '  ', entityId: '', title: 'мусор', titleIsFallback: false });
    const res = reduceTabs(createTabsState(), {
      type: 'RESTORE',
      cards,
      focusedCardId: null,
      secondary: null,
    });
    expect(res.rejected).toBe('card_limit');
    expect(cardCount(res.state)).toBe(MAX_CARD_TABS);
    expect(res.state.notice?.code).toBe('card_limit');
  });

  it('RESTORE с невалидным focusedCardId не оставляет фокус в пустоте', () => {
    const s = run(createTabsState(), openCard('engine', 'СТАРАЯ'));
    const next = tabsReducer(s, {
      type: 'RESTORE',
      cards: [cardRef('engine', 'E1')],
      focusedCardId: 'card:engine:НЕТ',
      secondary: null,
    });
    expect(next.activeId).toBe(MENU_TAB_ID);
    expect(ids(next)).toEqual(['menu', 'card:engine:E1']);
  });

  it('RESTORE не кладёт одну карточку и в фокус, и во вторую панель', () => {
    const res = reduceTabs(createTabsState(), {
      type: 'RESTORE',
      cards: [cardRef('engine', 'E1')],
      focusedCardId: cardTabId('engine', 'E1'),
      secondary: cardRef('engine', 'E1'),
    });
    expect(res.state.activeId).toBe(cardTabId('engine', 'E1'));
    expect(res.state.secondary).toBeNull();
  });

  it('RESET оставляет только МЕНЮ, сохраняя его подпись', () => {
    const s = run(
      createTabsState('МЕНЮ'),
      openList('engines', 'Двигатели'),
      openCard('engine', 'E1'),
      { type: 'SET_SECONDARY', card: cardRef('engine', 'E2') },
    );
    const next = tabsReducer(s, { type: 'RESET' });
    expect(ids(next)).toEqual(['menu']);
    expect(next.tabs[0]?.label).toBe('МЕНЮ');
    expect(next.activeId).toBe(MENU_TAB_ID);
    expect(next.secondary).toBeNull();
    expect(next.notice).toBeNull();
  });

  it('снимок персиста выводится из tabs и activeId', () => {
    const s = run(
      createTabsState(),
      openCard('engine', 'E1', '⚙️ 123'),
      openCard('work_order', 'W1', '🛠 Наряд № 7'),
      { type: 'SET_SECONDARY', card: cardRef('engine', 'E1', '⚙️ 123') },
    );
    expect(sessionCards(s)).toEqual([
      { kind: 'engine', entityId: 'E1', title: '⚙️ 123' },
      { kind: 'work_order', entityId: 'W1', title: '🛠 Наряд № 7' },
    ]);
    expect(focusedCardKey(s)).toBe('work_order:W1');
    expect(sessionSecondaryCard(s)).toEqual({ kind: 'engine', entityId: 'E1', title: '⚙️ 123' });
    expect(focusedCardKey(tabsReducer(s, { type: 'FOCUS', id: MENU_TAB_ID }))).toBeNull();
  });
});

describe('tabsModel: восстановление полосы из сессии (RESTORE_SESSION)', () => {
  function restore(
    tabs: RestoredTab[],
    activeId: string | null = null,
    secondary: CardRef | null = null,
  ): TabsAction {
    return { type: 'RESTORE_SESSION', tabs, activeId, secondary };
  }

  it('восстанавливает состав: списки, карточки и синглтоны', () => {
    const s = run(
      createTabsState(),
      restore(
        [
          { kind: 'list', tabId: 'engines', label: 'Двигатели' },
          { kind: 'card', card: cardRef('engine', 'E1') },
          { kind: 'chat', label: 'Чат' },
        ],
        'card:engine:E1',
      ),
    );
    expect(ids(s)).toEqual([MENU_TAB_ID, 'chat', 'card:engine:E1', 'list:engines']);
    expect(s.activeId).toBe('card:engine:E1');
  });

  it('аддитивно: вкладка, открытая до восстановления, не закрывается и не дублируется', () => {
    const before = run(createTabsState(), openList('notes', 'Заметки'), openSingleton('ai_chat', 'ИИваныч'));
    const s = tabsReducer(
      before,
      restore([
        { kind: 'list', tabId: 'engines', label: 'Двигатели' },
        { kind: 'list', tabId: 'notes', label: 'Заметки' },
      ]),
    );
    expect(ids(s)).toEqual([MENU_TAB_ID, 'ai_chat', 'list:notes', 'list:engines']);
    expect(s.activeId).toBe(before.activeId);
  });

  it('карточки сверх лимита не открываются: notice и rejected, состав не вытесняется', () => {
    const full = run(
      createTabsState(),
      ...Array.from({ length: MAX_CARD_TABS }, (_, i) => openCard('engine', `E${i}`)),
    );
    const r = reduceTabs(full, restore([{ kind: 'card', card: cardRef('engine', 'LATE') }]));
    expect(r.rejected).toBe('card_limit');
    expect(cardCount(r.state)).toBe(MAX_CARD_TABS);
    expect(r.state.notice?.code).toBe('card_limit');
    expect(hasTab(r.state, cardTabId('engine', 'LATE'))).toBe(false);
  });

  it('activeId несуществующей вкладки игнорируется — активная остаётся прежней', () => {
    const before = run(createTabsState(), openList('notes', 'Заметки'));
    const s = tabsReducer(before, restore([{ kind: 'list', tabId: 'engines', label: 'Двигатели' }], 'list:missing'));
    expect(s.activeId).toBe('list:notes');
    expect(hasTab(s, 'list:engines')).toBe(true);
  });

  it('вторая панель не совпадает с активной вкладкой', () => {
    const s = run(
      createTabsState(),
      restore([{ kind: 'card', card: cardRef('engine', 'E1') }], 'card:engine:E1', cardRef('engine', 'E1')),
    );
    expect(s.secondary).toBeNull();
    const other = run(
      createTabsState(),
      restore([{ kind: 'card', card: cardRef('engine', 'E1') }], 'card:engine:E1', cardRef('engine', 'E2')),
    );
    expect(other.secondary?.entityId).toBe('E2');
  });

  it('пустой payload не меняет состояние (ссылка та же)', () => {
    const before = run(createTabsState(), openList('engines', 'Двигатели'));
    expect(tabsReducer(before, restore([]))).toBe(before);
  });

  it('раздел без вкладки (экран входа) не восстанавливается', () => {
    const s = run(createTabsState(), restore([{ kind: 'list', tabId: 'auth', label: 'Вход' }]));
    expect(ids(s)).toEqual([MENU_TAB_ID]);
  });

  it('round-trip: sessionTabs → RESTORE_SESSION даёт тот же состав', () => {
    const before = run(
      createTabsState(),
      openList('engines', 'Двигатели'),
      openCard('engine', 'E1', 'Д-41'),
      openSingleton('chat', 'Чат'),
    );
    const snapshot = sessionTabs(before);
    expect(snapshot).toEqual([
      { kind: 'chat' },
      { kind: 'card', card: { kind: 'engine', entityId: 'E1', title: 'Д-41' } },
      { kind: 'list', tabId: 'engines' },
    ]);
    const restored = run(
      createTabsState(),
      restore(
        snapshot.map((t): RestoredTab => {
          if (t.kind === 'list') return { kind: 'list', tabId: t.tabId, label: 'Двигатели' };
          if (t.kind === 'card') return { kind: 'card', card: { ...t.card, cardKind: t.card.kind, titleIsFallback: false } };
          return { kind: t.kind, label: t.kind === 'chat' ? 'Чат' : t.kind };
        }),
        before.activeId,
      ),
    );
    expect(ids(restored)).toEqual(ids(before));
    expect(restored.activeId).toBe(before.activeId);
  });

  it('sessionTabs не пишет МЕНЮ — он есть всегда', () => {
    expect(sessionTabs(createTabsState())).toEqual([]);
  });
});

describe('tabsModel: закрытие и идемпотентность', () => {
  it('карточка исчезает только по явному закрытию', () => {
    const s = run(createTabsState(), openCard('engine', 'E1'), openCard('engine', 'E2'));
    const harmless: TabsAction[] = [
      { type: 'FOCUS', id: MENU_TAB_ID },
      { type: 'FOCUS_SECTION', tabId: 'history' },
      { type: 'RETITLE', id: cardTabId('engine', 'E1'), title: 'Новое имя', titleIsFallback: false },
      openList('engines', 'Двигатели'),
      openSingleton('chat', 'Чат'),
      { type: 'SET_SECONDARY', card: null },
      { type: 'DISMISS_NOTICE' },
      openCard('engine', 'E3'),
    ];
    for (const action of harmless) {
      expect(cardCount(tabsReducer(s, action))).toBeGreaterThanOrEqual(cardCount(s));
    }
    expect(cardCount(tabsReducer(s, { type: 'CLOSE_CARD', cardKind: 'engine', entityId: 'E1' }))).toBe(1);
    expect(cardCount(tabsReducer(s, { type: 'CLOSE_ALL_CARDS' }))).toBe(0);
  });

  it('CLOSE_ALL_CARDS уводит фокус с закрытой карточки на МЕНЮ', () => {
    const s = run(createTabsState(), openList('engines', 'Двигатели'), openCard('engine', 'E1'));
    const next = tabsReducer(s, { type: 'CLOSE_ALL_CARDS' });
    expect(ids(next)).toEqual(['menu', 'list:engines']);
    expect(next.activeId).toBe(MENU_TAB_ID);
  });

  it('действия без изменений возвращают ту же ссылку на state', () => {
    const s = run(createTabsState(), openList('engines', 'Двигатели'), openSingleton('chat', 'Чат', false));
    expect(reduceTabs(s, openList('engines', 'Двигатели')).state).toBe(s);
    expect(reduceTabs(s, { type: 'CLOSE', id: 'card:engine:нет' }).state).toBe(s);
    expect(reduceTabs(s, { type: 'CLOSE', id: 'ai_chat' }).state).toBe(s);
    expect(reduceTabs(s, { type: 'RETITLE', id: 'list:engines', title: 'Двигатели', titleIsFallback: false }).state).toBe(s);
    expect(reduceTabs(s, { type: 'DISMISS_NOTICE' }).state).toBe(s);
    expect(reduceTabs(s, { type: 'SET_SECONDARY', card: null }).state).toBe(s);
    expect(reduceTabs(s, { type: 'FOCUS_SECTION', tabId: 'engines' }).state).toBe(s);
  });

  it('пустые входы вкладок-призраков не создают', () => {
    const base = createTabsState();
    expect(run(base, openList('   ', 'X'))).toBe(base);
    expect(run(base, openCard('engine', '   '))).toBe(base);
    expect(run(base, openCard('   ', 'E1'))).toBe(base);
  });
});

describe('tabsModel: ответы оболочке', () => {
  it('подсветка раздела МЕНЮ берётся от активной вкладки, а не от первой list-вкладки', () => {
    const s = run(createTabsState(), openList('engines', 'Двигатели'), openCard('work_order', 'W1'));
    expect(activeMenuSourceTabId(s)).toBe('work_order');
    expect(activeMenuSourceTabId(tabsReducer(s, { type: 'FOCUS', id: 'list:engines' }))).toBe('engines');
    expect(activeMenuSourceTabId(tabsReducer(s, { type: 'FOCUS', id: MENU_TAB_ID }))).toBeNull();
  });

  it('порог предупреждения считает вкладки один раз', () => {
    expect(shouldWarnTabsCount(5)).toBe(false);
    expect(shouldWarnTabsCount(6)).toBe(true);
    const s = run(createTabsState(), openList('a', 'A'), openList('b', 'B'), openList('c', 'C'), openList('d', 'D'));
    expect(s.tabs).toHaveLength(5);
    expect(shouldWarnTabsCount(s.tabs.length)).toBe(false);
  });

  it('идентичность активной карточки одна и производная', () => {
    const s = run(createTabsState(), openCard('engine', 'E1'));
    expect(activeCardTab(s)?.cardKind).toBe('engine');
    expect(activeCardTab(s)?.entityId).toBe('E1');
    expect(cardTabs(s)).toHaveLength(1);
    expect(activeCardTab(tabsReducer(s, { type: 'FOCUS', id: MENU_TAB_ID }))).toBeNull();
  });
});
