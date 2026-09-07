import { describe, expect, it } from 'vitest';

import { resolveEngineCustomer } from './engineCustomer.js';

// Правило владельца 07.09.2026: заказчик считается из договора при каждом обращении, а не
// прибивается к карточке. Запасной путь — поле карточки, и он не «на всякий случай»:
// 1149 двигателей на проде несут заказчика только там, договора у них нет.
const contracts = new Map([
  ['C1', 'CP1'],
  ['C2', 'CP2'],
]);

describe('resolveEngineCustomer', () => {
  it('договор — источник истины, даже если в карточке стоит другое', () => {
    expect(resolveEngineCustomer({ contractId: 'C1', customerId: 'CP2' }, contracts)).toEqual({
      id: 'CP1',
      source: 'contract',
    });
  });

  it('перецепка договора меняет заказчика сама, без правки карточки', () => {
    const engine = { contractId: 'C1', customerId: 'CP1' };
    expect(resolveEngineCustomer(engine, contracts).id).toBe('CP1');
    expect(resolveEngineCustomer({ ...engine, contractId: 'C2' }, contracts).id).toBe('CP2');
  });

  it('без договора остаётся поле карточки — иначе 1149 двигателей теряют заказчика', () => {
    expect(resolveEngineCustomer({ customerId: 'CP2' }, contracts)).toEqual({ id: 'CP2', source: 'card' });
  });

  it('договор указан, но неизвестен (не доехал в реплику) — карточка спасает', () => {
    expect(resolveEngineCustomer({ contractId: 'C_UNKNOWN', customerId: 'CP1' }, contracts)).toEqual({
      id: 'CP1',
      source: 'card',
    });
  });

  it('нет ни того, ни другого — пусто и честно названо источником none', () => {
    expect(resolveEngineCustomer({}, contracts)).toEqual({ id: '', source: 'none' });
    expect(resolveEngineCustomer(null, contracts)).toEqual({ id: '', source: 'none' });
    expect(resolveEngineCustomer({ contractId: '   ', customerId: '  ' }, contracts)).toEqual({ id: '', source: 'none' });
  });

  it('источник значения возвращается наружу — интерфейсу нужно объяснить, откуда взято', () => {
    expect(resolveEngineCustomer({ contractId: 'C1' }, contracts).source).toBe('contract');
    expect(resolveEngineCustomer({ customerId: 'CP1' }, contracts).source).toBe('card');
  });
});
