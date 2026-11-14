import { describe, expect, it } from 'vitest';

import { buildPpeIssueCard, type PpeIssueCardFact, type PpeIssueCardPosition } from './ppeIssueCard.js';

const CAP: PpeIssueCardPosition = {
  nomenclatureId: 'nom-1',
  name: 'Костюм МОТОР',
  certificate: 'ЕАЭС N RU Д-CN.РА08.В.38076/23',
  unit: 'шт',
};
const BOOTS: PpeIssueCardPosition = {
  nomenclatureId: 'nom-2',
  name: 'Ботинки ТОФФ ТРУД МП',
  certificate: 'ЕАЭС RU C-RU.ЛТ45.В.00729/23',
  unit: 'пар',
};

function fact(over: Partial<PpeIssueCardFact> & { nomenclatureId: string; issuedAt: number }): PpeIssueCardFact {
  return { qty: 1, wearPercent: null, returnedAt: null, ...over };
}

describe('карточка выдачи СИЗ', () => {
  it('позиция без выдачи — строка бланка (колонки пустые)', () => {
    const card = buildPpeIssueCard({ positions: [CAP, BOOTS], facts: [] });

    expect(card.lines).toHaveLength(2);
    expect(card.lines[0]?.fact).toBeNull();
    expect(card.lines[1]?.fact).toBeNull();
    expect(card.factsCount).toBe(0);
  });

  it('выдача занимает свою позицию, остальные остаются бланком', () => {
    const card = buildPpeIssueCard({
      positions: [CAP, BOOTS],
      facts: [fact({ nomenclatureId: 'nom-2', issuedAt: 100, qty: 1, wearPercent: 10 })],
    });

    expect(card.lines).toHaveLength(2);
    expect(card.lines[0]?.fact).toBeNull();
    expect(card.lines[1]?.fact?.qty).toBe(1);
    expect(card.lines[1]?.fact?.wearPercent).toBe(10);
  });

  it('вторая выдача той же позиции — продолжение (название не печатается снова)', () => {
    const card = buildPpeIssueCard({
      positions: [CAP],
      facts: [
        fact({ nomenclatureId: 'nom-1', issuedAt: 200, qty: 2 }),
        fact({ nomenclatureId: 'nom-1', issuedAt: 100, qty: 1 }),
      ],
    });

    expect(card.lines).toHaveLength(2);
    // выдачи отсортированы по хронологии
    expect(card.lines[0]?.fact?.issuedAt).toBe(100);
    expect(card.lines[0]?.continued).toBe(false);
    expect(card.lines[1]?.fact?.issuedAt).toBe(200);
    expect(card.lines[1]?.continued).toBe(true);
  });

  it('выданное, чего нет в норме, не теряется — отдельная строка', () => {
    const card = buildPpeIssueCard({
      positions: [CAP],
      facts: [fact({ nomenclatureId: 'nom-9', issuedAt: 300, name: 'Каска РОСОМЗ', certificate: 'ЕАЭС RU C- RU.СЩ03.В.01229/25' })],
    });

    expect(card.lines).toHaveLength(2);
    expect(card.lines[1]?.position.name).toBe('Каска РОСОМЗ');
    expect(card.lines[1]?.position.certificate).toBe('ЕАЭС RU C- RU.СЩ03.В.01229/25');
    expect(card.factsCount).toBe(1);
  });

  it('возврат вещи виден в своей строке', () => {
    const card = buildPpeIssueCard({
      positions: [CAP],
      facts: [fact({ nomenclatureId: 'nom-1', issuedAt: 100, returnedAt: 500, wearPercent: 40 })],
    });

    expect(card.lines[0]?.fact?.returnedAt).toBe(500);
    expect(card.lines[0]?.fact?.wearPercent).toBe(40);
  });
});
