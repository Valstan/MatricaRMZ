import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Промт КАРМАНА #147: «Префикс вида: фильтр по виду заказчика».
 *
 * Правило одно на программу — значит, и применять его должен один модуль, а вид читаться
 * из одного источника (строгая таблица `erp_counterparties.engine_kind`; в EAV вида нет).
 * Страж держит это структурно: если кто-то снова разведёт экраны (фильтр в одном месте,
 * подпись — в другом, вид из EAV), тест покраснеет.
 *
 * Смысл guard'а — не «в файле есть эти слова», а «правило применяется там, где надо»:
 * фильтр в поле «Контрагент», вид — в строке списка заказчиков.
 */
const here = dirname(fileURLToPath(import.meta.url));
const pages = {
  contract: resolve(here, '../pages/ContractDetailsPage.tsx'),
  counterparties: resolve(here, '../pages/CounterpartiesPage.tsx'),
  options: resolve(here, '../utils/counterpartyOptions.ts'),
};

const contractSource = readFileSync(pages.contract, 'utf8');
const counterpartiesSource = readFileSync(pages.counterparties, 'utf8');
const optionsSource = readFileSync(pages.options, 'utf8');

describe('отбор заказчиков по виду: правило одно (промт #147)', () => {
  it('поле «Контрагент» отбирает подсказки по виду договора', () => {
    expect(contractSource).toContain('filterCounterpartyOptionsByContractKind');
    expect(contractSource).toContain("from '../utils/counterpartyOptions.js'");
    // В поле идёт ОТФИЛЬТРОВАННЫЙ список, а не весь: иначе отбор ничего не отбирал бы.
    expect(contractSource).toContain('options={customerOptionsByKind.visible}');
  });

  it('оператор видит правило отбора под полем — «пропал заказчик» не читается как поломка', () => {
    expect(contractSource).toContain('counterpartyKindFilterNote');
    expect(contractSource).toContain('data-counterparty-kind-note');
  });

  it('выбранный контрагент не теряется при смене вида договора', () => {
    expect(contractSource).toContain('keepIds: selectedCustomerId ? [selectedCustomerId] : []');
  });

  it('вид заказчика в списке читается из строгой таблицы, а не из EAV', () => {
    expect(counterpartiesSource).toContain('parseCounterpartyKind(strict?.engine_kind)');
    // Колонка «Вид» — оператор должен видеть вид заказчика в списке.
    expect(counterpartiesSource).toContain("id: 'engineKind', label: 'Вид'");
  });

  it('общий модуль несёт вид заказчика и отбор — второй источник вида не заводим', () => {
    expect(optionsSource).toContain('parseCounterpartyKind(strict?.engine_kind)');
    expect(optionsSource).toContain('filterCounterpartiesByContractKind');
    // Источник вида — строгая таблица; из EAV вид не берём.
    expect(optionsSource).not.toContain('attrsById.get(String(row.id))?.engine_kind');
  });
});
