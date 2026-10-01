import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Эмодзи подписей (владелец 01.10.2026): значок слева от названия поля, текст
// подписи при этом НЕ меняется — рисует CSS через data-emoji. Это свойство
// держит совместимость: точные совпадения текста в других сторожах,
// CDP-драйверах, поиске и копипасте целы (псевдоэлемент в textContent не входит).
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const CSS = src('../global.css');
const FORM_FIELD = src('./FormField.tsx');
const CARD_TABS = src('./CardTabs.tsx');
const SECTION_CARD = src('./SectionCard.tsx');
const FACETS = src('./FacetFilter.tsx');
const COLUMNS = src('./ColumnSettingsButton.tsx');
const KINDS = src('../utils/listColumnKinds.ts');
const SHELL = src('../shellV3/V3TabShell.tsx');

describe('эмодзи подписей рисуются, а не дописываются в текст', () => {
  it('CSS рисует значок из атрибута', () => {
    expect(CSS).toContain('[data-emoji]::before');
    expect(CSS).toContain('content: attr(data-emoji)');
  });

  it('общие точки подписей ставят атрибут: поля, вкладки, секции, ступени, колонки, шапки списков', () => {
    for (const [name, body] of [
      ['FormField', FORM_FIELD],
      ['CardTabs', CARD_TABS],
      ['SectionCard', SECTION_CARD],
      ['FacetFilter', FACETS],
      ['ColumnSettingsButton', COLUMNS],
      ['V3TabShell', SHELL],
    ] as const) {
      expect(body, `${name} не ставит data-emoji — подписи без значков`).toContain('emojiAttrs(');
    }
    expect(KINDS, 'шапки всех списков — через listHeaderKindProps').toContain("'data-emoji'");
  });

  it('текст подписей не тронут — значок не прибит к строке', () => {
    expect(CARD_TABS).toContain('{t.label}');
    expect(CARD_TABS).not.toMatch(/\$\{.*\}.*\{t\.label\}/);
    expect(FORM_FIELD).toContain('{props.label}');
  });
});
