import { describe, expect, it } from 'vitest';

import {
  counterpartyLabel,
  counterpartySearchOptionsFromRows,
  counterpartySearchText,
  mergeCounterpartyRows,
  type CounterpartyEavRow,
  type CounterpartyStrictRow,
} from './counterpartyOptions.js';

/**
 * Промт КАРМАНА #146: «Подсказка выбора контрагента в договоре: новые не видны».
 *
 * Симптом: контрагент есть в списке (список читает строгую таблицу), но в подсказках
 * поля «Контрагент» его нет. Причина — поле читало ТОЛЬКО легаси-EAV, а значения-атрибуты
 * (название, ИНН, КПП, адрес) до клиентов не доезжают ⇒ подписи нет ⇒ по названию
 * контрагент не находится.
 *
 * Лечение: поле выбора и список читают ОДИН источник (мерж строгой таблицы и EAV).
 */

const strictDosaaf: CounterpartyStrictRow = {
  id: '287d4fe7-850b-4abc-91f5-6ffc5c52ff31',
  name: '«ММУСТЦ ДОСААФ России»',
  short_name: 'ДОСААФ',
  inn: '7712095534',
  kpp: '774301001',
  address: 'Москва, ул. Адмирала Макарова, д. 4',
  phone: null,
  email: null,
  updated_at: 1795607875993,
};

const eavOnly: CounterpartyEavRow = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  displayName: 'ООО «Легаси из EAV»',
  searchText: 'Легаси из EAV 7701234567',
  updatedAt: 1700000000000,
};

describe('источник контрагентов (промт #146)', () => {
  it('контрагент из строгой таблицы попадает в подсказки со своим названием', () => {
    const options = counterpartySearchOptionsFromRows([strictDosaaf], []);
    expect(options).toHaveLength(1);
    expect(options[0]?.id).toBe(strictDosaaf.id);
    expect(options[0]?.label).toBe('«ММУСТЦ ДОСААФ России»');
  });

  it('найти можно и по ИНН/адресу — по названию одного мало', () => {
    const options = counterpartySearchOptionsFromRows([strictDosaaf], []);
    expect(options[0]?.searchText).toContain('7712095534');
    expect(options[0]?.searchText).toContain('Адмирала Макарова');
  });

  it('контрагент, которого нет в строгой таблице, не теряется (запасной путь EAV)', () => {
    const options = counterpartySearchOptionsFromRows([strictDosaaf], [eavOnly]);
    expect(options.map((o) => o.id)).toEqual([strictDosaaf.id, eavOnly.id]);
    expect(options[1]?.label).toBe('ООО «Легаси из EAV»');
  });

  it('контрагент из обеих источников не дублируется', () => {
    const options = counterpartySearchOptionsFromRows([strictDosaaf], [{ ...eavOnly, id: strictDosaaf.id }]);
    expect(options).toHaveLength(1);
  });

  it('подпись строки из строгой таблицы приоритетнее, чем из EAV', () => {
    const { strictById, merged } = mergeCounterpartyRows([strictDosaaf], [
      { id: strictDosaaf.id, displayName: 'Другое имя из EAV' },
    ]);
    expect(counterpartyLabel(merged[0]!, strictById)).toBe('«ММУСТЦ ДОСААФ России»');
  });

  it('без названия в обоих источниках показываем короткий id, а не пустую строку', () => {
    const bare: CounterpartyEavRow = { id: 'bbbbbbbb-0000-4000-8000-000000000002' };
    const { strictById, merged } = mergeCounterpartyRows([], [bare]);
    expect(counterpartyLabel(merged[0]!, strictById)).toBe(bare.id);
    expect(counterpartySearchText(merged[0]!, strictById)).toBe('');
  });
});
