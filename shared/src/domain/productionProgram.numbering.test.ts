import { describe, expect, it } from 'vitest';

import {
  productionProgramDisplayOrder,
  productionProgramGroupKey,
  productionProgramMoveGroup,
  productionProgramMoveRowWithinGroup,
  productionProgramNumbering,
  productionProgramNumberingPlan,
} from './productionProgram.js';

/**
 * Сторож сквозной нумерации производственной программы (промт КАРМАНА #167).
 *
 * Жалоба владельца: «сквозной № п/п собирается в разнобой, хотя номер внутри
 * договора считается правильно». Причина — не данные, а расхождение двух
 * порядков: **нумерация считалась по позиции строки в плоском массиве**, а
 * **показ идёт по группам** (договор → строки). Строки одного договора в
 * плоском массиве разбросаны (после автосохранения чужие строки дописываются в
 * конец, добавление движков — тоже в конец), и показ их собирал вместе. Номер
 * оставался привязанным к плоской позиции — и на экране прыгал: 1, 2, 3, 8,
 * 18, 19, 7…
 *
 * Правило теперь одно: **сквозной номер = позиция показа** (порядок групп по
 * первому появлению, строки внутри группы — как в массиве). Этот файл держит
 * правило, чтобы разнобой не вернулся.
 */

type Row = {
  id: string;
  contractId: string | null;
  groupLabel: string;
  /** Сохранённый номер строки (снимок с сервера) — номерами он быть не должен. */
  orderNo?: number;
};

const LABELS: Record<string, string> = {
  A: 'Заказчик А · 111/2026',
  B: 'Заказчик Б · 222/2026',
  C: 'Заказчик В · 333/2026',
  D: 'Заказчик Г · 444/2026',
  E: 'Заказчик Д · 555/2026',
};

/**
 * Скелет боевой программы: договоры в плоском массиве разбросаны.
 *
 * Ровно та форма, в которой сквозной номер разъезжался на живой программе
 * «Производственная программа (Цех №2)» (16–30.11.2026): 23 строки, пять
 * договоров, строки договора «А» вернулись после чужого блока, а «Г» — после
 * «Д». Данные вымышленные (канон репозитория: фикстуры тестов — вымышленные),
 * форма — боевая.
 */
const SKELETON = [
  'A', 'A', 'A', 'A', 'A', 'A',
  'B',
  'A',
  'B',
  'C', 'C',
  'D',
  'C', 'C',
  'D', 'D', 'D',
  'A', 'A',
  'E',
  'D',
  'C',
  'D',
] as const;

function rowsFromSkeleton(skeleton: readonly string[] = SKELETON): Row[] {
  return skeleton.map((letter, index) => ({
    id: `r${index + 1}`,
    contractId: `contract-${letter}`,
    groupLabel: LABELS[letter] ?? 'Заказчик',
    orderNo: index + 1,
  }));
}

/** Номера строк в порядке показа — как их видит оператор на экране. */
function shownNumbers(rows: readonly Row[]): number[] {
  const plan = productionProgramNumberingPlan(rows);
  return plan.displayOrder.map((index) => plan.global[index] ?? 0);
}

/** Номера внутри договора — по порядку показа, сгруппированные по договору. */
function shownInContractNumbers(rows: readonly Row[]): Record<string, number[]> {
  const plan = productionProgramNumberingPlan(rows);
  const out: Record<string, number[]> = {};
  for (const index of plan.displayOrder) {
    const key = String(rows[index]?.contractId ?? '');
    (out[key] ??= []).push(plan.inContract[index] ?? 0);
  }
  return out;
}

