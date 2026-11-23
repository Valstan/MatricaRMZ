import { describe, expect, it } from 'vitest';

import { wantedLevel } from './grantProductionProgramSection.js';

/**
 * Круг editor'ов ведёт план, остальные читают. Сопоставление логинов — по нижнему
 * регистру с обрезкой пробелов: логины в базе и в аргументе могут отличаться
 * регистром, а «не тот человек» здесь = дыра в правах.
 */
describe('wantedLevel — уровень раздела ПП для аккаунта', () => {
  // Логины в фикстуре — вымышленные (D-041: реальных логинов в репозитории быть не может).
  const editors = new Set(['editor1', 'editor2']);

  it('круг editor’ов ведёт план', () => {
    expect(wantedLevel('editor1', editors)).toBe('editor');
    expect(wantedLevel('editor2', editors)).toBe('editor');
  });

  it('остальные — наблюдатели', () => {
    expect(wantedLevel('viewer1', editors)).toBe('viewer');
    expect(wantedLevel('viewer2', editors)).toBe('viewer');
  });

  it('регистр и пробелы не мешают', () => {
    expect(wantedLevel('  EDITOR1 ', editors)).toBe('editor');
    expect(wantedLevel('Editor2', editors)).toBe('editor');
  });

  it('пустой логин — наблюдатель', () => {
    expect(wantedLevel('', editors)).toBe('viewer');
  });
});
