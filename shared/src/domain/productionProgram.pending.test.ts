import { describe, expect, it } from 'vitest';

import type { EngineListItem } from '../ipc/types.js';
import {
  PRODUCTION_PROGRAM_PENDING_GROUP_LABEL,
  productionProgramEngineIndex,
  productionProgramEngineMatch,
  productionProgramEngineProblem,
  productionProgramMergeRows,
  productionProgramPendingCandidates,
  productionProgramResolvePendingRows,
  productionProgramSystemNote,
} from './productionProgram.js';

// Блок «Требует данных» в производственной программе (промты КАРМАНА #64 + #65,
// ответы владельца #66 → D-246): проблемные строки живут внутри программы и
// САМИ уезжают в группу своего договора, когда карточка починена.
//
// Правила здесь доменные: экран, печать и перепроверка обязаны считать одно и то же.

const DAY = 24 * 60 * 60 * 1000;
const ARRIVAL = Date.parse('2026-11-01T12:00:00Z');

function engine(over: Partial<EngineListItem> & { id: string }): EngineListItem {
  return {
    engineNumber: '41/26',
    engineBrand: 'Д-245',
    arrivalDate: ARRIVAL,
    stageCodes: ['disassembly'],
    lastStageCode: 'disassembly',
    lastStageAt: ARRIVAL + DAY,
    ...over,
  } as EngineListItem;
}

const GOOD = engine({ id: 'e-good', engineNumber: '41/26', contractId: 'c1', customerName: 'ООО Ромашка' });
const NO_CONTRACT = engine({ id: 'e-nocontract', engineNumber: '77' });
const NO_CUSTOMER = engine({ id: 'e-nocustomer', engineNumber: '88', contractId: 'c2', customerName: '' });
const NO_HISTORY = engine({
  id: 'e-nohistory',
  engineNumber: '99',
  contractId: 'c3',
  customerName: 'ООО Ветер',
  stageCodes: [],
  lastStageCode: '',
  lastStageAt: undefined,
});
const SHIPPED = engine({ id: 'e-shipped', engineNumber: '55', shippingDate: ARRIVAL + 5 * DAY });

describe('причина проблемы двигателя для плана', () => {
  it('нет карточки — блокирует', () => {
    const problem = productionProgramEngineProblem(null);
    expect(problem.code).toBe('no_card');
    expect(problem.blocking).toBe(true);
    expect(problem.forbidden).toBe(false);
  });

  it('отгруженный — взять в план нельзя', () => {
    const problem = productionProgramEngineProblem(SHIPPED);
    expect(problem.code).toBe('shipped');
    expect(problem.forbidden).toBe(true);
  });

  it('нет договора — блокирует, а нет контрагента — предупреждение', () => {
    // Договора нет — строке группы не из чего собрать: она ждёт в блоке.
    expect(productionProgramEngineProblem(NO_CONTRACT).code).toBe('no_contract');
    expect(productionProgramEngineProblem(NO_CONTRACT).blocking).toBe(true);
    // Контрагент не обязателен для группы: шапка сложится из номера договора,
    // а отсутствие контрагента оператор видит в отчёте добавления.
    expect(productionProgramEngineProblem(NO_CUSTOMER).code).toBe('no_customer');
    expect(productionProgramEngineProblem(NO_CUSTOMER).blocking).toBe(false);
  });

  it('нет истории ремонта — предупреждение, а не блок', () => {
    // Двигатель с договором и контрагентом, но без этапов, — обычный новый приход:
    // он уезжает в группу своего договора.
    const problem = productionProgramEngineProblem(NO_HISTORY);
    expect(problem.code).toBe('no_history');
    expect(problem.blocking).toBe(false);
  });

  it('годный двигатель — без проблем', () => {
    const problem = productionProgramEngineProblem(GOOD);
    expect(problem.code).toBe('ok');
    expect(problem.blocking).toBe(false);
  });
});

