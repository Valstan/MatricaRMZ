import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const POPUP = readFileSync(resolve(__dirname, './PopupLayer.tsx'), 'utf-8');

describe('PopupLayer — компактная ширина и таймаут 15 с', () => {
  it('опция compactWidth в AnchoredOptions', () => {
    expect(POPUP).toContain('compactWidth?: boolean');
  });

  it('таймаут автоскрытия 15 секунд', () => {
    expect(POPUP).toContain('15_000');
  });

  it('автоскрытие не срабатывает при курсоре на меню', () => {
    expect(POPUP).toContain('!node.matches(\':hover\')');
  });

  it('событие popup-auto-close для закрытия по таймауту', () => {
    expect(POPUP).toContain('popup-auto-close');
  });
});
