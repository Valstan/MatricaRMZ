import { describe, expect, it } from 'vitest';

import {
  buildEngineVisits,
  engineReclamationArrivals,
  engineReclamationFacts,
  engineReclamationHistoryLines,
  engineReclamationShipments,
  formatQueueDate,
  sortEngineReclamations,
  validateEngineReclamationQueue,
  type EngineReclamationDto,
} from './engineReclamations.js';

function reclamation(overrides: Partial<EngineReclamationDto> = {}): EngineReclamationDto {
  return {
    id: 'r1',
    engineId: 'e1',
    queueNo: 1,
    acceptedAt: null,
    shippedAt: null,
    customerReason: null,
    actualDefect: null,
    defectNature: null,
    actNumber: null,
    actDate: null,
    comment: null,
    ...overrides,
  };
}

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2026, 9, 1);

/**
 * Гейт дат заездов (владелец 10.11.2026): «основное — это первый заезд, рекламация —
 * второй, третий… даты прихода и отгрузки по рекламациям не должны пересекаться».
 */
describe('очередь рекламаций: заезды не пересекаются', () => {
  it('пустая очередь — без замечаний', () => {
    expect(validateEngineReclamationQueue({ rows: [] })).toBeNull();
  });

  it('рекламация после основного цикла — по порядку', () => {
    const res = validateEngineReclamationQueue({
      rows: [{ queueNo: 1, acceptedAt: BASE + 10 * DAY, shippedAt: BASE + 20 * DAY }],
      mainArrivalDate: BASE,
      mainShippingDate: BASE + 5 * DAY,
    });
    expect(res).toBeNull();
  });

  it('приём по рекламации раньше отгрузки основного цикла — отказ', () => {
    const res = validateEngineReclamationQueue({
      rows: [{ queueNo: 1, acceptedAt: BASE + DAY, shippedAt: BASE + 20 * DAY }],
      mainArrivalDate: BASE,
      mainShippingDate: BASE + 5 * DAY,
    });
    expect(res).toContain('основного цикла');
  });

  it('вторая рекламация раньше отправки первой — отказ', () => {
    const res = validateEngineReclamationQueue({
      rows: [
        { queueNo: 1, acceptedAt: BASE + 10 * DAY, shippedAt: BASE + 20 * DAY },
        { queueNo: 2, acceptedAt: BASE + 15 * DAY, shippedAt: BASE + 25 * DAY },
      ],
      mainArrivalDate: BASE,
      mainShippingDate: BASE + 5 * DAY,
    });
    expect(res).toContain('рекламации №1');
  });

  it('пропуск номера в очереди — отказ', () => {
    const res = validateEngineReclamationQueue({
      rows: [
        { queueNo: 1, acceptedAt: BASE + 10 * DAY },
        { queueNo: 3, acceptedAt: BASE + 20 * DAY },
      ],
    });
    expect(res).toContain('подряд');
  });

  it('отправка раньше приёма внутри одной рекламации — отказ', () => {
    const res = validateEngineReclamationQueue({
      rows: [{ queueNo: 1, acceptedAt: BASE + 20 * DAY, shippedAt: BASE + 10 * DAY }],
    });
    expect(res).toContain('отправка раньше приёма');
  });

  it('отгрузка основного цикла раньше его прихода — отказ', () => {
    const res = validateEngineReclamationQueue({
      rows: [],
      mainArrivalDate: BASE + 10 * DAY,
      mainShippingDate: BASE,
    });
    expect(res).toContain('раньше прихода');
  });
});

describe('порядок рекламаций', () => {
  it('сортировка по номеру очереди, а не по позиции в массиве', () => {
    const sorted = sortEngineReclamations([
      reclamation({ id: 'b', queueNo: 2 }),
      reclamation({ id: 'a', queueNo: 1 }),
      reclamation({ id: 'c', queueNo: 3 }),
    ]);
    expect(sorted.map((r) => r.queueNo)).toEqual([1, 2, 3]);
  });

  it('заезды: основной цикл — №1, рекламации следом', () => {
    const visits = buildEngineVisits({
      mainArrivalDate: BASE,
      mainShippingDate: BASE + 5 * DAY,
      reclamations: [reclamation({ queueNo: 1, acceptedAt: BASE + 10 * DAY, shippedAt: BASE + 20 * DAY })],
    });
    expect(visits).toHaveLength(2);
    expect(visits[0]?.visitNo).toBe(1);
    expect(visits[0]?.label).toBe('Основной цикл');
    expect(visits[1]?.visitNo).toBe(2);
    expect(visits[1]?.label).toBe('Рекламация №1');
    expect(visits[1]?.arrivalDate).toBe(BASE + 10 * DAY);
  });

  it('история рекламации говорит о приёме, отправке и характере дефекта', () => {
    const lines = engineReclamationHistoryLines(
      reclamation({
        queueNo: 2,
        acceptedAt: BASE + 10 * DAY,
        shippedAt: BASE + 20 * DAY,
        defectNature: 'Разрушение вкладышей',
        actNumber: '14/26',
      }),
    );
    expect(lines[0]).toContain('Приём по рекламации №2');
    expect(lines[1]).toContain('Отправка по рекламации №2');
    expect(lines.join(' ')).toContain('Разрушение вкладышей');
    expect(lines.join(' ')).toContain('14/26');
  });

  it('дата в тексте — ДД.ММ.ГГГГ', () => {
    expect(formatQueueDate(new Date(2026, 9, 3, 12).getTime())).toBe('03.10.2026');
  });
});

