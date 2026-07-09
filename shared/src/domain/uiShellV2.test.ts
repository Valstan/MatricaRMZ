import { describe, expect, it } from 'vitest';

import { DEFAULT_UI_SHELL_PREFS, sanitizeUiShellPrefs } from './uiShellV2.js';

describe('sanitizeUiShellPrefs — дефолт «Резиновый» (v2), явный откат на v1 запоминается', () => {
  it('нет сохранённой записи → v2', () => {
    expect(sanitizeUiShellPrefs(null).shellVersion).toBe('v2');
    expect(sanitizeUiShellPrefs(undefined).shellVersion).toBe('v2');
  });

  it('DEFAULT_UI_SHELL_PREFS — v2', () => {
    expect(DEFAULT_UI_SHELL_PREFS.shellVersion).toBe('v2');
  });

  it('явный выбор v1 (возврат на старый интерфейс) сохраняется', () => {
    expect(sanitizeUiShellPrefs({ shellVersion: 'v1' }).shellVersion).toBe('v1');
  });

  it('явный выбор v2 сохраняется', () => {
    expect(sanitizeUiShellPrefs({ shellVersion: 'v2' }).shellVersion).toBe('v2');
  });

  it('блоб без поля / с мусором → v2 (только литеральный v1 читается как v1)', () => {
    expect(sanitizeUiShellPrefs({}).shellVersion).toBe('v2');
    expect(sanitizeUiShellPrefs({ shellVersion: 'garbage' }).shellVersion).toBe('v2');
  });

  it('v2-настройки (layout/session) переживают sanitize вместе с выбором оболочки', () => {
    const prefs = sanitizeUiShellPrefs({
      shellVersion: 'v1',
      v2: {
        columnOrder: ['lists', 'workspace', 'buttons'],
        session: { openCards: [{ kind: 'engine', entityId: 'x', title: 't' }], focusedKey: 'engine:x', secondary: null },
      },
    });
    expect(prefs.shellVersion).toBe('v1');
    expect(prefs.v2.columnOrder).toEqual(['lists', 'workspace', 'buttons']);
    expect(prefs.v2.session.openCards).toHaveLength(1);
  });
});
