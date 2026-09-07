import { describe, expect, it } from 'vitest';

import {
  CLIENT_OPS_SHORTCUT_ID,
  isBuiltinShortcutId,
  sanitizeDesktopSection,
  stripBuiltinDesktopShortcuts,
  withBuiltinDesktopShortcuts,
  type UserUiProfileDesktop,
} from './desktop.js';

// Скрипты обслуживания должны лежать на Верстаке у ВСЕХ (решение владельца 07.09.2026).
// Разложить их по 149 профилям нельзя: секция Верстака — LWW, клиент пушит свою целиком,
// и разложенная плитка живёт до первого пуша. Поэтому плитка вычисляется при отрисовке.
const empty: UserUiProfileDesktop = {
  shortcuts: [],
  folders: [],
  layout: { chatPct: 33, peoplePct: 30 },
};

const withOwn: UserUiProfileDesktop = {
  ...empty,
  shortcuts: [
    { id: 'own-1', label: 'Наряды', icon: '🛠', folderId: null, deletedAt: null, createdAt: 1 },
  ],
};

describe('встроенная плитка «Скрипты обслуживания»', () => {
  it('появляется у всех, даже на пустом Верстаке', () => {
    const shown = withBuiltinDesktopShortcuts(empty);
    expect(shown.shortcuts.map((s) => s.id)).toEqual([CLIENT_OPS_SHORTCUT_ID]);
    expect(shown.shortcuts[0]?.label).toBe('Скрипты обслуживания');
  });

  it('не вытесняет собственные ярлыки — встаёт первой', () => {
    const shown = withBuiltinDesktopShortcuts(withOwn);
    expect(shown.shortcuts.map((s) => s.id)).toEqual([CLIENT_OPS_SHORTCUT_ID, 'own-1']);
  });

  it('исходную секцию не портит: подмешивание не мутирует профиль', () => {
    withBuiltinDesktopShortcuts(withOwn);
    expect(withOwn.shortcuts.map((s) => s.id)).toEqual(['own-1']);
  });

  it('перед записью вырезается — в профиле встроенных ярлыков не бывает', () => {
    const shown = withBuiltinDesktopShortcuts(withOwn);
    expect(stripBuiltinDesktopShortcuts(shown).shortcuts.map((s) => s.id)).toEqual(['own-1']);
  });

  it('вырезание — тождество, если встроенных нет (лишней записи профиля не будет)', () => {
    expect(stripBuiltinDesktopShortcuts(withOwn)).toBe(withOwn);
  });

  it('санитайзер не пускает встроенный id в хранимую секцию', () => {
    // Клиент старой/сломанной версии мог бы сохранить плитку себе — и она осталась бы у него
    // навсегда, даже если из кода её убрать.
    const raw = {
      shortcuts: [
        { id: CLIENT_OPS_SHORTCUT_ID, label: 'Скрипты обслуживания', icon: '🧰', createdAt: 1 },
        { id: 'own-1', label: 'Наряды', icon: '🛠', createdAt: 1 },
      ],
      folders: [],
      layout: { chatPct: 33, peoplePct: 30 },
    };
    const sanitized = sanitizeDesktopSection(raw);
    expect(sanitized?.shortcuts.map((s) => s.id)).toEqual(['own-1']);
  });

  it('признак встроенного ярлыка не задевает обычные id', () => {
    expect(isBuiltinShortcutId(CLIENT_OPS_SHORTCUT_ID)).toBe(true);
    expect(isBuiltinShortcutId('own-1')).toBe(false);
    expect(isBuiltinShortcutId('')).toBe(false);
    expect(isBuiltinShortcutId(null)).toBe(false);
  });
});
