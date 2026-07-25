import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { findAllIncomingReferences, resolveIncomingReferencesAndSoftDelete } from './entityService.js';

// Реверс-индекс входящих ссылок (Ф1): проверяем, что сканер видит ссылки в ВСЕХ хранилищах,
// а не только в одиночных EAV-линках, — массивный EAV-линк, contract_sections JSON, BOM-junction.
function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE entity_types (id text PRIMARY KEY, code text NOT NULL, name text NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE entities (id text PRIMARY KEY, type_id text NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE attribute_defs (id text PRIMARY KEY, entity_type_id text NOT NULL, code text NOT NULL,
      name text NOT NULL, data_type text NOT NULL, is_required integer NOT NULL DEFAULT 0,
      sort_order integer NOT NULL DEFAULT 0, meta_json text, created_at integer NOT NULL,
      updated_at integer NOT NULL, last_server_seq integer, deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE attribute_values (id text PRIMARY KEY, entity_id text NOT NULL, attribute_def_id text NOT NULL,
      value_json text, created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE operations (id text PRIMARY KEY, engine_entity_id text NOT NULL, operation_type text NOT NULL,
      status text NOT NULL, note text, performed_at integer, performed_by text, meta_json text,
      created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE erp_engine_assembly_bom_brand_links (id text PRIMARY KEY, bom_id text NOT NULL,
      engine_brand_id text NOT NULL, is_primary integer NOT NULL DEFAULT 0,
      is_default_for_brand integer NOT NULL DEFAULT 0, created_at integer NOT NULL, updated_at integer NOT NULL,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced', last_server_seq integer);
  `);
  const db = drizzle(sqlite);
  const t = 1;
  sqlite.prepare(`INSERT INTO entity_types (id,code,name,created_at,updated_at) VALUES (?,?,?,?,?)`).run('et-svc', 'service', 'Услуга', t, t);
  sqlite.prepare(`INSERT INTO entity_types (id,code,name,created_at,updated_at) VALUES (?,?,?,?,?)`).run('et-con', 'contract', 'Контракт', t, t);
  sqlite.prepare(`INSERT INTO entities (id,type_id,created_at,updated_at) VALUES (?,?,?,?)`).run('svc-1', 'et-svc', t, t);
  sqlite.prepare(`INSERT INTO entities (id,type_id,created_at,updated_at) VALUES (?,?,?,?)`).run('con-1', 'et-con', t, t);
  sqlite.prepare(`INSERT INTO attribute_defs (id,entity_type_id,code,name,data_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run('ad-brands', 'et-svc', 'engine_brand_ids', 'Марки', 'link', t, t);
  sqlite.prepare(`INSERT INTO attribute_defs (id,entity_type_id,code,name,data_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run('ad-sections', 'et-con', 'contract_sections', 'Разделы', 'json', t, t);
  return { db, sqlite, t };
}

describe('findAllIncomingReferences', () => {
  it('finds an array-typed EAV link, a contract JSON reference and a BOM junction row', async () => {
    const { db, sqlite, t } = makeDb();
    const target = 'brand-X';
    // Массивный EAV-линк (услуга ссылается на несколько марок) — старый finder такое пропускал.
    sqlite.prepare(`INSERT INTO attribute_values (id,entity_id,attribute_def_id,value_json,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .run('av-1', 'svc-1', 'ad-brands', JSON.stringify(['brand-Y', target]), t, t);
    // Ссылка внутри contract_sections JSON.
    sqlite.prepare(`INSERT INTO attribute_values (id,entity_id,attribute_def_id,value_json,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .run('av-2', 'con-1', 'ad-sections', JSON.stringify({ primary: { internalNumber: '04/ГОЗ-25', engineBrands: [{ engineBrandId: target }] }, addons: [] }), t, t);
    // BOM-junction.
    sqlite.prepare(`INSERT INTO erp_engine_assembly_bom_brand_links (id,bom_id,engine_brand_id,created_at,updated_at) VALUES (?,?,?,?,?)`)
      .run('bl-1', 'bom-1', target, t, t);

    const res = await findAllIncomingReferences(db, target);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const kinds = res.groups.map((g) => g.sourceKind).sort();
    expect(kinds).toEqual(['bom', 'contract', 'eav_link']);
    const contract = res.groups.find((g) => g.sourceKind === 'contract');
    expect(contract?.sourceLabel).toBe('04/ГОЗ-25');
    expect(contract?.paths).toContain('primary.engineBrands[0].engineBrandId');
  });

  it('ignores unrelated ids and soft-deleted references', async () => {
    const { db, sqlite, t } = makeDb();
    sqlite.prepare(`INSERT INTO attribute_values (id,entity_id,attribute_def_id,value_json,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .run('av-3', 'svc-1', 'ad-brands', JSON.stringify(['brand-OTHER']), t, t);
    sqlite.prepare(`INSERT INTO erp_engine_assembly_bom_brand_links (id,bom_id,engine_brand_id,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?)`)
      .run('bl-2', 'bom-1', 'brand-X', t, t, t);
    const res = await findAllIncomingReferences(db, 'brand-X');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.groups).toEqual([]);
  });
});

describe('resolveIncomingReferencesAndSoftDelete', () => {
  function seedRefs(sqlite: any, t: number, target: string) {
    sqlite.prepare(`INSERT INTO entities (id,type_id,created_at,updated_at) VALUES (?,?,?,?)`).run(target, 'et-svc', t, t);
    sqlite.prepare(`INSERT INTO attribute_values (id,entity_id,attribute_def_id,value_json,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .run('av-1', 'svc-1', 'ad-brands', JSON.stringify(['brand-Y', target]), t, t);
    sqlite.prepare(`INSERT INTO attribute_values (id,entity_id,attribute_def_id,value_json,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .run('av-2', 'con-1', 'ad-sections', JSON.stringify({ primary: { engineBrands: [{ engineBrandId: target, qty: 2 }, { engineBrandId: 'brand-Y' }], parts: [] }, addons: [] }), t, t);
    sqlite.prepare(`INSERT INTO erp_engine_assembly_bom_brand_links (id,bom_id,engine_brand_id,created_at,updated_at) VALUES (?,?,?,?,?)`)
      .run('bl-1', 'bom-1', target, t, t);
  }

  it('remove: prunes array EAV, drops contract row, soft-deletes BOM link and the target', async () => {
    const { db, sqlite, t } = makeDb();
    const target = 'brand-X';
    seedRefs(sqlite, t, target);
    const res = await resolveIncomingReferencesAndSoftDelete(db, target, { mode: 'remove' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.touched).toBe(3);
    expect(JSON.parse((sqlite.prepare(`SELECT value_json AS v FROM attribute_values WHERE id='av-1'`).get() as any).v)).toEqual(['brand-Y']);
    const sec = JSON.parse((sqlite.prepare(`SELECT value_json AS v FROM attribute_values WHERE id='av-2'`).get() as any).v);
    expect(sec.primary.engineBrands.map((x: any) => x.engineBrandId)).toEqual(['brand-Y']);
    expect((sqlite.prepare(`SELECT deleted_at AS d FROM erp_engine_assembly_bom_brand_links WHERE id='bl-1'`).get() as any).d).not.toBeNull();
    expect((sqlite.prepare(`SELECT deleted_at AS d FROM entities WHERE id=?`).get(target) as any).d).not.toBeNull();
  });

  it('replace: repoints every reference to the replacement id', async () => {
    const { db, sqlite, t } = makeDb();
    const target = 'brand-X';
    seedRefs(sqlite, t, target);
    const res = await resolveIncomingReferencesAndSoftDelete(db, target, { mode: 'replace', replacementId: 'brand-Z' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(JSON.parse((sqlite.prepare(`SELECT value_json AS v FROM attribute_values WHERE id='av-1'`).get() as any).v)).toEqual(['brand-Y', 'brand-Z']);
    const sec = JSON.parse((sqlite.prepare(`SELECT value_json AS v FROM attribute_values WHERE id='av-2'`).get() as any).v);
    expect(sec.primary.engineBrands.map((x: any) => x.engineBrandId)).toEqual(['brand-Z', 'brand-Y']);
    expect((sqlite.prepare(`SELECT engine_brand_id AS b FROM erp_engine_assembly_bom_brand_links WHERE id='bl-1'`).get() as any).b).toBe('brand-Z');
    expect((sqlite.prepare(`SELECT deleted_at AS d FROM entities WHERE id=?`).get(target) as any).d).not.toBeNull();
  });

  it('leave: soft-deletes the target but keeps all references intact', async () => {
    const { db, sqlite, t } = makeDb();
    const target = 'brand-X';
    seedRefs(sqlite, t, target);
    const res = await resolveIncomingReferencesAndSoftDelete(db, target, { mode: 'leave' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.touched).toBe(0);
    expect(JSON.parse((sqlite.prepare(`SELECT value_json AS v FROM attribute_values WHERE id='av-1'`).get() as any).v)).toEqual(['brand-Y', 'brand-X']);
    expect((sqlite.prepare(`SELECT deleted_at AS d FROM entities WHERE id=?`).get(target) as any).d).not.toBeNull();
  });
});
