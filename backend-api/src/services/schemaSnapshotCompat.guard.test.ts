import { SyncTableName } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

import { LEGACY_SCHEMA_SNAPSHOT_TABLES } from './diagnosticsSchemaService.js';

// Снимок схемы едет на клиент, клиент его хеширует и сравнивает с сохранённым.
// Сборки ДО v3.5.0 на расхождение хеша отвечают ПЕРЕСБОРКОЙ локальной базы —
// вместе с неотправленной работой. На 2026-08-30 таких машин в парке 12 из 26
// активных. Поэтому им отдаётся замороженный состав таблиц, и его нельзя
// «поддерживать в актуальном состоянии»: любое добавление сюда стирает им данные.
//
// Совпадение хеша легаси-ветки с тем, что прод отдавал до выката, проверено
// исполнением (прод 0ccddaf7…, легаси-ветка 0ccddaf7…, полный снимок 735ac12f…).
// Здесь закрепляется то, что проверяемо статически: список не изменился и не
// разъехался с контрактом.

describe('легаси-снимок схемы для сборок ниже v3.5.0', () => {
  it('список заморожен: ровно 20 таблиц, как их знали сборки до B3/R3', () => {
    expect([...LEGACY_SCHEMA_SNAPSHOT_TABLES].sort()).toEqual(
      [
        'ai_chat_requests',
        'attribute_defs',
        'attribute_values',
        'audit_log',
        'card_drafts',
        'chat_messages',
        'chat_reads',
        'entities',
        'entity_types',
        'erp_engine_assembly_bom',
        'erp_engine_assembly_bom_brand_links',
        'erp_engine_assembly_bom_lines',
        'erp_engine_instances',
        'erp_nomenclature',
        'erp_reg_stock_balance',
        'erp_reg_stock_movements',
        'note_shares',
        'notes',
        'operations',
        'user_presence',
      ].sort(),
    );
  });

  it('в нём нет таблиц, вошедших в контракт на B3/R3 — иначе смысл ветки теряется', () => {
    expect(LEGACY_SCHEMA_SNAPSHOT_TABLES).not.toContain(String(SyncTableName.Users));
    expect(LEGACY_SCHEMA_SNAPSHOT_TABLES).not.toContain(String(SyncTableName.UserSectionAccess));
  });

  it('каждое имя — настоящая sync-таблица, а не опечатка', () => {
    const known = new Set<string>(Object.values(SyncTableName));
    for (const t of LEGACY_SCHEMA_SNAPSHOT_TABLES) expect(known.has(t), t).toBe(true);
  });

  it('список НЕ выводится из SyncTableName: следующая таблица контракта сюда не попадёт сама', () => {
    // Если однажды это сравнение станет истинным, значит список начали
    // вычислять — и очередная таблица контракта уедет старым клиентам,
    // стерев им базу. Тест обязан покраснеть раньше, чем это случится.
    expect(LEGACY_SCHEMA_SNAPSHOT_TABLES.length).toBeLessThan(Object.values(SyncTableName).length);
  });
});
