import { describe, expect, it } from 'vitest';
import type { WorkOrderWorkLine } from '@matricarmz/shared';

import {
  buildProducedLinesFromWorkLines,
  buildConsumedLinesFromWorkLines,
} from '../services/workOrderClosingService.js';

// Минимальная строка работ: тестируем только поля, влияющие на свёртку
// (partId / qty / sourceWarehouseId). Остальное — обязательный шум типа.
function wl(p: Partial<WorkOrderWorkLine>): WorkOrderWorkLine {
  return {
    lineNo: 0,
    serviceId: null,
    serviceName: '',
    unit: 'шт',
    qty: 0,
    priceRub: 0,
    amountRub: 0,
    ...p,
  };
}

describe('buildProducedLinesFromWorkLines (closing-branch: Repair/Manufacturing → produced)', () => {
  it('сворачивает одинаковый partId в одну строку, суммируя qty', () => {
    const out = buildProducedLinesFromWorkLines(
      [wl({ partId: 'p1', qty: 2 }), wl({ partId: 'p1', qty: 3 })],
      'workshop_42',
    );
    expect(out).toEqual([{ lineNo: 1, nomenclatureId: 'p1', qty: 5, targetWarehouseId: 'workshop_42' }]);
  });

  it('все produced-строки идут на переданный targetWarehouseId, lineNo инкрементится по разным деталям', () => {
    const out = buildProducedLinesFromWorkLines(
      [wl({ partId: 'p1', qty: 1 }), wl({ partId: 'p2', qty: 4 })],
      'workshop_7',
    );
    expect(out).toEqual([
      { lineNo: 1, nomenclatureId: 'p1', qty: 1, targetWarehouseId: 'workshop_7' },
      { lineNo: 2, nomenclatureId: 'p2', qty: 4, targetWarehouseId: 'workshop_7' },
    ]);
  });

  it('пропускает пустой partId и qty<=0, тримит partId, обрезает дробный qty', () => {
    const out = buildProducedLinesFromWorkLines(
      [
        wl({ partId: '  p9  ', qty: 2.9 }),
        wl({ partId: '', qty: 5 }),
        wl({ partId: 'p9', qty: 0 }),
        wl({ partId: 'p9', qty: -3 }),
      ],
      'wh',
    );
    expect(out).toEqual([{ lineNo: 1, nomenclatureId: 'p9', qty: 2, targetWarehouseId: 'wh' }]);
  });

  it('пустой вход → пустой выход', () => {
    expect(buildProducedLinesFromWorkLines([], 'wh')).toEqual([]);
  });
});

describe('buildConsumedLinesFromWorkLines (closing-branch: Assembly → consumed)', () => {
  it('per-line sourceWarehouseId переопределяет дефолт, пустой/отсутствующий → дефолт', () => {
    const out = buildConsumedLinesFromWorkLines(
      [
        wl({ partId: 'p1', qty: 1, sourceWarehouseId: 'wh_src' }),
        wl({ partId: 'p2', qty: 2 }),
        wl({ partId: 'p3', qty: 3, sourceWarehouseId: '  ' }),
      ],
      'wh_default',
    );
    expect(out).toEqual([
      { lineNo: 1, nomenclatureId: 'p1', qty: 1, sourceWarehouseId: 'wh_src' },
      { lineNo: 2, nomenclatureId: 'p2', qty: 2, sourceWarehouseId: 'wh_default' },
      { lineNo: 3, nomenclatureId: 'p3', qty: 3, sourceWarehouseId: 'wh_default' },
    ]);
  });

  it('сворачивает по partId@source: тот же source → сумма; разный source → отдельные строки', () => {
    const out = buildConsumedLinesFromWorkLines(
      [
        wl({ partId: 'p1', qty: 2, sourceWarehouseId: 'A' }),
        wl({ partId: 'p1', qty: 3, sourceWarehouseId: 'A' }),
        wl({ partId: 'p1', qty: 4, sourceWarehouseId: 'B' }),
      ],
      'def',
    );
    expect(out).toEqual([
      { lineNo: 1, nomenclatureId: 'p1', qty: 5, sourceWarehouseId: 'A' },
      { lineNo: 2, nomenclatureId: 'p1', qty: 4, sourceWarehouseId: 'B' },
    ]);
  });

  it('пропускает пустой partId и qty<=0', () => {
    const out = buildConsumedLinesFromWorkLines(
      [wl({ partId: '', qty: 5 }), wl({ partId: 'p1', qty: 0 }), wl({ partId: 'p1', qty: 7 })],
      'def',
    );
    expect(out).toEqual([{ lineNo: 1, nomenclatureId: 'p1', qty: 7, sourceWarehouseId: 'def' }]);
  });
});