describe('поиск карточки по номеру', () => {
  const index = productionProgramEngineIndex([GOOD, NO_CONTRACT, SHIPPED]);

  it('номер находится', () => {
    const match = productionProgramEngineMatch(index, '41/26');
    expect(match.engine?.id).toBe('e-good');
    expect(match.ambiguous).toBe(false);
  });

  it('регистр и пробелы не мешают', () => {
    expect(productionProgramEngineMatch(index, '  41/26 ').engine?.id).toBe('e-good');
  });

  it('несколько карточек с одним номером — выбор не делаем', () => {
    const dup = productionProgramEngineIndex([GOOD, engine({ id: 'e-dup', engineNumber: '41/26' })]);
    const match = productionProgramEngineMatch(dup, '41/26');
    expect(match.ambiguous).toBe(true);
    expect(match.matches).toBe(2);
    expect(match.engine).toBeNull();
  });

  it('номера нет в базе', () => {
    const match = productionProgramEngineMatch(index, 'нет-такого');
    expect(match.engine).toBeNull();
    expect(match.matches).toBe(0);
  });
});

describe('проход перепроверки блока «Требует данных»', () => {
  const index = productionProgramEngineIndex([GOOD, NO_CONTRACT]);

  const labelOf = (e: EngineListItem) => (e.contractId ? `ООО Ромашка · 125/2` : '');

  it('строка без договора уезжает в группу своего договора, когда карточка починена', () => {
    const rows = [
      {
        id: 'r1',
        orderNo: 1,
        contractId: null,
        groupLabel: PRODUCTION_PROGRAM_PENDING_GROUP_LABEL,
        engineId: null,
        engineMark: '',
        engineNumber: '41/26',
        note: 'Нет карточки в базе',
      },
      {
        id: 'r2',
        orderNo: 2,
        contractId: 'c1',
        groupLabel: 'ООО Ромашка · 125/2',
        engineId: 'e-good',
        engineMark: 'Д-245',
        engineNumber: '41/26',
        note: '',
      },
    ];
    const result = productionProgramResolvePendingRows({
      rows,
      index,
      contractLabelOf: labelOf,
      contractKindOf: () => 'military',
    });
    expect(result.changed).toBe(true);
    expect(result.moved).toBe(1);
    const moved = result.rows.find((r) => r.id === 'r1');
    expect(moved?.contractId).toBe('c1');
    expect(moved?.groupLabel).toBe('ООО Ромашка · 125/2');
    expect(moved?.engineId).toBe('e-good');
    // Служебный текст причины снят — на бумаге строка уже не «проблемная».
    expect(moved?.note).toBe('');
    // И уехала к своей группе, а не в конец программы.
    expect(result.rows.map((r) => r.id)).toEqual(['r2', 'r1']);
  });

  it('карточка без договора — строка остаётся в блоке, а причина честная', () => {
    const rows = [
      {
        id: 'r1',
        orderNo: 1,
        contractId: null,
        groupLabel: PRODUCTION_PROGRAM_PENDING_GROUP_LABEL,
        engineId: null,
        engineMark: '',
        engineNumber: '77',
        note: 'Нет карточки в базе',
      },
    ];
    const result = productionProgramResolvePendingRows({ rows, index, contractLabelOf: labelOf });
    expect(result.changed).toBe(true);
    expect(result.moved).toBe(0);
    expect(result.unresolved).toBe(1);
    const row = result.rows[0];
    // Карточка нашлась — номер стал карточкой.
    expect(row?.engineId).toBe('e-nocontract');
    // Договора нет — причина обновилась, строка осталась в блоке.
    expect(row?.note).toBe('Нет договора');
    expect(row?.contractId).toBeNull();
    expect(row?.groupLabel).toBe(PRODUCTION_PROGRAM_PENDING_GROUP_LABEL);
  });

  it('примечание оператора переписывать нельзя', () => {
    const rows = [
      {
        id: 'r1',
        orderNo: 1,
        contractId: null,
        groupLabel: PRODUCTION_PROGRAM_PENDING_GROUP_LABEL,
        engineId: null,
        engineMark: '',
        engineNumber: '77',
        note: 'Позвонить заказчику',
      },
    ];
    const result = productionProgramResolvePendingRows({ rows, index, contractLabelOf: labelOf });
    expect(result.rows[0]?.note).toBe('Позвонить заказчику');
  });

  it('без изменений — записи не будет', () => {
    const rows = [
      {
        id: 'r1',
        orderNo: 1,
        contractId: null,
        groupLabel: PRODUCTION_PROGRAM_PENDING_GROUP_LABEL,
        engineId: 'e-nocontract',
        engineMark: 'Д-245',
        engineNumber: '77',
        note: 'Нет договора',
      },
    ];
    const result = productionProgramResolvePendingRows({ rows, index, contractLabelOf: labelOf });
    expect(result.changed).toBe(false);
    expect(result.moved).toBe(0);
    expect(result.unresolved).toBe(1);
  });

  it('шапка группы не годится — строка ждёт, и причина честная', () => {
    // Договор есть, а подпись группы пустая (номер договора ещё не доехал зеркалом):
    // строка остаётся в блоке и уедет сама, когда подпись появится.
    const rows = [
      {
        id: 'r1',
        orderNo: 1,
        contractId: null,
        groupLabel: PRODUCTION_PROGRAM_PENDING_GROUP_LABEL,
        engineId: 'e-good',
        engineMark: 'Д-245',
        engineNumber: '41/26',
        note: '',
      },
    ];
    const result = productionProgramResolvePendingRows({
      rows,
      index,
      contractLabelOf: () => '',
    });
    expect(result.changed).toBe(true);
    expect(result.moved).toBe(0);
    expect(result.rows[0]?.note).toBe('Нет номера договора');
    expect(result.rows[0]?.contractId).toBeNull();
  });

  it('кандидаты блока — только строки без договора, с их карточками', () => {
    const rows = [
      { id: 'r1', contractId: null, engineId: null, engineNumber: '41/26' },
      { id: 'r2', contractId: 'c1', engineId: 'e-good', engineNumber: '41/26' },
    ];
    const candidates = productionProgramPendingCandidates(rows, index);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.rowId).toBe('r1');
    expect(candidates[0]?.engine?.id).toBe('e-good');
  });

  it('служебный текст примечания отличается от текста оператора', () => {
    expect(productionProgramSystemNote('Нет договора')).toBe(true);
    expect(productionProgramSystemNote('')).toBe(true);
    expect(productionProgramSystemNote('Позвонить заказчику')).toBe(false);
  });
});

