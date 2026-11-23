import { describe, expect, it } from 'vitest';

import type { EngineListItem } from '../ipc/types.js';
import {
  productionProgramGroupKey,
  productionProgramMoveGroup,
  productionProgramMoveRowWithinGroup,
  productionProgramNumbering,
  productionProgramRowTone,
} from './productionProgram.js';

// Порядок в производственной программе (промты КАРМАНА #48 + #49):
// перетаскивание двигателей и групп, две нумерации (общая и внутри договора),
// тон строки по факту из карточки.
//
// Правила здесь — доменные: экран и печать должны считать одно и то же, а
// номера обязаны считаться ПО ПОЗИЦИИ (после перетаскивания сохранённые
// номера разъезжаются, и цифры перестают быть правдой).

type Row = { id: string; contractId: string | null; groupLabel: string };

const ROWS: Row[] = [
  { id: 'a1', contractId: 'c1', groupLabel: 'Заказчик 1 · 125/2' },
  { id: 'a2', contractId: 'c1', groupLabel: 'Заказчик 1 · 125/2' },
  { id: 'b1', contractId: 'c2', groupLabel: 'Заказчик 2 · 77/1' },
  { id: 'c1', contractId: 'c3', groupLabel: 'Заказчик 3 · 5/9' },
];

describe('нумерация строк производственной программы', () => {
  it('две нумерации: общая по программе и своя внутри договора', () => {
    const map = productionProgramNumbering(ROWS);
    expect(map.get('a1')).toEqual({ global: 1, inContract: 1 });
    expect(map.get('a2')).toEqual({ global: 2, inContract: 2 });
    // Новый договор — своя нумерация с единицы, общая продолжается.
    expect(map.get('b1')).toEqual({ global: 3, inContract: 1 });
    expect(map.get('c1')).toEqual({ global: 4, inContract: 1 });
  });

  it('нумерация считается по позиции, а не по сохранённому числу', () => {
    const rows = [...ROWS];
    const map = productionProgramNumbering(rows);
    // Порядок изменился — цифры поехали за строками.
    rows.reverse();
    const after = productionProgramNumbering(rows);
    expect(after.get('c1')?.global).toBe(1);
    expect(after.get('a1')?.global).toBe(4);
    // Внутри своего договора a1 снова первый — нумерация по позиции в группе.
    expect(after.get('a1')?.inContract).toBe(2);
    expect(map.get('a1')?.global).toBe(1);
  });
});

describe('перетаскивание в производственной программе', () => {
  it('двигатель едет только внутри своего договора', () => {
    const moved = productionProgramMoveRowWithinGroup(ROWS, 'a2', 'a1');
    expect(moved.map((r) => r.id)).toEqual(['a2', 'a1', 'b1', 'c1']);
    // Чужая группа — не цель: порядок не меняется.
    const cross = productionProgramMoveRowWithinGroup(ROWS, 'a1', 'b1');
    expect(cross.map((r) => r.id)).toEqual(['a1', 'a2', 'b1', 'c1']);
  });

  it('двигатель встаёт перед целевой строкой или после неё (сторона от кита)', () => {
    // Сторону места вставки считает общий слой перетаскивания (кит) и отдаёт
    // домену: домен переводит её в порядок строк, не нарушая договор строки.
    const before = productionProgramMoveRowWithinGroup(ROWS, 'a2', 'a1', 'before');
    expect(before.map((r) => r.id)).toEqual(['a2', 'a1', 'b1', 'c1']);
    const after = productionProgramMoveRowWithinGroup(ROWS, 'a1', 'a2', 'after');
    expect(after.map((r) => r.id)).toEqual(['a2', 'a1', 'b1', 'c1']);
    // Чужая группа — не цель даже со стороной: двигатель свой договор не покидает.
    const cross = productionProgramMoveRowWithinGroup(ROWS, 'a1', 'b1', 'after');
    expect(cross.map((r) => r.id)).toEqual(['a1', 'a2', 'b1', 'c1']);
  });

  it('группа уезжает целиком со своим блоком', () => {
    const key1 = productionProgramGroupKey(ROWS[0]!);
    const key3 = productionProgramGroupKey(ROWS[3]!);
    const moved = productionProgramMoveGroup(ROWS, key3, key1);
    // Блок «Заказчик 3» встал перед блоком «Заказчик 1» и унёс свою строку.
    expect(moved.map((r) => r.id)).toEqual(['c1', 'a1', 'a2', 'b1']);
  });

  it('группа встаёт перед целевой или сразу за её блоком (сторона от кита)', () => {
    const key1 = productionProgramGroupKey(ROWS[0]!);
    const key3 = productionProgramGroupKey(ROWS[3]!);
    const before = productionProgramMoveGroup(ROWS, key3, key1, 'before');
    expect(before.map((r) => r.id)).toEqual(['c1', 'a1', 'a2', 'b1']);
    const after = productionProgramMoveGroup(ROWS, key3, key1, 'after');
    // Блок «Заказчик 3» встал после блока «Заказчик 1» (перед «Заказчиком 2»).
    expect(after.map((r) => r.id)).toEqual(['a1', 'a2', 'c1', 'b1']);
  });

  it('группа без цели уходит в конец программы', () => {
    const key1 = productionProgramGroupKey(ROWS[0]!);
    const key3 = productionProgramGroupKey(ROWS[3]!);
    const moved = productionProgramMoveGroup(ROWS, key1, 'нет-такой-группы');
    expect(moved.map((r) => r.id)).toEqual(['b1', 'c1', 'a1', 'a2']);
    expect(key3).not.toBe(key1);
  });
});

describe('тон строки плана', () => {
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

  it('готовый к отгрузке — свой фон, отгруженный — без заливки', () => {
    const ready = productionProgramRowTone(
      engine({ lastStageCode: 'otk', lastStageAt: 5_000, statusFlags: { status_repaired: true } }),
    );
    expect(ready.background).toBe('#dcfce7');
    expect(ready.label).toContain('Готов к отгрузке');
    const shipped = productionProgramRowTone(engine({ shippingDate: 6_000 }));
    expect(shipped.background).toBe('');
    expect(shipped.label).toBe('Отгружен');
    const plain = productionProgramRowTone(engine());
    expect(plain.background).toBe('');
  });
});
