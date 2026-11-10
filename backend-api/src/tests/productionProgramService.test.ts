import { describe, expect, it } from 'vitest';

import { validateLine } from '../services/productionProgramService.js';

// Оператору — человеческие наименования. Технический идентификатор в шапке группы
// — это «номер вместо наименования»: в печатной форме плана он выглядит как
// служебная выгрузка, и дверь записи такое отвергает.
const UUID = '9e142af3-caf9-427f-9893-58961e48d4b1';

describe('строка плана: шапка группы — человеческое наименование', () => {
  const base = { orderNo: 1, groupLabel: 'ООО «Заказчик» · 125/2026' };

  it('обычная строка проходит', () => {
    const res = validateLine(base, 0);
    expect(res.ok).toBe(true);
  });

  it('идентификатор в шапке группы отвергается', () => {
    const res = validateLine({ ...base, groupLabel: UUID }, 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('идентификатор');
  });

  it('пустая шапка группы отвергается с внятным объяснением', () => {
    const res = validateLine({ ...base, groupLabel: '   ' }, 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('договор');
  });

  it('состояние строки остаётся из домена: мусорное значение не проходит', () => {
    const res = validateLine({ ...base, state: 'какая-то ерунда' }, 0);
    expect(res.ok).toBe(false);
  });
});