describe('слияние серверных строк с локальной правкой', () => {
  it('чужая строка, добавленная другим оператором, не теряется', () => {
    // Набор заменяется целиком, а реплика отстаёт на минуту: без слияния запись
    // снесла бы строку соседа, которой мы ещё не видели.
    const merged = productionProgramMergeRows({
      server: [
        { id: 'r1', note: 'сервер' },
        { id: 'r2', note: 'сосед' },
      ],
      local: [{ id: 'r1', note: 'моя правка' }],
    });
    expect(merged.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(merged.find((r) => r.id === 'r1')?.note).toBe('моя правка');
    expect(merged.find((r) => r.id === 'r2')?.note).toBe('сосед');
  });

  it('наша новая строка (ещё не на сервере) остаётся', () => {
    const merged = productionProgramMergeRows({
      server: [{ id: 'r1', note: '' }],
      local: [
        { id: 'r1', note: '' },
        { id: 'r3', note: 'новая' },
      ],
    });
    expect(merged.map((r) => r.id)).toEqual(['r1', 'r3']);
  });

  it('снятая нами строка в серверный набор не возвращается', () => {
    // Снятая строка отсутствует и в сервере, и у нас — её нет в результате.
    const merged = productionProgramMergeRows({
      server: [{ id: 'r2', note: '' }],
      local: [{ id: 'r2', note: '' }],
    });
    expect(merged.map((r) => r.id)).toEqual(['r2']);
  });
});
