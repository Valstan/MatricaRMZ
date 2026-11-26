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
    // Плюс колонка чекбокса и колонки-номера (промт КАРМАНА #164: нумерации стали
    // обычными колонками списка, и их может быть две).
    expect(PAGE).toContain('colCount={Math.max(1, visibleColumns.length) + 1 + numberColumnCount}');
  });

  it('colSpan пустого состояния учитывает чекбокс-колонку и колонки-номера', () => {
    expect(PAGE).toContain('colSpan={Math.max(1, visibleColumns.length) + 1 + numberColumnCount}');
  });

  it('клик по чекбоксу не открывает карточку (stopPropagation до строки)', () => {
    expect(PAGE).toContain('onClick={(event) => event.stopPropagation()}');
  });

  it('подсказка упоминает чекбоксы как способ выделения', () => {
    expect(PAGE).toContain('Поставьте галочки');
  });
});
