import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE = readFileSync(resolve(__dirname, './EnginesPage.tsx'), 'utf-8');

describe('EnginesPage — мультивыбор чекбоксами', () => {
  it('колонка чекбокса в заголовке с выделением/снятием всех', () => {
    expect(PAGE).toContain('type="checkbox"');
    expect(PAGE).toContain('Выделить все');
    expect(PAGE).toContain('Снять выделение со всех');
  });

  it('чекбокс в каждой строке таблицы', () => {
    expect(PAGE).toContain('aria-label={`Выделить двигатель ${e.engineNumber ?? e.id}`}');
  });

  it('VirtualTable рендерит чекбокс в renderCells', () => {
    expect(PAGE).toContain('renderCells={(i) => {');
    expect(PAGE).toContain('colCount={Math.max(1, visibleColumns.length) + 2}');
  });

  it('colSpan пустого состояния учитывает чекбокс-колонку', () => {
    expect(PAGE).toContain('colSpan={Math.max(1, visibleColumns.length) + 3}');
  });

  it('подсказка упоминает чекбоксы как способ выделения', () => {
    expect(PAGE).toContain('Поставьте галочки');
  });
});
