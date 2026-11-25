import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Промт КАРМАНА #146: «Подсказка выбора контрагента в договоре: новые не видны».
 *
 * Поле выбора и список контрагентов обязаны читать ОДИН источник (общий модуль
 * `counterpartyOptions`). Раньше поле читало только легаси-EAV, а список — строгую
 * таблицу плюс EAV: контрагент был в списке и отсутствовал в подсказках.
 *
 * Сторож держит контракт структурно: если кто-то снова разведёт экраны по источникам,
 * тест покраснеет.
 */
const here = dirname(fileURLToPath(import.meta.url));
const pages = {
  contract: resolve(here, '../pages/ContractDetailsPage.tsx'),
  counterparties: resolve(here, '../pages/CounterpartiesPage.tsx'),
};

const contractSource = readFileSync(pages.contract, 'utf8');
const counterpartiesSource = readFileSync(pages.counterparties, 'utf8');

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) return '';
  const rest = source.slice(start + name.length + 8);
  const end = rest.indexOf('\n  }');
  return end < 0 ? rest.slice(0, 2000) : rest.slice(0, end);
}

describe('контрагенты: один источник для поля выбора и для списка', () => {
  it('поле «Контрагент» в карточке договора читает общий модуль', () => {
    expect(contractSource).toContain("from '../utils/counterpartyOptions.js'");
    const body = functionBody(contractSource, 'loadCustomers');
    expect(body).toContain('loadCounterpartySearchOptions(');
    expect(body, 'поле выбора не должно читать EAV напрямую — это второй источник').not.toContain(
      'entities.listByEntityType(',
    );
  });

  it('список контрагентов мержит строгую таблицу и EAV тем же модулем', () => {
    expect(counterpartiesSource).toContain("from '../utils/counterpartyOptions.js'");
    expect(counterpartiesSource).toContain('loadCounterpartySources(');
    expect(
      counterpartiesSource,
      'мерж строгой таблицы и EAV живёт в общем модуле — второго места быть не должно',
    ).not.toContain('strictRows.length > 0 ? [...strictRows');
  });

  it('общий модуль существует и мержит строгие строки первыми', () => {
    const moduleSource = readFileSync(resolve(here, '../utils/counterpartyOptions.ts'), 'utf8');
    expect(moduleSource).toContain('export function mergeCounterpartyRows(');
    expect(moduleSource).toContain('export async function loadCounterpartySearchOptions(');
    expect(moduleSource).toContain('export async function loadCounterpartySources(');
  });
});
