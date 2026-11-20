import { describe, expect, it } from 'vitest';

import {
  buildEngineVisitViews,
  currentEngineVisit,
  splitEngineHistoryByVisits,
  type EngineVisitView,
} from './engineVisits.js';
import { buildEngineVisits, type EngineReclamationDto } from './engineReclamations.js';

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2026, 9, 1);

function reclamation(overrides: Partial<EngineReclamationDto> = {}): EngineReclamationDto {
  return {
    id: 'r1',
    engineId: 'e1',
    queueNo: 1,
    acceptedAt: null,
    shippedAt: null,
    contractId: null,
    customerId: null,
    arrivalInvoice: null,
    shipmentInvoice: null,
    customerReason: null,
    actualDefect: null,
    defectNature: null,
    actNumber: null,
    actDate: null,
    comment: null,
    ...overrides,
  };
}

/** Три заезда: основной цикл (октябрь), рекламация (ноябрь), второй основной (декабрь). */
function threeVisits(): EngineVisitView[] {
  const visits = buildEngineVisits({
    mainArrivalDate: BASE,
    mainShippingDate: BASE + 10 * DAY,
    reclamations: [reclamation({ queueNo: 1, acceptedAt: BASE + 20 * DAY, shippedAt: BASE + 30 * DAY })],
  });
  return buildEngineVisitViews(visits);
}

describe('заезды: кто текущий, а кто прошлый', () => {
  it('свежие заезды — сверху, нумерация по свежести', () => {
    const views = threeVisits();
    expect(views.map((v) => v.no)).toEqual([1, 2]);
    // Заезд №1 по свежести — рекламация (последний по дате прихода).
    expect(views[0]?.isReclamation).toBe(true);
    expect(views[0]?.role).toBe('current');
    expect(views[1]?.role).toBe('past');
  });

  it('текущий заезд — последний по дате прихода, а не первый в списке', () => {
    const views = threeVisits();
    const current = currentEngineVisit(views);
    expect(current?.isReclamation).toBe(true);
    expect(current?.no).toBe(1);
  });

  it('движок без возврата: текущим остаётся основной цикл', () => {
    const views = buildEngineVisitViews(
      buildEngineVisits({ mainArrivalDate: BASE, mainShippingDate: null, reclamations: [] }),
    );
    expect(views).toHaveLength(1);
    expect(views[0]?.role).toBe('current');
    expect(views[0]?.tone).toBe('current');
  });

  it('рекламация — голубоватый тон, даже когда она старее', () => {
    const views = buildEngineVisitViews(
      buildEngineVisits({
        mainArrivalDate: BASE + 40 * DAY,
        mainShippingDate: null,
        reclamations: [reclamation({ queueNo: 1, acceptedAt: BASE, shippedAt: BASE + 5 * DAY })],
      }),
    );
    const past = views.find((v) => v.isReclamation);
    expect(past?.role).toBe('past');
    expect(past?.tone).toBe('reclamation');
  });

  it('чем старше заезд, тем темнее тон', () => {
    const views = buildEngineVisitViews(
      buildEngineVisits({
        mainArrivalDate: BASE,
        mainShippingDate: BASE + 5 * DAY,
        reclamations: [
          reclamation({ queueNo: 1, acceptedAt: BASE + 10 * DAY, shippedAt: BASE + 15 * DAY }),
          reclamation({ queueNo: 2, acceptedAt: BASE + 20 * DAY, shippedAt: BASE + 25 * DAY }),
        ],
      }),
    );
    // Три заезда: два рекламационных (голубые) и основной цикл — тон по возрасту.
    const main = views.find((v) => v.kind === 'main');
    expect(main?.tone).toBe('aged-2');
    const fresh = views.filter((v) => v.isReclamation).map((v) => v.tone);
    expect(fresh).toEqual(['reclamation', 'reclamation']);
  });
});

describe('заезды: история ремонта по заездам', () => {
  it('строка попадает в заезд, который шёл на её дату', () => {
    const views = threeVisits();
    const items = [
      { at: BASE + 2 * DAY, id: 'repair-1' },
      { at: BASE + 22 * DAY, id: 'repair-2' },
      { at: BASE + 25 * DAY, id: 'repair-3' },
    ];
    const split = splitEngineHistoryByVisits(items, views);
    const main = views.find((v) => v.kind === 'main');
    const recl = views.find((v) => v.isReclamation);
    expect(split.get(main?.visitNo ?? 0)?.map((i) => i.id)).toEqual(['repair-1']);
    expect(split.get(recl?.visitNo ?? 0)?.map((i) => i.id)).toEqual(['repair-2', 'repair-3']);
  });

  it('событие до первого прихода не теряется — оно в первом заезде', () => {
    const views = threeVisits();
    const split = splitEngineHistoryByVisits([{ at: BASE - 5 * DAY, id: 'early' }], views);
    const first = views.find((v) => v.kind === 'main');
    expect(split.get(first?.visitNo ?? 0)?.map((i) => i.id)).toEqual(['early']);
  });

  it('без заездов история не теряется совсем', () => {
    const split = splitEngineHistoryByVisits([{ at: BASE, id: 'x' }], []);
    expect(split.size).toBe(0);
  });
});
