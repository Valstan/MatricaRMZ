import { describe, expect, it } from 'vitest';

import { insertTextAtSelection } from './insertText.js';

describe('insertTextAtSelection', () => {
  it('inserts at the caret, keeping both sides of the text', () => {
    const r = insertTextAtSelection('АБВГ', 'XY', { start: 2, end: 2 });
    expect(r.next).toBe('АБXYВГ');
    expect(r.caret).toBe(4);
  });

  it('replaces the selected fragment', () => {
    const r = insertTextAtSelection('АБВГ', 'X', { start: 1, end: 3 });
    expect(r.next).toBe('АXГ');
    expect(r.caret).toBe(2);
  });

  it('appends when there is no selection information at all', () => {
    const r = insertTextAtSelection('Уже есть текст', ' и добавка', null);
    expect(r.next).toBe('Уже есть текст и добавка');
    expect(r.caret).toBe('Уже есть текст и добавка'.length);
  });

  it('fills an empty field as-is', () => {
    const r = insertTextAtSelection('', 'Акт исследования', { start: 0, end: 0 });
    expect(r.next).toBe('Акт исследования');
    expect(r.caret).toBe('Акт исследования'.length);
  });

  it('treats an out-of-range selection as an append instead of corrupting the text', () => {
    const r = insertTextAtSelection('АБВ', 'Г', { start: 99, end: 99 });
    expect(r.next).toBe('АБВГ');
    expect(r.caret).toBe(4);
  });

  it('survives a reversed selection', () => {
    const r = insertTextAtSelection('АБВГ', 'X', { start: 3, end: 1 });
    expect(r.next).toBe('АXГ');
    expect(r.caret).toBe(2);
  });

  it('does not change the text when there is nothing to insert', () => {
    const r = insertTextAtSelection('АБВ', '', { start: 1, end: 1 });
    expect(r.next).toBe('АБВ');
    expect(r.caret).toBe(1);
  });
});
