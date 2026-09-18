import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { POPUP_Z_INDEX } from './PopupLayer.js';

// Сторож этажа всплывающих меню.
//
// Владелец 18.09.2026 (планшет): «всплывающее меню уходит на задний план, под список».
// Корень — не маленькое число `z-index`, а КОНТЕКСТ НАЛОЖЕНИЯ предка: меню кнопочной
// панели живёт внутри `.v3-menu-overlay` (z-index 40), меню тулбара — внутри липкой
// шапки, меню строки — внутри вкладки. Любое число внутри такого предка не поднимает
// меню выше самого предка, поэтому лечение — портал в `body` (`PopupLayer`).
//
// Порвать это молча легко: достаточно «починить» меню обратно на `position:absolute`
// или вернуть локальный `zIndex`. Ни типы, ни линт этого не заметят — на десктопе
// в большинстве мест меню всё равно будет видно.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

/** Меню, которые ОБЯЗАНЫ рисоваться порталом. Файл → как выглядит его меню в коде. */
const PORTALED = [
  ['./ListContextMenu.tsx', 'меню строки списка и меню аккаунта'],
  ['./ColumnSettingsButton.tsx', '«Колонки списка»'],
  ['./PageToolbar.tsx', '«Ещё кнопки» тулбара'],
  ['./WarehouseDocumentStatusFilterDropdown.tsx', 'отбор статусов документов'],
  ['../shellV2/ButtonPanel.tsx', 'меню кнопки в панели МЕНЮ'],
  ['../pages/HistoryPage.tsx', 'меню ярлыка «Моего круга»'],
  ['../pages/ReportsCatalogPage.tsx', 'меню отчёта в каталоге'],
] as const;

describe('всплывающие меню живут в портале поверх окна', () => {
  for (const [file, what] of PORTALED) {
    it(`${what} рисуется через PopupLayer`, () => {
      const text = src(file);
      expect(text, `${file}: пропал импорт PopupLayer`).toContain('PopupLayer');
      expect(text, `${file}: меню больше не обёрнуто в <PopupLayer>`).toContain('<PopupLayer>');
    });
  }

  it('этаж меню выше всех диалогов приложения', () => {
    // Самый высокий слой, кроме меню: смена аккаунта и !important-слой global.css.
    expect(POPUP_Z_INDEX).toBeGreaterThan(12000);
  });

  it('CSS-меню кнопочной панели стоит на том же этаже, что и портал', () => {
    const css = src('../shellV2/buttonPanel.css');
    const rule = css.match(/\.v2-context-menu\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule, 'у .v2-context-menu пропал z-index').toMatch(/z-index:\s*(\d+)/);
    const value = Number(rule.match(/z-index:\s*(\d+)/)?.[1] ?? 0);
    expect(value, 'z-index меню кнопки разошёлся с POPUP_Z_INDEX').toBe(POPUP_Z_INDEX);
  });

  it('у переведённых меню не осталось собственного локального этажа', () => {
    for (const [file] of PORTALED) {
      const text = src(file);
      expect(text, `${file}: вернулся локальный zIndex — портал перестанет решать задачу`).not.toMatch(
        /zIndex:\s*(?:40|50|60|13000)\b/,
      );
    }
  });
});