/**
 * Факты отслеживания (признак «рекламационный», даты приёма и отгрузки) считаются
 * из САМОЙ очереди: EAV-зеркало поддерживалось только при сохранении карточки, и
 * «Сохранить очередь» отслеживание в отчётах и фильтрах не двигало.
 */
describe('очередь рекламаций: факты отслеживания', () => {
  it('пустая очередь — двигатель не рекламационный', () => {
    expect(engineReclamationFacts([])).toEqual({ isReclamation: false, acceptedAt: null, shippedAt: null });
  });

  it('одна рекламация — признак и её даты', () => {
    const facts = engineReclamationFacts([
      reclamation({ queueNo: 1, acceptedAt: BASE + 10 * DAY, shippedAt: BASE + 20 * DAY }),
    ]);
    expect(facts.isReclamation).toBe(true);
    expect(facts.acceptedAt).toBe(BASE + 10 * DAY);
    expect(facts.shippedAt).toBe(BASE + 20 * DAY);
  });

  it('текущая — последняя в очереди, а не первая', () => {
    const facts = engineReclamationFacts([
      reclamation({ id: 'r2', queueNo: 2, acceptedAt: BASE + 30 * DAY, shippedAt: null }),
      reclamation({ id: 'r1', queueNo: 1, acceptedAt: BASE + 10 * DAY, shippedAt: BASE + 20 * DAY }),
    ]);
    expect(facts.acceptedAt).toBe(BASE + 30 * DAY);
    expect(facts.shippedAt).toBeNull();
  });

  it('рекламация без даты приёма — признак есть, дат нет', () => {
    const facts = engineReclamationFacts([reclamation({ queueNo: 1, acceptedAt: null, shippedAt: null })]);
    expect(facts.isReclamation).toBe(true);
    expect(facts.acceptedAt).toBeNull();
    expect(facts.shippedAt).toBeNull();
  });
});

/**
 * Приёмки по рекламации — то, что материализуется этапами ремонта: приход по
 * рекламации приравнивается к приёмке двигателя на заводе (владелец 11.11.2026).
 */
describe('очередь рекламаций: приёмки под этапы', () => {
  it('рекламация с датой приёма — приёмка, рекламация без даты — ещё нет', () => {
    const arrivals = engineReclamationArrivals([
      reclamation({ queueNo: 1, acceptedAt: BASE + 10 * DAY }),
      reclamation({ queueNo: 2, acceptedAt: null }),
    ]);
    expect(arrivals).toEqual([{ queueNo: 1, at: BASE + 10 * DAY }]);
  });

  it('несколько рекламаций — несколько приёмок, по порядку очереди', () => {
    const arrivals = engineReclamationArrivals([
      reclamation({ queueNo: 2, acceptedAt: BASE + 30 * DAY }),
      reclamation({ queueNo: 1, acceptedAt: BASE + 10 * DAY }),
    ]);
    expect(arrivals.map((a) => a.queueNo)).toEqual([1, 2]);
    expect(arrivals.map((a) => a.at)).toEqual([BASE + 10 * DAY, BASE + 30 * DAY]);
  });

  it('пустая очередь — приёмок нет', () => {
    expect(engineReclamationArrivals([])).toEqual([]);
  });
});

/**
 * Отправки по рекламации — тоже под этапы (владелец 13.11.2026): уехал заказчику после
 * ремонта по рекламации — значит, это этап истории, а не поле вкладки.
 */
describe('очередь рекламаций: отправки под этапы', () => {
  it('рекламация с датой отправки — отправка, без даты — ещё не уехал', () => {
    const shipments = engineReclamationShipments([
      reclamation({ queueNo: 1, shippedAt: BASE + 20 * DAY }),
      reclamation({ queueNo: 2, shippedAt: null }),
    ]);
    expect(shipments).toEqual([{ queueNo: 1, at: BASE + 20 * DAY }]);
  });

  it('несколько рекламаций — несколько отправок, по порядку очереди', () => {
    const shipments = engineReclamationShipments([
      reclamation({ queueNo: 2, shippedAt: BASE + 40 * DAY }),
      reclamation({ queueNo: 1, shippedAt: BASE + 20 * DAY }),
    ]);
    expect(shipments.map((s) => s.queueNo)).toEqual([1, 2]);
    expect(shipments.map((s) => s.at)).toEqual([BASE + 20 * DAY, BASE + 40 * DAY]);
  });

  it('пустая очередь — отправок нет', () => {
    expect(engineReclamationShipments([])).toEqual([]);
  });
});
