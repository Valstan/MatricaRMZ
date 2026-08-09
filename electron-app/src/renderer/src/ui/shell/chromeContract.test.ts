import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { REQUIRED_ANCHORS } from './chromeAnchors.js';

// Планшетный режим прячет хром по КЛАССАМ-якорям, а не по структуре DOM: разметку и CSS
// связывает только строка. Обычный рефакторинг («перепишу инлайн-стили», «переименую
// обёртку») способен молча снять якорь — экран останется рабочим, а фича тихо перестанет
// работать, и заметит это только оператор в цеху. Тест держит эту связь.
//
// Отдельно проверяются классы, на которых стоят CDP-смоуки verifier-electron: их
// переименование ломает приёмку Windows-клиента.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const CASES: Array<{ file: string; anchors: string[] }> = [
  // v3-tab-split — вход в режим «2 рядом». Он уже терялся однажды: переписывание полосы
  // вкладок (#494, 2026-08-07) сняло кнопку, обработчик остался осиротевшим пропом, и
  // режим стал недостижим кликом при полностью живом коде. Якорь держит эту связь.
  { file: '../shellV3/V3TabShell.tsx', anchors: ['v3-tab-strip', 'v3-tab-close', 'v3-tab-menu', 'v3-logo', 'v3-sync-btn', 'v3-tab-label', 'v3-tab-split'] },
  { file: '../shellV2/ButtonPanel.tsx', anchors: ['v2-menu-btn-label', 'v2-button-panel'] },
  { file: '../pages/EnginesPage.tsx', anchors: ['mx-page-toolbar'] },
  { file: '../pages/WorkOrdersPage.tsx', anchors: ['mx-page-toolbar'] },
  { file: '../pages/StockDocumentsPage.tsx', anchors: ['mx-page-toolbar', 'mx-page-footer'] },
  { file: '../pages/RepairFundAuditPage.tsx', anchors: ['mx-page-toolbar', 'mx-page-footer'] },
  { file: '../components/EntityCardShell.tsx', anchors: ['entity-card-shell', 'ui-section-header', 'mx-card-title'] },
  { file: '../components/CardActionBar.tsx', anchors: ['card-action-bar'] },
];

// Кто рендерит каждый якорь fail-open. Проверяется не «класс где-то встречается», а
// «класс есть в ТОМ файле, который обязан его ставить»: якорь, переехавший в чужой
// компонент, — это и есть та тихая расстыковка, ради которой список существует.
const ANCHOR_OWNERS: Record<string, string> = {
  '.v3-tab-strip': '../shellV3/V3TabShell.tsx',
  '.mx-chrome-rail': './ChromeHandleRail.tsx',
};

describe('fail-open планшетного режима', () => {
  // Жёсткий toEqual, а не «непустой»/«содержит»: пустой список — валидное значение для
  // `filter(...).length === 0`, поэтому мягкая проверка зеленела бы на конфигурации,
  // которая выключает fail-open навсегда. Именно так дефект и дожил до цеха: якорем
  // стоял `.mx-chrome-slot--header`, снесённый вместе с синей шапкой в #494, и режим
  // выключал сам себя через 2 с после монтирования (сброса у broken нет).
  it('список якорей — ровно тот, что покрыт этим тестом', () => {
    expect(REQUIRED_ANCHORS).toEqual(['.v3-tab-strip', '.mx-chrome-rail']);
  });

  it('каждый якорь ставится живым компонентом', () => {
    for (const anchor of REQUIRED_ANCHORS) {
      const owner = ANCHOR_OWNERS[anchor] ?? '';
      expect(owner, `для якоря ${anchor} не назначен владелец разметки`).toBeTruthy();
      expect(src(owner), `${owner} больше не ставит ${anchor}`).toContain(anchor.slice(1));
    }
  });
});

describe('якоря планшетного режима на месте', () => {
  for (const c of CASES) {
    it(c.file, () => {
      const text = src(c.file);
      for (const anchor of c.anchors) expect(text, `нет якоря ${anchor}`).toContain(anchor);
    });
  }
});

describe('правила скрытия покрывают все якоря', () => {
  const css = src('./chromeShell.css');

  it('каждое правило скрытия гейтится платформенным атрибутом', () => {
    for (const line of css.split('\n')) {
      if (!line.includes('display: none')) continue;
      expect(line.trim().startsWith('display: none')).toBe(true);
    }
    // Ни одного правила вне гейта: селекторы верхнего уровня начинаются с :root[data-mx-chrome
    for (const block of css.split('}')) {
      const selector = block.split('{')[0]?.trim() ?? '';
      if (!selector || selector.startsWith('/*') || selector.startsWith('@') || selector.startsWith('from') || selector.startsWith('to')) continue;
      if (selector.includes('%')) continue;
      const lines = selector.split('\n').map((s) => s.trim().replace(/^\/\*.*\*\/\s*/s, '')).filter(Boolean);
      const last = lines[lines.length - 1] ?? '';
      expect(last.startsWith(':root[data-mx-chrome='), `селектор вне гейта: ${last}`).toBe(true);
    }
  });

  it('скрываются ровно размеченные слои', () => {
    for (const anchor of ['v3-tab-strip', 'mx-page-toolbar', 'mx-page-footer', 'ui-section-header']) {
      expect(css).toContain(anchor);
    }
    // Работа оператора не скрывается ничем: ни панель действий карточки, ни строка
    // заголовка ЦЕЛИКОМ (в ней же живут actions и статус «Ошибка: …» — скрыть их
    // означало бы молча потерянные правки; прячется только .mx-card-title).
    for (const block of css.split('}')) {
      if (!block.includes('display: none')) continue;
      expect(block).not.toContain('card-action-bar');
      if (block.includes('ui-section-header')) expect(block).toContain('.mx-card-title');
    }
  });
});
