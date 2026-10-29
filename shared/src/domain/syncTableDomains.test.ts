import { describe, expect, it } from 'vitest';

import { SyncTableName } from '../sync/tables.js';
import {
  TABLE_DOMAINS,
  domainsOfTables,
  tablesTouchDomains,
  type SyncDomain,
} from './syncTableDomains.js';

// Карта «таблица контракта → экраны» держится на двух полнотах, и обе ломаются молча:
// забыл домен у новой таблицы — экран не разбудится ни разу и покажет вчерашнее;
// придумал домен без таблиц — страница объявила его и не проснётся никогда.
// Поэтому проверяем не отдельные строки, а обе стороны покрытия.

const DOMAINS: SyncDomain[] = [
  'engines',
  'workOrders',
  'workSheets',
  'warehouse',
  'supply',
  'contracts',
  'employees',
  'ppe',
  'chat',
  'notes',
  'users',
  'drafts',
  'audit',
  'directories',
];

describe('карта доменов синка', () => {
  it('у каждой таблицы контракта есть домен', () => {
    const missing = Object.values(SyncTableName).filter((t) => !TABLE_DOMAINS[t]);
    expect(missing).toEqual([]);
  });

  it('у каждого домена есть таблица', () => {
    const mapped = new Set(Object.values(TABLE_DOMAINS).flat());
    expect(DOMAINS.filter((d) => !mapped.has(d))).toEqual([]);
  });

  it('в карте нет таблиц, которых нет в контракте', () => {
    const contract = new Set<string>(Object.values(SyncTableName));
    expect(Object.keys(TABLE_DOMAINS).filter((t) => !contract.has(t))).toEqual([]);
  });

  it('в карте нет неизвестных доменов', () => {
    const known = new Set<SyncDomain>(DOMAINS);
    const unknown = Object.values(TABLE_DOMAINS)
      .flat()
      .filter((d) => !known.has(d));
    expect(unknown).toEqual([]);
  });

  it('складская правка не будит наряды, а правка наряда не будит склад', () => {
    expect(tablesTouchDomains([SyncTableName.ErpRegStockBalance], ['workOrders'])).toBe(false);
    expect(tablesTouchDomains([SyncTableName.Operations], ['warehouse'])).toBe(false);
    expect(tablesTouchDomains([SyncTableName.ErpRegStockBalance], ['warehouse'])).toBe(true);
    expect(tablesTouchDomains([SyncTableName.Operations], ['workOrders', 'workSheets'])).toBe(true);
  });

  it('незнакомая таблица трактуется как «задевает всё»', () => {
    // Новый контракт на сервере, старый клиент: лучше лишняя перечитка, чем устаревший экран.
    expect(tablesTouchDomains(['erp_something_new'], ['ppe'])).toBe(true);
    expect(new Set(domainsOfTables(['erp_something_new'])).size).toBe(0);
  });

  it('страница без доменов перечитывается всегда', () => {
    expect(tablesTouchDomains([SyncTableName.ChatMessages], [])).toBe(true);
  });

  it('EAV-ядро будит справочные экраны, но не склад и не чат', () => {
    expect(tablesTouchDomains([SyncTableName.AttributeValues], ['directories'])).toBe(true);
    expect(tablesTouchDomains([SyncTableName.AttributeValues], ['warehouse'])).toBe(false);
    expect(tablesTouchDomains([SyncTableName.AttributeValues], ['chat'])).toBe(false);
  });
});
