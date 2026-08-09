import { describe, expect, it } from 'vitest';

import {
  DEFAULT_UI_SHELL_PREFS,
  V3_MAX_CARD_TABS,
  sanitizeUiShellPrefs,
  sanitizeV3Prefs,
  sanitizeV3Session,
  v3CanOpenCard,
  v3ShowTabsWarning,
  v3TotalTabs,
} from './uiShellV2.js';

describe('sanitizeUiShellPrefs — v3 «Вкладки» единственная оболочка (этап 6)', () => {
  it('нет сохранённой записи → v3', () => {
    expect(sanitizeUiShellPrefs(null).shellVersion).toBe('v3');
    expect(sanitizeUiShellPrefs(undefined).shellVersion).toBe('v3');
  });

  it('DEFAULT_UI_SHELL_PREFS — v3', () => {
    expect(DEFAULT_UI_SHELL_PREFS.shellVersion).toBe('v3');
  });

  it('легаси-выборы v1/v2 и мусор → v3 (старые оболочки снесены)', () => {
    expect(sanitizeUiShellPrefs({ shellVersion: 'v1' }).shellVersion).toBe('v3');
    expect(sanitizeUiShellPrefs({ shellVersion: 'v2' }).shellVersion).toBe('v3');
    expect(sanitizeUiShellPrefs({}).shellVersion).toBe('v3');
    expect(sanitizeUiShellPrefs({ shellVersion: 'garbage' }).shellVersion).toBe('v3');
  });

  it('v2-настройки (layout/session) переживают sanitize — v3 живёт на них', () => {
    const prefs = sanitizeUiShellPrefs({
      shellVersion: 'v1',
      v2: {
        columnOrder: ['lists', 'workspace', 'buttons'],
        session: { openCards: [{ kind: 'engine', entityId: 'x', title: 't' }], focusedKey: 'engine:x', secondary: null },
      },
    });
    expect(prefs.shellVersion).toBe('v3');
    expect(prefs.v2.columnOrder).toEqual(['lists', 'workspace', 'buttons']);
    expect(prefs.v2.session.openCards).toHaveLength(1);
  });
});