describe('сквозной номер производственной программы', () => {
  it('идёт подряд по порядку показа — без пропусков и повторов', () => {
    const rows = rowsFromSkeleton();
    // Порядок показа: группы собраны вместе, значит номера идут 1, 2, 3, …
    expect(shownNumbers(rows)).toEqual(rows.map((_, index) => index + 1));
  });

  it('разнобой виден на разборанных договорах: до правки номер прыгал', () => {
    // Контроль самого дефекта: номер по позиции в плоском массиве (то, что
    // было) в порядке показа идёт с пропусками — 1, 2, 3, 8, 18, 19, 7…
    const rows = rowsFromSkeleton();
    const plan = productionProgramNumberingPlan(rows);
    const byFlatPosition = plan.displayOrder.map((index) => index + 1);
    expect([...byFlatPosition].sort((a, b) => a - b)).not.toEqual(byFlatPosition);
    // По позиции показа — строго по порядку, без пропусков и повторов.
    const shown = shownNumbers(rows);
    expect(shown).toEqual(plan.displayOrder.map((_, index) => index + 1));
    expect(new Set(shown).size).toBe(shown.length);
  });

  it('номер внутри договора начинается с единицы и не сбивается', () => {
    const inContract = shownInContractNumbers(rowsFromSkeleton());
    for (const [contract, numbers] of Object.entries(inContract)) {
      expect(numbers, `договор ${contract}: номер с единицы`).toEqual(
        numbers.map((_, index) => index + 1),
      );
    }
  });

  it('порядок строк внутри договора и порядок групп не изменились', () => {
    const rows = rowsFromSkeleton();
    const plan = productionProgramNumberingPlan(rows);
    const order = plan.displayOrder.map((index) => rows[index]!.id);
    // Внутри группы — порядок исходного массива.
    const byGroup = new Map<string, string[]>();
    for (const index of plan.displayOrder) {
      const key = productionProgramGroupKey(rows[index]!);
      const bucket = byGroup.get(key);
      if (bucket) bucket.push(rows[index]!.id);
      else byGroup.set(key, [rows[index]!.id]);
    }
    for (const ids of byGroup.values()) {
      const inFlat = rows.map((r) => r.id).filter((id) => ids.includes(id));
      expect(ids).toEqual(inFlat);
    }
    // Порядок групп — по первому появлению в массиве.
    expect([...byGroup.keys()]).toEqual([
      ...new Set(rows.map((row) => productionProgramGroupKey(row))),
    ]);
    // Ни одна строка не потерялась и ни одна не показана дважды.
    expect(order).toHaveLength(rows.length);
    expect(new Set(order).size).toBe(rows.length);
  });

  it('строка без идентификатора всё равно получает номер', () => {
    // Карта нумерации по идентификатору такую строку не видит (номер был пуст).
    // Номер по позиции показа — видит: пустой номер на экране больше не бывает.
    const rows = rowsFromSkeleton();
    rows[3] = { ...rows[3]!, id: '' };
    const plan = productionProgramNumberingPlan(rows);
    expect(plan.global[3]).toBe(4);
    expect(plan.inContract[3]).toBe(4);
    expect(productionProgramNumbering(rows).has('')).toBe(false);
    // Показ остаётся сплошным: пустой идентификатор не выбивает строку из счёта.
    expect(shownNumbers(rows)).toEqual(rows.map((_, index) => index + 1));
  });

  it('две строки с одинаковым идентификатором получают разные номера', () => {
    // Карта по идентификатору делит один номер между двумя строками — отсюда
    // повтор и пропуск сквозного. Номер по позиции показа свободен от этого.
    const rows = rowsFromSkeleton();
    rows[5] = { ...rows[5]!, id: rows[2]!.id };
    const plan = productionProgramNumberingPlan(rows);
    expect(plan.global[5]).toBe(6);
    expect(plan.global[2]).toBe(3);
    const shown = shownNumbers(rows);
    expect(new Set(shown).size).toBe(shown.length);
    expect(shown).toEqual(rows.map((_, index) => index + 1));
  });

  it('сохранённый номер строки не вылезает в нумерацию', () => {
    // Сохранённый `orderNo` — снимок с сервера (после автосохранения он шёл по
    // позиции в отправленном подмножестве и разъезжался с экраном). Номера
    // считаются по позиции показа, а не по нему.
    const rows = rowsFromSkeleton();
    const skewed = rows.map((row, index) => ({ ...row, orderNo: (index % 3) + 1 }));
    expect(shownNumbers(skewed)).toEqual(shownNumbers(rows));
  });

  it('после перетаскивания строки номера остаются подряд', () => {
    const rows = rowsFromSkeleton();
    const moved = productionProgramMoveRowWithinGroup(rows, 'r1', 'r5', 'after');
    expect(shownNumbers(moved)).toEqual(moved.map((_, index) => index + 1));
  });

  it('после перестановки группы номера остаются подряд', () => {
    const rows = rowsFromSkeleton();
    const keyA = productionProgramGroupKey(rows[0]!);
    const keyC = productionProgramGroupKey(rows[9]!);
    const moved = productionProgramMoveGroup(rows, keyC, keyA);
    expect(shownNumbers(moved)).toEqual(moved.map((_, index) => index + 1));
  });

  it('порядок показа — общий для экрана, печати и выгрузки', () => {
    const rows = rowsFromSkeleton();
    const plan = productionProgramNumberingPlan(rows);
    const order = plan.displayOrder.map((index) => rows[index]!.id);
    // Печать собирает группы по тому же ключу (`productionProgramGroupKey`) и в
    // том же порядке — иначе лист и экран показывали бы разное.
    const printedGroups: string[] = [];
    for (const index of plan.displayOrder) {
      const key = productionProgramGroupKey(rows[index]!);
      if (printedGroups[printedGroups.length - 1] !== key) printedGroups.push(key);
    }
    expect(printedGroups).toEqual([
      ...new Set(order.map((id) => productionProgramGroupKey(rows.find((r) => r.id === id)!))),
    ]);
  });
});

describe('порядок показа строк плана', () => {
  it('собранные по договорам строки идут подряд, разбросанные — собираются', () => {
    const rows = rowsFromSkeleton();
    const order = productionProgramDisplayOrder(rows);
    // Плоский массив разбросан: строки договора «А» стоят на позициях 1–6, 8, 18, 19.
    expect(order).not.toEqual(rows.map((_, index) => index));
    // В порядке показа договор идёт целиком: его строки подряд.
    const shown = order.map((index) => String(rows[index]!.contractId));
    const groups = shown.filter((contract, index) => index === 0 || shown[index - 1] !== contract);
    expect(groups.length).toBe(new Set(shown).size);
  });
});
