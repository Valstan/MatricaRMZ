import { describe, expect, it } from 'vitest';

import { reclamationMirrorValues } from './engineReclamationMirror.js';

// Зеркало EAV держит ТЕКУЩУЮ (последнюю по номеру очереди) рекламацию. Оно нужно
// клиентам прежней версии (они читают признак и даты из EAV) и серверной проекции
// карточки с ИИ-инструментами. Раньше зеркало копилось только при сохранении карточки,
// а «Сохранить очередь» писал очередь и больше ничего — отсюда был обрыв отслеживания.

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2026, 9, 1);

function valuesOf(list: Array<[string, unknown]>, code: string): unknown {
  return list.find(([c]) => c === code)?.[1];
}

describe('зеркало текущей рекламации', () => {
  it('пустая очередь — признак снят, дат нет', () => {
    const values = reclamationMirrorValues([]);
    expect(valuesOf(values, 'reclamation_flag')).toBe(false);
    expect(valuesOf(values, 'reclamation_accepted_date')).toBeNull();
    expect(valuesOf(values, 'reclamation_shipped_date')).toBeNull();
    expect(valuesOf(values, 'reclamation_customer_reason')).toBeNull();
  });

  it('зеркало берёт последнюю рекламацию очереди', () => {
    const values = reclamationMirrorValues([
      {
        queueNo: 1,
        acceptedAt: BASE + 10 * DAY,
        shippedAt: BASE + 20 * DAY,
        customerReason: 'Треснул блок',
        actualDefect: 'Разрушение вкладышей',
        defectNature: 'Производственный',
        actNumber: '14/26',
        actDate: BASE + 12 * DAY,
        comment: 'Принято по акту',
      },
      {
        queueNo: 2,
        acceptedAt: BASE + 30 * DAY,
        shippedAt: null,
        customerReason: 'Повторный дефект',
        actualDefect: null,
        defectNature: 'Эксплуатационный',
        actNumber: '15/26',
        actDate: null,
        comment: null,
      },
    ]);
    expect(valuesOf(values, 'reclamation_flag')).toBe(true);
    expect(valuesOf(values, 'reclamation_accepted_date')).toBe(BASE + 30 * DAY);
    expect(valuesOf(values, 'reclamation_shipped_date')).toBeNull();
    expect(valuesOf(values, 'reclamation_customer_reason')).toBe('Повторный дефект');
    expect(valuesOf(values, 'reclamation_defect_nature')).toBe('Эксплуатационный');
    expect(valuesOf(values, 'reclamation_act_number')).toBe('15/26');
  });

  it('пустой текст в зеркало не попадает', () => {
    const values = reclamationMirrorValues([
      {
        queueNo: 1,
        acceptedAt: BASE,
        shippedAt: null,
        customerReason: '   ',
        actualDefect: null,
        defectNature: null,
        actNumber: null,
        actDate: null,
        comment: null,
      },
    ]);
    expect(valuesOf(values, 'reclamation_customer_reason')).toBeNull();
    expect(valuesOf(values, 'reclamation_flag')).toBe(true);
  });
});
