import { describe, expect, it } from 'vitest';

import { buildPpeIssueCard, type PpeIssueCardFact, type PpeIssueCardPosition } from '@matricarmz/shared';

import { buildPpeIssueCardHtml, ppeIssueCardDate } from './ppeIssueCardPrint.js';

const CAP: PpeIssueCardPosition = {
  nomenclatureId: 'nom-1',
  name: 'Костюм МОТОР',
  certificate: 'ЕАЭС N RU Д-CN.РА08.В.38076/23',
  unit: 'шт',
};

function fact(over: Partial<PpeIssueCardFact> & { nomenclatureId: string; issuedAt: number }): PpeIssueCardFact {
  return { qty: 1, wearPercent: null, returnedAt: null, ...over };
}

describe('печатная форма карточки выдачи СИЗ', () => {
  it('шапка повторяет форму владельца: 11 колонок, «Выдано» и «Возвращено»', () => {
    const html = buildPpeIssueCardHtml(buildPpeIssueCard({ positions: [CAP], facts: [] }));

    expect(html).toContain('Наименование СИЗ');
    expect(html).toContain('№ сертификата соответствия');
    expect(html).toContain('подпись в получении');
    expect(html).toContain('Подпись работника о сдаче');
    expect(html).toContain('Кладовщика в получении');
    expect(html).toContain('Выдано');
    expect(html).toContain('Возвращено');
    expect((html.match(/<th[ >]/g) ?? []).length).toBe(14);
  });

  it('выдача попадает в графы «Выдано», возврат — в графы «Возвращено»', () => {
    const issuedAt = Date.UTC(2026, 10, 1, 12);
    const returnedAt = Date.UTC(2026, 10, 20, 12);
    const html = buildPpeIssueCardHtml(
      buildPpeIssueCard({ positions: [CAP], facts: [fact({ nomenclatureId: 'nom-1', issuedAt, qty: 2, wearPercent: 30, returnedAt })] }),
    );

    expect(html).toContain('01.11.2026');
    expect(html).toContain('20.11.2026');
    expect(html).toContain('>2<');
    expect(html).toContain('>30<');
  });

  it('бланк: наименование и сертификат есть, графы выдачи пустые', () => {
    const html = buildPpeIssueCardHtml(buildPpeIssueCard({ positions: [CAP], facts: [] }));

    expect(html).toContain('Костюм МОТОР');
    expect(html).toContain('ЕАЭС N RU Д-CN.РА08.В.38076/23');
    // графы выдачи пустые: ни даты, ни количества, ни процента износа
    expect(html).toContain('<td style="text-align:left;"></td><td style="text-align:right;"></td>');
    expect(html).not.toMatch(/\d{2}\.\d{2}\.\d{4}/);
  });

  it('дата: пусто вместо нулевой даты', () => {
    expect(ppeIssueCardDate(null)).toBe('');
    expect(ppeIssueCardDate(0)).toBe('');
  });
});
