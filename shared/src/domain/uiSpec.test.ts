import { describe, expect, it } from 'vitest';

import { sanitizeUiSpec, serializeUiSpec, UI_SPEC_MAX_BLOCKS, type UiSpecV1 } from './uiSpec.js';

const spec: UiSpecV1 = {
  version: 1,
  blocks: [
    { id: 'h1', kind: 'heading', text: 'Мой дашборд' },
    { id: 'b1', kind: 'button', label: 'Двигатели', intent: { type: 'navigate_tab', tabId: 'engines' } },
    { id: 'l1', kind: 'list', widget: 'recent_engines', limit: 5 },
  ],
};

describe('sanitizeUiSpec', () => {
  it('accepts an object spec as-is', () => {
    expect(sanitizeUiSpec(spec)).toEqual(spec);
  });

  it('parses a JSON string', () => {
    expect(sanitizeUiSpec(serializeUiSpec(spec))).toEqual(spec);
  });

  it('parses a DOUBLE-encoded JSON string (EAV setAttr round-trip)', () => {
    expect(sanitizeUiSpec(JSON.stringify(serializeUiSpec(spec)))).toEqual(spec);
  });

  it('drops unknown block kinds and intents, keeps the rest', () => {
    const raw = {
      version: 1,
      blocks: [
        { id: 'x', kind: 'iframe', src: 'http://evil' },
        { id: 'b', kind: 'button', label: 'Ok', intent: { type: 'eval', code: '1' } },
        { id: 'k', kind: 'text', text: 'hello' },
        { id: 'w', kind: 'list', widget: 'unknown_widget' },
      ],
    };
    expect(sanitizeUiSpec(raw)).toEqual({ version: 1, blocks: [{ id: 'k', kind: 'text', text: 'hello' }] });
  });

  it('drops buttons without label or intent tabId', () => {
    const raw = {
      blocks: [
        { id: 'a', kind: 'button', label: '  ', intent: { type: 'navigate_tab', tabId: 'engines' } },
        { id: 'b', kind: 'button', label: 'Пустой', intent: { type: 'navigate_tab', tabId: '' } },
      ],
    };
    expect(sanitizeUiSpec(raw)).toEqual({ version: 1, blocks: [] });
  });

  it('clamps list limit and omits invalid limit (exactOptionalPropertyTypes)', () => {
    const parsed = sanitizeUiSpec({
      blocks: [
        { id: 'l1', kind: 'list', widget: 'my_work_orders', limit: 9999 },
        { id: 'l2', kind: 'list', widget: 'my_work_orders', limit: 'abc' },
      ],
    });
    expect(parsed?.blocks[0]).toEqual({ id: 'l1', kind: 'list', widget: 'my_work_orders', limit: 50 });
    expect(parsed?.blocks[1]).toEqual({ id: 'l2', kind: 'list', widget: 'my_work_orders' });
    expect(parsed?.blocks[1] && 'limit' in parsed.blocks[1]).toBe(false);
  });

  it('deduplicates block ids and fills missing ones', () => {
    const parsed = sanitizeUiSpec({
      blocks: [
        { kind: 'text', text: 'a' },
        { id: 'dup', kind: 'text', text: 'b' },
        { id: 'dup', kind: 'text', text: 'c' },
      ],
    });
    const ids = parsed?.blocks.map((b) => b.id) ?? [];
    expect(new Set(ids).size).toBe(3);
  });

  it('caps block count', () => {
    const raw = { blocks: Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, kind: 'text', text: 'x' })) };
    expect(sanitizeUiSpec(raw)?.blocks.length).toBe(UI_SPEC_MAX_BLOCKS);
  });

  it('returns null on garbage', () => {
    expect(sanitizeUiSpec(null)).toBeNull();
    expect(sanitizeUiSpec('not json')).toBeNull();
    expect(sanitizeUiSpec(42)).toBeNull();
    expect(sanitizeUiSpec([])).toBeNull();
    expect(sanitizeUiSpec({ version: 1 })).toBeNull();
  });
});
