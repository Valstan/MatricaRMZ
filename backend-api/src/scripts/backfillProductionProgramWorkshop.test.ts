import { describe, expect, it } from 'vitest';

import { decideWorkshopMatch, normalizeWorkshopText } from './backfillProductionProgramWorkshop.js';

// Бэкфилл цеха программы (владелец 24.11.2026): заполняем связь ТОЛЬКО при
// однозначном совпадении со справочником. Неоднозначные и несовпавшие не
// угадываем — они идут в отчёт владельцу.
//
// Правило из brain: авто-склейка по natural key запрещена (D-238), неоднозначный
// ключ запрещает переход (G659/G660).

const DIR = [
  { id: '11111111-1111-4111-8111-111111111111', code: '1', name: 'Цех № 1' },
  { id: '22222222-2222-4222-8222-222222222222', code: '2', name: 'Цех № 2' },
];

describe('бэкфилл цеха программы: только однозначное совпадение', () => {
  it('имя нормализуется: регистр, «ё», «№», лишние пробелы', () => {
    expect(normalizeWorkshopText('  ЦЕХ  № 1 ')).toBe('цех 1');
    expect(normalizeWorkshopText('Цех №ё 1')).toBe('цех е 1');
  });

  it('точное совпадение имени — цех находится', () => {
    const verdict = decideWorkshopMatch('Цех № 1', DIR);
    expect(verdict).toEqual({
      action: 'matched',
      workshop: { id: '11111111-1111-4111-8111-111111111111', name: 'Цех № 1' },
    });
  });

  it('разница в написании «№» и пробелов — тот же цех', () => {
    const verdict = decideWorkshopMatch('Цех 1', DIR);
    expect(verdict.action).toBe('matched');
  });

  it('цеха в справочнике нет — не угадываем', () => {
    expect(decideWorkshopMatch('Цех № 7', DIR)).toEqual({ action: 'unmatched' });
    expect(decideWorkshopMatch('', DIR)).toEqual({ action: 'unmatched' });
  });

  it('два живых цеха с одинаковым именем — неоднозначно, не выбираем', () => {
    const dup = [
      ...DIR,
      { id: '33333333-3333-4333-8333-333333333333', code: '1а', name: 'Цех № 1' },
    ];
    const verdict = decideWorkshopMatch('Цех № 1', dup);
    expect(verdict.action).toBe('ambiguous');
    if (verdict.action !== 'ambiguous') throw new Error('ожидалась неоднозначность');
    expect(verdict.candidates).toHaveLength(2);
  });

  it('совпадение по коду цеха — не повод угадывать (только имя)', () => {
    // «Цех 1» — это имя цеха с кодом «1», но и код сам по себе не доказывает,
    // что имелся в виду именно этот цех: в справочнике может быть цех с
    // другим именем и тем же кодом. Совпадение только по имени.
    const verdict = decideWorkshopMatch('1', DIR);
    expect(verdict.action).toBe('unmatched');
  });
});
