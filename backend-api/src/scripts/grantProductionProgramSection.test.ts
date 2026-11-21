import { describe, expect, it } from 'vitest';

import { wantedLevel } from './grantProductionProgramSection.js';

/**
 * Круг editor'ов ведёт план, остальные читают. Сопоставление логинов — по нижнему
 * регистру с обрезкой пробелов: логины в базе и в аргументе могут отличаться
 * регистром, а «не тот человек» здесь = дыра в правах.
 */
describe('wantedLevel — уровень раздела ПП для аккаунта', () => {
  const editors = new Set(['sapegin', 'fatyhova']);

  it('круг editor’ов ведёт план', () => {
    expect(wantedLevel('sapegin', editors)).toBe('editor');
    expect(wantedLevel('fatyhova', editors)).toBe('editor');
  });

  it('остальные — наблюдатели', () => {
    expect(wantedLevel('ozerolove', editors)).toBe('viewer');
    expect(wantedLevel('novosel', editors)).toBe('viewer');
  });

  it('регистр и пробелы не мешают', () => {
    expect(wantedLevel('  SAPEGIN ', editors)).toBe('editor');
    expect(wantedLevel('Fatyhova', editors)).toBe('editor');
  });

  it('пустой логин — наблюдатель', () => {
    expect(wantedLevel('', editors)).toBe('viewer');
  });
});
