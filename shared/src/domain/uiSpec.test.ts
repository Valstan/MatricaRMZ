import { describe, expect, it } from 'vitest';

import {
  describeUiSpecForDeveloper,
  sanitizeUiSpec,
  serializeUiSpec,
  UI_SPEC_MAX_BLOCKS,
  type UiSpecV2,
} from './uiSpec.js';

const spec: UiSpecV2 = {
  version: 2,
  canvas: { w: 1280, h: 800 },
  blocks: [
    { id: 'h1', kind: 'heading', x: 40, y: 20, w: 360, h: 44, label: 'Обход цеха' },
    { id: 'b1', kind: 'button', x: 40, y: 90, w: 160, h: 40, label: 'Начать', note: 'Открывает список двигателей' },
    { id: 't1', kind: 'table', x: 240, y: 90, w: 480, h: 200, label: 'Детали', items: ['Название', 'Кол-во', 'Брак'] },
  ],
  links: [{ id: 'l1', fromId: 'b1', toId: 't1', kind: 'navigate', label: 'после нажатия' }],
};

describe('sanitizeUiSpec (v2 mockup)', () => {
  it('accepts an object spec as-is', () => {
    expect(sanitizeUiSpec(spec)).toEqual(spec);
  });

  it('parses a JSON string and a DOUBLE-encoded JSON string (EAV setAttr round-trip)', () => {
    expect(sanitizeUiSpec(serializeUiSpec(spec))).toEqual(spec);
    expect(sanitizeUiSpec(JSON.stringify(serializeUiSpec(spec)))).toEqual(spec);
  });

  it('drops unknown block kinds, clamps geometry, keeps the rest', () => {
    const parsed = sanitizeUiSpec({
      version: 2,
      canvas: { w: 99999, h: -5 },
      blocks: [
        { id: 'x', kind: 'iframe', src: 'http://evil' },
        { id: 'k', kind: 'text', x: -50, y: 10.6, w: 3, h: 999999, label: 'hello' },
      ],
      links: [],
    });
    expect(parsed?.canvas).toEqual({ w: 8000, h: 320 });
    expect(parsed?.blocks).toEqual([{ id: 'k', kind: 'text', x: 0, y: 11, w: 24, h: 8000, label: 'hello' }]);
  });

  it('drops links with unknown kind, missing endpoints or self-loops', () => {
    const parsed = sanitizeUiSpec({
      version: 2,
      canvas: { w: 800, h: 600 },
      blocks: spec.blocks,
      links: [
        { id: 'ok', fromId: 'b1', toId: 't1', kind: 'data' },
        { id: 'self', fromId: 'b1', toId: 'b1', kind: 'data' },
        { id: 'ghost', fromId: 'b1', toId: 'nope', kind: 'data' },
        { id: 'evil', fromId: 'b1', toId: 't1', kind: 'exec' },
      ],
    });
    expect(parsed?.links).toEqual([{ id: 'ok', fromId: 'b1', toId: 't1', kind: 'data' }]);
  });

  it('omits empty label/note/items (exactOptionalPropertyTypes)', () => {
    const parsed = sanitizeUiSpec({
      version: 2,
      canvas: { w: 800, h: 600 },
      blocks: [{ id: 'a', kind: 'input', x: 0, y: 0, w: 100, h: 40, label: '  ', note: '', items: ['', '  '] }],
      links: [],
    });
    const b = parsed?.blocks[0];
    expect(b).toEqual({ id: 'a', kind: 'input', x: 0, y: 0, w: 100, h: 40 });
    expect(b && 'label' in b).toBe(false);
    expect(b && 'items' in b).toBe(false);
  });

  it('deduplicates block ids and caps at UI_SPEC_MAX_BLOCKS', () => {
    const raw = {
      version: 2,
      canvas: { w: 800, h: 600 },
      blocks: Array.from({ length: UI_SPEC_MAX_BLOCKS + 10 }, () => ({ id: 'same', kind: 'note', x: 0, y: 0, w: 100, h: 100 })),
      links: [],
    };
    const parsed = sanitizeUiSpec(raw);
    expect(parsed?.blocks.length).toBe(UI_SPEC_MAX_BLOCKS);
    expect(new Set(parsed?.blocks.map((b) => b.id)).size).toBe(UI_SPEC_MAX_BLOCKS);
  });

  it('upgrades a legacy v1 pilot spec to v2 mock blocks stacked in a column', () => {
    const v1 = {
      version: 1,
      blocks: [
        { id: 'h1', kind: 'heading', text: 'Мой дашборд' },
        { id: 'b1', kind: 'button', label: 'Двигатели', intent: { type: 'navigate_tab', tabId: 'engines' } },
        { id: 'l1', kind: 'list', widget: 'recent_engines', limit: 5 },
      ],
    };
    const parsed = sanitizeUiSpec(v1);
    expect(parsed?.version).toBe(2);
    expect(parsed?.blocks.map((b) => b.kind)).toEqual(['heading', 'button', 'list']);
    expect(parsed?.blocks[0]?.label).toBe('Мой дашборд');
    expect(parsed?.blocks[1]?.note).toContain('engines');
    const ys = parsed!.blocks.map((b) => b.y);
    expect(ys[0]! < ys[1]! && ys[1]! < ys[2]!).toBe(true);
    expect(parsed?.links).toEqual([]);
  });

  it('rejects garbage', () => {
    expect(sanitizeUiSpec(null)).toBeNull();
    expect(sanitizeUiSpec('not json')).toBeNull();
    expect(sanitizeUiSpec(42)).toBeNull();
    expect(sanitizeUiSpec([])).toBeNull();
    expect(sanitizeUiSpec({ version: 2 })).toBeNull();
  });
});

describe('describeUiSpecForDeveloper', () => {
  it('numbers blocks in reading order and lists typed links by number', () => {
    const text = describeUiSpecForDeveloper(spec, 'Обход');
    expect(text).toContain('«Обход»');
    expect(text).toContain('1. [Заголовок] Обход цеха');
    expect(text).toContain('2. [Кнопка] Начать');
    expect(text).toContain('Назначение: Открывает список двигателей');
    expect(text).toContain('Колонки: Название, Кол-во, Брак');
    expect(text).toContain('- №2 → №3: Переход — после нажатия');
  });
});