describe('v3 «Вкладки»: sanitize + лимиты вкладок', () => {
  it('любое значение shellVersion → v3', () => {
    expect(sanitizeUiShellPrefs({ shellVersion: 'v3' }).shellVersion).toBe('v3');
    expect(sanitizeUiShellPrefs({ shellVersion: 'v4' }).shellVersion).toBe('v3');
  });

  it('дефолт v3: пустая полоса, активная вкладка не задана', () => {
    const prefs = sanitizeUiShellPrefs(null);
    expect(prefs.v3.session.tabs).toEqual([]);
    expect(prefs.v3.session.activeId).toBe('');
    expect(prefs.v3.session.secondaryCard).toBeNull();
  });

  it('состав полосы переживает sanitize: списки, карточки, синглтоны', () => {
    const s = sanitizeV3Session({
      tabs: [
        { kind: 'list', tabId: 'engines' },
        { kind: 'card', card: { kind: 'engine', entityId: 'x', title: 'Д-41' } },
        { kind: 'chat' },
        { kind: 'ai_chat' },
        { kind: 'settings' },
      ],
      activeId: 'card:engine:x',
      secondaryCard: { kind: 'engine', entityId: 'y', title: 'Д-65' },
    });
    expect(s.tabs).toHaveLength(5);
    expect(s.tabs[0]).toEqual({ kind: 'list', tabId: 'engines' });
    expect(s.tabs[1]).toEqual({ kind: 'card', card: { kind: 'engine', entityId: 'x', title: 'Д-41' } });
    expect(s.activeId).toBe('card:engine:x');
    expect(s.secondaryCard?.entityId).toBe('y');
  });

  it('незнакомый вид вкладки и битые записи отбрасываются', () => {
    const s = sanitizeV3Session({
      tabs: [
        { kind: 'game' },
        { kind: 'list', tabId: '   ' },
        { kind: 'card', card: { kind: 'engine', entityId: '' } },
        'мусор',
        null,
        { kind: 'list', tabId: 'notes' },
      ],
    });
    expect(s.tabs).toEqual([{ kind: 'list', tabId: 'notes' }]);
  });

  it('дубли схлопываются: один список на раздел, один синглтон на вид, одна карточка на сущность', () => {
    const s = sanitizeV3Session({
      tabs: [
        { kind: 'list', tabId: 'engines' },
        { kind: 'list', tabId: 'engines' },
        { kind: 'chat' },
        { kind: 'chat' },
        { kind: 'card', card: { kind: 'engine', entityId: 'x', title: 'a' } },
        { kind: 'card', card: { kind: 'engine', entityId: 'x', title: 'b' } },
      ],
    });
    expect(s.tabs).toHaveLength(3);
    expect(s.tabs.filter((t) => t.kind === 'card')).toHaveLength(1);
  });

  it('карточки обрезаются лимитом V3_MAX_CARD_TABS (8), списки — НЕ обрезаются', () => {
    const s = sanitizeV3Session({
      tabs: [
        ...Array.from({ length: 12 }, (_, i) => ({ kind: 'card', card: { kind: 'engine', entityId: `e${i}`, title: `t${i}` } })),
        ...Array.from({ length: 9 }, (_, i) => ({ kind: 'list', tabId: `section${i}` })),
      ],
    });
    expect(s.tabs.filter((t) => t.kind === 'card')).toHaveLength(V3_MAX_CARD_TABS);
    expect(s.tabs.filter((t) => t.kind === 'list')).toHaveLength(9);
  });

  it('activeId отсутствует или не строка → пустая строка (никогда не "undefined")', () => {
    expect(sanitizeV3Session({ tabs: [] }).activeId).toBe('');
    expect(sanitizeV3Session({ tabs: [], activeId: 42 }).activeId).toBe('');
    expect(sanitizeV3Session({ tabs: [], activeId: '  list:notes  ' }).activeId).toBe('list:notes');
  });

  it('старый формат сессии (openCards/activeKey) читается как пустая полоса — сработает legacy-фолбэк', () => {
    const s = sanitizeV3Session({ openCards: [{ kind: 'engine', entityId: 'x', title: 't' }], activeKey: 'engine:x' });
    expect(s.tabs).toEqual([]);
    expect(s.activeId).toBe('');
  });

  it('round-trip: санитайз санитайзнутого не меняет сессию', () => {
    const once = sanitizeV3Session({
      tabs: [{ kind: 'list', tabId: 'engines' }, { kind: 'settings' }],
      activeId: 'list:engines',
      secondaryCard: { kind: 'engine', entityId: 'y', title: 'Д-65' },
    });
    expect(sanitizeV3Session(once)).toEqual(once);
  });

  it('проценты сплитов: ширина разделов null (по кнопкам), сравнение 50, кламп 15..85', () => {
    const def = sanitizeV3Prefs(null);
    expect(def.sectionsPct).toBeNull();
    expect(def.comparePct).toBe(50);
    const p = sanitizeV3Prefs({ session: { tabs: [], activeId: '' }, sectionsPct: 40, comparePct: 5 });
    expect(p.sectionsPct).toBe(40);
    expect(p.comparePct).toBe(15);
    expect(sanitizeV3Prefs({ sectionsPct: 99 }).sectionsPct).toBe(85);
    expect(sanitizeV3Prefs({ sectionsPct: 'мусор' }).sectionsPct).toBe(25);
  });

  it('лимиты: 10 всего (2 закреплённые + 8 карточек), предупреждение при >5 открытых', () => {
    expect(v3TotalTabs(0)).toBe(2);
    expect(v3CanOpenCard(V3_MAX_CARD_TABS - 1)).toBe(true);
    expect(v3CanOpenCard(V3_MAX_CARD_TABS)).toBe(false);
    expect(v3ShowTabsWarning(3)).toBe(false); // 5 всего — ещё тихо
    expect(v3ShowTabsWarning(4)).toBe(true); // 6 всего — предупреждаем
  });
});
