import { describe, expect, it } from 'vitest';

import { resolveProductionProgramRowId, validateLine } from '../services/productionProgramService.js';

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

/**
 * Постоянный id строки плана — то, из-за чего двигатель пропадал из плана.
 *
 * Пока сервер на каждое сохранение заводил строке новый uuid (а старую снимал
 * мягко), журнал увозил пару «удалить + вставить», и клиент применял её по очереди:
 * между удалением и вставкой двигатель исчезал из плана и возвращался. Клиент шлёт
 * id сам — значит, сервер обязан его принять.
 */
describe('id строки плана: постоянный, а не новый на каждое сохранение', () => {
  const ROW_UUID = '11111111-2222-4333-8444-555555555555';
  const OTHER_UUID = '99999999-8888-4777-8666-555555555555';

  it('клиентский uuid принимается — строка не пересоздаётся', () => {
    const id = resolveProductionProgramRowId({
      requestedId: ROW_UUID,
      foreignIds: new Set<string>(),
      fallbackId: () => 'new-id',
    });
    expect(id).toBe(ROW_UUID);
  });

  it('чужой id (занятый другой программой) не берётся — строка не переезжает между планами', () => {
    const id = resolveProductionProgramRowId({
      requestedId: ROW_UUID,
      foreignIds: new Set([ROW_UUID]),
      fallbackId: () => 'new-id',
    });
    expect(id).toBe('new-id');
  });

  it('не-uuid отбрасывается: id строки — uuid, иначе сервер заведёт свой', () => {
    const id = resolveProductionProgramRowId({
      requestedId: 'draft-1712-0',
      foreignIds: new Set<string>(),
      fallbackId: () => 'new-id',
    });
    expect(id).toBe('new-id');
  });

  it('пустой id — сервер заводит свой', () => {
    const id = resolveProductionProgramRowId({
      requestedId: null,
      foreignIds: new Set<string>(),
      fallbackId: () => 'new-id',
    });
    expect(id).toBe('new-id');
  });

  it('id другой программы не влияет на id этой', () => {
    const id = resolveProductionProgramRowId({
      requestedId: ROW_UUID,
      foreignIds: new Set([OTHER_UUID]),
      fallbackId: () => 'new-id',
    });
    expect(id).toBe(ROW_UUID);
  });
});
