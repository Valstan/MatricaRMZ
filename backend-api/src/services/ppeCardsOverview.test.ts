import { describe, expect, it } from 'vitest';

import { addWearMonths } from '@matricarmz/shared';

import { buildPpeCardsOverview, type OverviewSources } from './ppeCardsOverview.js';

const NOW = Date.parse('2026-10-20T00:00:00');

function sources(patch: Partial<OverviewSources> = {}): OverviewSources {
  return {
    employees: [],
    sizes: new Map(),
    cards: [],
    cardNorms: [],
    entries: [],
    groupMembers: [],
    groupNorms: [],
    normLines: [],
    absences: [],
    now: NOW,
    ...patch,
  };
}

describe('список карточек СИЗ (ядро)', () => {
  it('считает просрочку по личным нормам сотрудника', () => {
    const rows = buildPpeCardsOverview(
      sources({
        employees: [{ id: 'e1', entityId: 'n1', fullName: 'Иванов', personnelNo: '101', isActive: true }],
        sizes: new Map([['n1', { clothes: '48', shoes: '42', height: '176' }]]),
        cards: [{ id: 'c1', employeeId: 'e1', openedAt: NOW - 10, closedAt: null }],
        cardNorms: [{ cardId: 'c1', normSetId: 's1' }],
        normLines: [{ normSetId: 's1', nomenclatureId: 'x1', qty: 1, wearMonths: 12 }],
        entries: [{ cardId: 'c1', nomenclatureId: 'x1', qty: 1, issuedAt: Date.parse('2025-01-10T00:00:00') }],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      employeeId: 'e1',
      cardState: 'open',
      status: 'overdue',
      overdueCount: 1,
      normPositionCount: 1,
      fillPercent: 100,
      personnelNo: '101',
    });
    expect(rows[0]!.nextDueAt).toBe(addWearMonths(Date.parse('2025-01-10T00:00:00'), 12));
  });

  it('групповые нормы считаются наравне с личными, но без выдач это «не выдавалось»', () => {
    const rows = buildPpeCardsOverview(
      sources({
        employees: [{ id: 'e1', entityId: null, fullName: 'Петров', personnelNo: null, isActive: true }],
        cards: [],
        groupMembers: [{ groupId: 'g1', employeeId: 'e1' }],
        groupNorms: [{ groupId: 'g1', normSetId: 's1' }],
        normLines: [{ normSetId: 's1', nomenclatureId: 'x1', qty: 1, wearMonths: 6 }],
      }),
    );
    expect(rows[0]).toMatchObject({ cardState: 'none', status: 'neverIssued', normSetCount: 1, fillPercent: 20 });
  });

  it('без норм состояние «нет норм», а не выдуманный срок', () => {
    const rows = buildPpeCardsOverview(
      sources({
        employees: [{ id: 'e1', entityId: 'n1', fullName: 'Сидоров', personnelNo: null, isActive: false }],
        sizes: new Map([['n1', { clothes: '', shoes: '43', height: '' }]]),
      }),
    );
    expect(rows[0]).toMatchObject({ status: 'noNorms', nextDueAt: null, isActive: false, fillPercent: 20 });
  });

  it('отпуск сдвигает срок: за день отпуска срок позже на день', () => {
    const base = {
      employees: [{ id: 'e1', entityId: null, fullName: 'Иванов', personnelNo: null, isActive: true }],
      cards: [{ id: 'c1', employeeId: 'e1', openedAt: NOW - 10, closedAt: null }],
      cardNorms: [{ cardId: 'c1', normSetId: 's1' }],
      normLines: [{ normSetId: 's1', nomenclatureId: 'x1', qty: 1, wearMonths: 12 }],
      entries: [{ cardId: 'c1', nomenclatureId: 'x1', qty: 1, issuedAt: Date.parse('2026-01-10T00:00:00') }],
    };
    const plain = buildPpeCardsOverview(sources(base));
    const withVacation = buildPpeCardsOverview(
      sources({ ...base, absences: [{ employeeId: 'e1', fromMs: Date.parse('2026-02-01T00:00:00'), toMs: Date.parse('2026-02-11T00:00:00') }] }),
    );
    expect(withVacation[0]!.nextDueAt! - plain[0]!.nextDueAt!).toBe(10 * 86_400_000);
  });

  it('нормы закрытой карточки не приписываются, если уже открыта новая', () => {
    const rows = buildPpeCardsOverview(
      sources({
        employees: [{ id: 'e1', entityId: null, fullName: 'Иванов', personnelNo: null, isActive: true }],
        cards: [
          { id: 'old', employeeId: 'e1', openedAt: NOW - 1000, closedAt: NOW - 500 },
          { id: 'new', employeeId: 'e1', openedAt: NOW - 100, closedAt: null },
        ],
        cardNorms: [{ cardId: 'old', normSetId: 's1' }],
        normLines: [{ normSetId: 's1', nomenclatureId: 'x1', qty: 1, wearMonths: 12 }],
      }),
    );
    expect(rows[0]).toMatchObject({ cardState: 'open', normSetCount: 0, status: 'noNorms' });
  });
});
