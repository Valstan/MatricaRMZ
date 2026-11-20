import { describe, expect, it } from 'vitest';

import type { EngineListItem } from '../ipc/types.js';
import {
  PRODUCTION_PROGRAM_ATTENTION_BACKGROUND,
  PRODUCTION_PROGRAM_OPERATOR_MARK_LABELS,
  PRODUCTION_PROGRAM_OPERATOR_MARKS,
  PRODUCTION_PROGRAM_READY_BACKGROUND,
  parseProductionProgramOperatorMark,
  productionProgramMoveRowWithinGroup,
  productionProgramNumbering,
  productionProgramOperatorMarkLabel,
  productionProgramRowTone,
} from './productionProgram.js';

// Ручная отметка оператора на строке производственной программы (промты КАРМАНА
// #48 + #49, шаг 5 плана владельца от 19.11.2026): «оператор может помечать
// отдельные двигатели, чтобы быстрее находить их в производственной программе и
// обмениваться данными с другими операторами».
//
// Правила здесь — доменные: хранится ПРИЗНАК (а не цвет), набор признаков задан
// явно, отметка не влияет на порядок и сильнее факта из карточки (её поставили
// руками именно для того, чтобы строку заметили).

type Row = {
  id: string;
  contractId: string | null;
  groupLabel: string;
  operatorNote?: string | null;
};

const engine = (overrides: Partial<EngineListItem> = {}): EngineListItem =>
  ({
    id: 'e1',
    arrivalDate: 1_000,
    shippingDate: null,
    statusFlags: {},
    lastStageCode: null,
    lastStageAt: null,
    isScrap: false,
    ...overrides,
  }) as EngineListItem;

describe('набор отметок оператора', () => {
  it('значение — признак из явного списка, а не произвольный цвет', () => {
    expect(PRODUCTION_PROGRAM_OPERATOR_MARKS).toEqual(['attention']);
    expect(PRODUCTION_PROGRAM_OPERATOR_MARK_LABELS.attention).toBe('Особое внимание');
    // У каждой отметки есть подпись — интерфейсу нечего придумывать.
    for (const mark of PRODUCTION_PROGRAM_OPERATOR_MARKS) {
      expect(PRODUCTION_PROGRAM_OPERATOR_MARK_LABELS[mark]).toBeTruthy();
    }
  });

  it('разбор принимает известную отметку и отбрасывает мусор', () => {
    expect(parseProductionProgramOperatorMark('attention')).toBe('attention');
    expect(parseProductionProgramOperatorMark('  attention  ')).toBe('attention');
    expect(parseProductionProgramOperatorMark('')).toBeNull();
    expect(parseProductionProgramOperatorMark(null)).toBeNull();
    expect(parseProductionProgramOperatorMark(undefined)).toBeNull();
    // Произвольный цвет в колонку не попадает: неизвестное значение — не отметка.
    expect(parseProductionProgramOperatorMark('#ff0000')).toBeNull();
    expect(parseProductionProgramOperatorMark('urgent')).toBeNull();
  });

  it('подпись отметки — пусто, когда отметки нет', () => {
    expect(productionProgramOperatorMarkLabel('attention')).toBe('Особое внимание');
    expect(productionProgramOperatorMarkLabel(null)).toBe('');
    expect(productionProgramOperatorMarkLabel('мусор')).toBe('');
  });
});

describe('тон строки плана с отметкой оператора', () => {
  it('отметка даёт свой фон и сильнее факта из карточки', () => {
    // Двигатель готов к отгрузке (факт из карточки → зелёный фон).
    const ready = engine({ lastStageCode: 'otk', lastStageAt: 5_000, statusFlags: { status_repaired: true } });
    expect(productionProgramRowTone(ready).background).toBe(PRODUCTION_PROGRAM_READY_BACKGROUND);

    // С отметкой оператора фон — отметки: её поставили руками, чтобы заметили.
    const marked = productionProgramRowTone(ready, 'attention');
    expect(marked.background).toBe(PRODUCTION_PROGRAM_ATTENTION_BACKGROUND);
    expect(marked.background).not.toBe(PRODUCTION_PROGRAM_READY_BACKGROUND);
    // Факт при этом не потерялся — он в подсказке строки.
    expect(marked.label).toContain('Особое внимание');
    expect(marked.label).toContain('Готов к отгрузке');
  });

  it('без отметки тон прежний: факт из карточки', () => {
    const plain = productionProgramRowTone(engine());
    expect(plain.background).toBe('');
    expect(plain.label).toBe('');
    // Неизвестное значение — не отметка: фон факта остаётся.
    const ready = engine({ lastStageCode: 'otk', lastStageAt: 5_000, statusFlags: { status_repaired: true } });
    expect(productionProgramRowTone(ready, 'мусор').background).toBe(PRODUCTION_PROGRAM_READY_BACKGROUND);
    expect(productionProgramRowTone(ready, null).background).toBe(PRODUCTION_PROGRAM_READY_BACKGROUND);
  });
});

describe('отметка не влияет на порядок', () => {
  const rows: Row[] = [
    { id: 'a1', contractId: 'c1', groupLabel: 'Заказчик 1 · 125/2', operatorNote: 'attention' },
    { id: 'a2', contractId: 'c1', groupLabel: 'Заказчик 1 · 125/2' },
    { id: 'b1', contractId: 'c2', groupLabel: 'Заказчик 2 · 77/1' },
  ];

  it('нумерация считается по позиции, отметка в неё не входит', () => {
    const map = productionProgramNumbering(rows);
    expect(map.get('a1')).toEqual({ global: 1, inContract: 1 });
    expect(map.get('a2')).toEqual({ global: 2, inContract: 2 });
    expect(map.get('b1')).toEqual({ global: 3, inContract: 1 });
  });

  it('перетаскивание увозит отметку вместе со строкой', () => {
    // Двигатель встаёт на место цели: a2 — перед a1.
    const moved = productionProgramMoveRowWithinGroup(rows, 'a2', 'a1');
    expect(moved.map((r) => r.id)).toEqual(['a2', 'a1', 'b1']);
    // Отметка осталась на своей строке — она не «отлипла» при перестановке.
    expect(moved.find((r) => r.id === 'a1')?.operatorNote).toBe('attention');
    expect(moved.find((r) => r.id === 'a2')?.operatorNote).toBeUndefined();
  });
});
