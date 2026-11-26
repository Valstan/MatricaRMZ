import { describe, expect, it } from 'vitest';

import {
  counterpartyLabel,
  counterpartySearchOptionsFromRows,
  counterpartySearchText,
  filterCounterpartyOptionsByContractKind,
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

/**
 * Промт КАРМАНА #147: «Префикс вида: фильтр по виду заказчика».
 *
 * Вид заказчика (префикс) лежит в строгой таблице `erp_counterparties.engine_kind` и уже
 * участвует в общем правиле вида двигателя. Отбор подсказок поля «Контрагент» по виду
 * договора — это ФИЛЬТР, а не гейт заведения двигателя.
 */
describe('отбор заказчиков по виду договора (промт #147)', () => {
  const goz: CounterpartyStrictRow = {
    id: 'cp-goz',
    name: 'Заказчик ГОЗ',
    engine_kind: 'military',
  };
  const civil: CounterpartyStrictRow = {
    id: 'cp-civil',
    name: 'Заказчик Гражданский',
    engine_kind: 'civil',
  };
  const noKind: CounterpartyStrictRow = {
    id: 'cp-none',
    name: 'Заказчик без вида',
    engine_kind: null,
  };

  it('подсказка несёт вид заказчика — оператор видит, почему заказчик предложен', () => {
    const options = counterpartySearchOptionsFromRows([goz, civil, noKind], []);
    expect(options.find((o) => o.id === 'cp-goz')?.engineKind).toBe('military');
    expect(options.find((o) => o.id === 'cp-goz')?.hintText).toBe('Вид: ГОЗ');
    expect(options.find((o) => o.id === 'cp-civil')?.hintText).toBe('Вид: Гражданский');
    expect(options.find((o) => o.id === 'cp-none')?.hintText).toBe('Вид не задан');
  });

  it('в ГОЗ-договоре гражданский заказчик не предлагается', () => {
    const options = counterpartySearchOptionsFromRows([goz, civil, noKind], []);
    const visible = filterCounterpartyOptionsByContractKind(options, 'military');
    expect(visible.map((o) => o.id)).toEqual(['cp-goz', 'cp-none']);
  });

  it('в гражданском договоре ГОЗ-заказчик не предлагается', () => {
    const options = counterpartySearchOptionsFromRows([goz, civil, noKind], []);
    const visible = filterCounterpartyOptionsByContractKind(options, 'civil');
    expect(visible.map((o) => o.id)).toEqual(['cp-civil', 'cp-none']);
  });

  it('заказчик без вида предлагается в обоих договорах — но с пометкой «Вид не задан»', () => {
    const options = counterpartySearchOptionsFromRows([goz, civil, noKind], []);
    for (const kind of ['military', 'civil'] as const) {
      const visible = filterCounterpartyOptionsByContractKind(options, kind);
      expect(visible.map((o) => o.id)).toContain('cp-none');
      expect(visible.find((o) => o.id === 'cp-none')?.hintText).toBe('Вид не задан');
    }
  });

  it('выбранный контрагент чужого вида остаётся в поле', () => {
    const options = counterpartySearchOptionsFromRows([goz, civil, noKind], []);
    const visible = filterCounterpartyOptionsByContractKind(options, 'military', { keepIds: ['cp-civil'] });
    expect(visible.map((o) => o.id)).toContain('cp-civil');
  });

  it('вид договора неизвестен — отбор выключен, показываются все', () => {
    const options = counterpartySearchOptionsFromRows([goz, civil, noKind], []);
    expect(filterCounterpartyOptionsByContractKind(options, null).map((o) => o.id)).toEqual([
      'cp-goz',
      'cp-civil',
      'cp-none',
    ]);
  });

  it('контрагент из EAV вида не имеет — источник вида один (строгая таблица)', () => {
    const options = counterpartySearchOptionsFromRows([], [eavOnly]);
    expect(options[0]?.engineKind ?? null).toBeNull();
    expect(options[0]?.hintText).toBe('Вид не задан');
  });
});
