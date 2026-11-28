import { describe, expect, it } from 'vitest';

import type { EngineListItem } from '../ipc/types.js';
import {
  productionProgramAddByNumbersAlreadyInProgram,
  productionProgramAddByNumbersEngineLabel,
  productionProgramAddByNumbersReport,
  productionProgramAddByNumbersRows,
} from './productionProgramAddByNumbers.js';

// Домен «Добавить двигатели списком» — правило одно для модалки и для действия агента
// (промт КАРМАНА #176, разрез 2). Проверяем ровно то, на чём ломалась «добавка
// списком»: неоднозначный номер, повтор номера, отгруженный двигатель и дубль в плане.

function engine(overrides: Partial<EngineListItem> = {}): EngineListItem {
  return {
    id: 'e1',
    engineNumber: '001',
    engineBrand: 'ТМЗ',
    customerName: 'Заказчик',
    contractId: 'c1',
    stageCodes: ['repair'],
    arrivalDate: 1_000,
    shippingDate: null,
    statusFlags: {},
    lastStageCode: null,
    lastStageAt: null,
    isScrap: false,
    ...overrides,
  } as EngineListItem;
}

const contractInfos = new Map([['c1', { kind: 'military' as const, number: '123' }]]);

const labelOf = (): string => 'Заказчик · 123';

describe('добавление двигателей списком — домен', () => {
  it('неоднозначный номер: ничего не берём и говорим почему', () => {
    const engines = [engine({ id: 'e1', engineNumber: '001' }), engine({ id: 'e2', engineNumber: '001' })];
    const report = productionProgramAddByNumbersReport({
      text: '001',
      engines,
      contractInfos,
      contractLabelOf: labelOf,
    });

    expect(report).toHaveLength(1);
    expect(report[0]?.kind).toBe('forbidden');
    expect(report[0]?.reason).toContain('2 карточками');

    const built = productionProgramAddByNumbersRows({
      report,
      serverRows: [],
      makeId: () => 'r1',
    });
    expect(built.rows).toHaveLength(0);
    expect(built.skipped).toHaveLength(1);
  });

  it('повтор номера в списке: строка одна', () => {
    const engines = [engine()];
    const report = productionProgramAddByNumbersReport({
      text: '001 001\n001',
      engines,
      contractInfos,
      contractLabelOf: labelOf,
    });

    expect(report).toHaveLength(1);
    expect(report[0]?.repeated).toBe(true);

    const built = productionProgramAddByNumbersRows({
      report,
      serverRows: [],
      makeId: () => 'r1',
    });
    expect(built.rows).toHaveLength(1);
    expect(built.rows[0]?.engineNumber).toBe('001');
  });

  it('отгруженный двигатель в план не берём', () => {
    const engines = [engine({ shippingDate: 5_000 })];
    const report = productionProgramAddByNumbersReport({
      text: '001',
      engines,
      contractInfos,
      contractLabelOf: labelOf,
    });

    expect(report[0]?.kind).toBe('forbidden');
    expect(report[0]?.reason).toContain('отгружен');

    const built = productionProgramAddByNumbersRows({
      report,
      serverRows: [],
      makeId: () => 'r1',
    });
    expect(built.rows).toHaveLength(0);
    expect(built.skipped[0]?.reason).toContain('отгружен');
  });

  it('дубль в плане: строка не добавляется второй раз', () => {
    const engines = [engine()];
    const report = productionProgramAddByNumbersReport({
      text: '001',
      engines,
      contractInfos,
      contractLabelOf: labelOf,
    });

    const serverRows = [
      { id: 'row1', programId: 'p1', engineId: 'e1', engineNumber: '001', orderNo: 0, groupLabel: 'Заказчик · 123' },
    ] as any;

    expect(productionProgramAddByNumbersAlreadyInProgram(report[0]!, serverRows)).toBe(true);

    const built = productionProgramAddByNumbersRows({
      report,
      serverRows,
      makeId: () => 'r1',
    });
    expect(built.rows).toHaveLength(0);
    expect(built.skipped[0]?.reason).toBe('Уже есть в плане');
  });

  it('двигатель без договора ждёт в блоке «Требует данных»', () => {
    const engines = [engine({ contractId: null })];
    const report = productionProgramAddByNumbersReport({
      text: '001',
      engines,
      contractInfos,
      contractLabelOf: labelOf,
    });

    expect(report[0]?.kind).toBe('pending');

    const built = productionProgramAddByNumbersRows({
      report,
      serverRows: [],
      makeId: () => 'r1',
    });
    expect(built.rows).toHaveLength(1);
    expect(built.rows[0]?.groupLabel).toBe('Требует данных');
    expect(built.rows[0]?.contractId).toBeNull();
    expect(built.rows[0]?.note).toBe('Нет договора');
  });

  it('годный двигатель попадает в группу своего договора', () => {
    const engines = [engine()];
    const report = productionProgramAddByNumbersReport({
      text: '001',
      engines,
      contractInfos,
      contractLabelOf: labelOf,
    });

    expect(report[0]?.kind).toBe('normal');

    const built = productionProgramAddByNumbersRows({
      report,
      serverRows: [],
      makeId: () => 'r1',
    });
    expect(built.rows).toHaveLength(1);
    expect(built.rows[0]?.groupLabel).toBe('Заказчик · 123');
    expect(built.rows[0]?.engineId).toBe('e1');
  });

  it('подпись двигателя — марка и номер, а без карточки — сам номер', () => {
    expect(productionProgramAddByNumbersEngineLabel(engine(), '001')).toBe('ТМЗ 001');
    expect(productionProgramAddByNumbersEngineLabel(null, '001')).toBe('001');
  });
});
