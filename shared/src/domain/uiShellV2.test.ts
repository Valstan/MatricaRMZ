import { describe, expect, it } from 'vitest';

import {
  DEFAULT_UI_SHELL_PREFS,
  V3_MAX_CARD_TABS,
  sanitizeUiShellPrefs,
  sanitizeV3Prefs,
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

  it('дефолт v3: без карточек, активна вкладка «РАЗДЕЛЫ»', () => {
    const prefs = sanitizeUiShellPrefs(null);
    expect(prefs.v3.session.openCards).toEqual([]);
    expect(prefs.v3.session.activeKey).toBe('sections');
  });

  it('activeKey карточки валиден только если карточка открыта; иначе откат на sections', () => {
    const withCard = sanitizeV3Prefs({
      session: { openCards: [{ kind: 'engine', entityId: 'x', title: 'Д-41' }], activeKey: 'engine:x' },
    });
    expect(withCard.session.activeKey).toBe('engine:x');
    const stale = sanitizeV3Prefs({ session: { openCards: [], activeKey: 'engine:x' } });
    expect(stale.session.activeKey).toBe('sections');
    expect(sanitizeV3Prefs({ session: { openCards: [], activeKey: 'list' } }).session.activeKey).toBe('list');
  });

  it('проценты сплитов: дефолты 25/50, кламп 15..85, мусор → дефолт', () => {
    const def = sanitizeV3Prefs(null);
    expect(def.splitPct).toBe(25);
    expect(def.comparePct).toBe(50);
    const p = sanitizeV3Prefs({ session: { openCards: [], activeKey: 'sections' }, splitPct: 40, comparePct: 5 });
    expect(p.splitPct).toBe(40);
    expect(p.comparePct).toBe(15);
    expect(sanitizeV3Prefs({ splitPct: 99 }).splitPct).toBe(85);
    expect(sanitizeV3Prefs({ splitPct: 'мусор' }).splitPct).toBe(25);
  });

  it('открытые карточки обрезаются лимитом V3_MAX_CARD_TABS (8)', () => {
    const cards = Array.from({ length: 12 }, (_, i) => ({ kind: 'engine', entityId: `e${i}`, title: `t${i}` }));
    const prefs = sanitizeV3Prefs({ session: { openCards: cards, activeKey: 'sections' } });
    expect(prefs.session.openCards).toHaveLength(V3_MAX_CARD_TABS);
  });

  it('лимиты: 10 всего (2 закреплённые + 8 карточек), предупреждение при >5 открытых', () => {
    expect(v3TotalTabs(0)).toBe(2);
    expect(v3CanOpenCard(V3_MAX_CARD_TABS - 1)).toBe(true);
    expect(v3CanOpenCard(V3_MAX_CARD_TABS)).toBe(false);
    expect(v3ShowTabsWarning(3)).toBe(false); // 5 всего — ещё тихо
    expect(v3ShowTabsWarning(4)).toBe(true); // 6 всего — предупреждаем
  });
});
