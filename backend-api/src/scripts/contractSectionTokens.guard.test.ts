import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Разбор `contract_section_number` (раздел договора, к которому привязан двигатель) —
 * ПРАВИЛО ОДНО на весь проект, и оба скрипта переноса обязаны звать именно его.
 *
 * Почему сторож: правил было два, и они резали данные по-разному. «ДС {seq}» — токен ДС,
 * всё остальное домен читает как основной договор (`canonicalContractSectionKey`), но голое
 * число («3») — это номер ДС, и сворачивать его в «primary» нельзя: двигатель съехал бы с
 * своего ДС на основной договор. Решение владельца 13.11.2026 разводит эти случаи.
 *
 * Если у скрипта появится свой разбор значения — данные снова поедут по-разному, и это
 * будет молча: счётчики в отчёте останутся похожими.
 */
const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');

const BACKFILL = read('backfillContractSectionTokens.ts');
const CANONICALIZE = read('canonicalizeContractSectionKeys.ts');

describe('разбор раздела договора — одно правило', () => {
  it('перенос раздела ДС зовёт доменное правило, а не свой разбор', () => {
    expect(BACKFILL).toContain('planContractSectionToken');
    // Прежний собственный разбор («голое число») убран — иначе правило снова разойдётся.
    expect(BACKFILL).not.toContain('isBareNumber');
    expect(BACKFILL).not.toMatch(/\/\^ДС/);
    expect(BACKFILL).not.toContain("=== 'primary'");
  });

  it('канонизатор ключей секций берёт то же правило для привязок двигателей', () => {
    // Слоты платежей — это ключи секций (там канон «primary»/«ДС N»),
    // а привязки двигателей — то же поле `contract_section_number`, разбор один.
    expect(CANONICALIZE).toContain('planContractSectionToken');
  });

  it('оба скрипта пишут в раздел через серверную дверь атрибута', () => {
    // Правка EAV напрямую в SQL обновила бы только сервер: парк читает EAV локально,
    // а серверные строки доезжают до клиентов только через журнал синхронизации.
    expect(BACKFILL).toContain('setEntityAttribute');
    expect(CANONICALIZE).toContain('setEntityAttribute');
    expect(BACKFILL).not.toMatch(/update\s+attribute_values/i);
  });
});
