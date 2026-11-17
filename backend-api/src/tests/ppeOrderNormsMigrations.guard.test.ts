/**
 * Сторож: миграции приказа о СИЗ и сид `ppeOrderNorms767.ts` — одно и то же.
 *
 * Сид — источник правды по приказным данным, а в базу их переносят миграции.
 * Если эти две картины разойдутся (переименование в сиде без миграции, миграция
 * с id, которого нет в сиде, забытый сдвиг порядка строк), то бланк выдачи
 * начнёт показывать одно, а сид — другое, и никто этого не заметит: тесты
 * сида читают сид, а не базу.
 *
 * Поэтому здесь сид сверяется с SQL миграций: каждая строка приказа из сида
 * должна появиться в одной из миграций, а строки, удалённые миграцией 0122
 * (приведение к ЕТН), — исчезнуть из сида.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  PPE_ORDER_BASE_POSITIONS,
  PPE_ORDER_NORM_SETS,
  PPE_ORDER_OCCUPATIONS,
  PPE_ORDER_SIZE_POSITIONS,
  PPE_ORDER_SPECS,
} from '../data/ppeOrderNorms767.js';

const drizzleDir = fileURLToPath(new URL('../../drizzle/', import.meta.url));

const MIGRATIONS = [
  '0118_ppe_order_norms_seed.sql',
  '0119_ppe_order_etn_extra.sql',
  '0120_ppe_local_norms.sql',
  '0121_ppe_earplug_norms.sql',
  '0122_ppe_etn_alignment.sql',
];

function readMigration(name: string): string {
  const path = join(drizzleDir, name);
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

/** Разбор строки VALUES: ('a', 'b', NULL) → ['a', 'b', null]. */
function splitTuple(line: string): (string | null)[] {
  const inner = line.trim().replace(/^\(/, '').replace(/\)[,;]?$/, '');
  const out: string[] = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === "'") {
      if (inStr && inner[i + 1] === "'") {
        cur += "''";
        i++;
        continue;
      }
      inStr = !inStr;
      cur += ch;
      continue;
    }
    if (ch === ',' && !inStr) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out.map((v) => {
    if (v === 'NULL') return null;
    if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
    return v;
  });
}

/** Строки INSERT INTO table (...) VALUES ... — как массив объектов «колонка → значение». */
function insertRows(sql: string, table: string): Array<Record<string, string | null>> {
  const start = sql.indexOf(`INSERT INTO ${table} (`);
  if (start < 0) return [];
  const columnsEnd = sql.indexOf(')', start);
  const columns = sql
    .slice(sql.indexOf('(', start) + 1, columnsEnd)
    .split(',')
    .map((c) => c.trim());
  const valuesStart = sql.indexOf('VALUES', columnsEnd);
  const valuesEnd = sql.indexOf('\n--> statement-breakpoint', valuesStart);
  const body = sql.slice(valuesStart + 'VALUES'.length, valuesEnd < 0 ? sql.length : valuesEnd);
  const rows: Array<Record<string, string | null>> = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('(')) continue;
    const values = splitTuple(trimmed);
    const row: Record<string, string | null> = {};
    columns.forEach((c, i) => {
      row[c] = values[i] ?? null;
    });
    rows.push(row);
  }
  return rows;
}

/** id-шники, помеченные на удаление (мягкое удаление — UPDATE с deleted_at). */
function softDeletedIds(sql: string, table: string): string[] {
  const ids: string[] = [];
  // Оператор за оператором: иначе захватились бы id из соседнего UPDATE.
  for (const statement of sql.split(';')) {
    if (!new RegExp(`UPDATE ${table}\\b`).test(statement)) continue;
    if (!/WHERE id IN \(/.test(statement)) continue;
    for (const id of statement.matchAll(/[0-9a-f]{8}-[0-9a-f-]{27}/g)) ids.push(id[0]);
  }
  return ids;
}

/** id-шники, которым миграция меняет порядок строк. */
function sortOrderUpdates(sql: string): Map<string, number> {
  const out = new Map<string, number>();
  const re = /UPDATE ppe_norm_line_specs SET sort_order = (\d+) WHERE id = '([0-9a-f-]{36})'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) out.set(m[2]!, Number(m[1]));
  return out;
}

const occById = new Map(PPE_ORDER_OCCUPATIONS.map((o) => [o.id, o]));
const occByCode = new Map(PPE_ORDER_OCCUPATIONS.map((o) => [o.code, o]));
const specById = new Map(PPE_ORDER_SPECS.map((s) => [s.id, s]));

describe('миграции приказа о СИЗ совпадают с сидом', () => {
  const m0122 = readMigration('0122_ppe_etn_alignment.sql');
  const all = MIGRATIONS.map(readMigration);

  it('все миграции приказа на месте', () => {
    for (const name of MIGRATIONS) {
      expect(readdirSync(drizzleDir)).toContain(name);
    }
  });

  it('каждая строка приказа сида заведена хотя бы одной миграцией', () => {
    const inMigrations = new Set<string>();
    for (const sql of all) {
      for (const row of insertRows(sql, 'ppe_norm_line_specs')) {
        if (row.id) inMigrations.add(row.id);
      }
    }
    const missing = PPE_ORDER_SPECS.filter((s) => !inMigrations.has(s.id)).map((s) => s.name);
    expect(missing).toEqual([]);
  });

  it('строки, удалённые приведением к ЕТН, в сиде не остались', () => {
    const removed = softDeletedIds(m0122, 'ppe_norm_line_specs');
    expect(removed.length).toBeGreaterThan(0);
    for (const id of removed) {
      expect(specById.has(id)).toBe(false);
    }
  });

  it('строки, удалённые миграцией, не остались и в наборах норм', () => {
    const removed = softDeletedIds(m0122, 'ppe_norm_line_specs');
    const lines = insertRows(m0122, 'ppe_norm_lines');
    for (const line of lines) {
      if (!line.spec_id) continue;
      expect(removed).not.toContain(line.spec_id);
    }
    // Строки наборов удалённых строк приказа — тоже помечаются на удаление.
    expect(m0122).toMatch(/UPDATE ppe_norm_lines\s+SET deleted_at/);
    expect(m0122).toMatch(/WHERE spec_id IN \([\s\S]*?f61ed101-a22d-586d-a4db-5f45ea8e2aaf/);
  });

  it('вставленные миграцией 0122 строки приказа совпадают с сидом', () => {
    const rows = insertRows(m0122, 'ppe_norm_line_specs');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const spec = specById.get(row.id!);
      expect(spec, `строка ${row.id} есть в сиде`).toBeTruthy();
      expect(spec!.name).toBe(row.name);
      expect(occByCode.get(spec!.occupationCode)?.id).toBe(row.occupation_id);
      expect(spec!.sourceKind).toBe(row.source_kind);
      expect(spec!.sourceLabel).toBe(row.source_label);
      expect(spec!.sourceRef).toBe(row.source_ref);
      expect(String(spec!.sortOrder)).toBe(String(row.sort_order));
    }
  });

  it('вставленные миграцией 0122 наборы норм совпадают с сидом', () => {
    const rows = insertRows(m0122, 'ppe_norm_sets');
    const setById = new Map(PPE_ORDER_NORM_SETS.map((s) => [s.id, s]));
    for (const row of rows) {
      const set = setById.get(row.id!);
      expect(set, `набор ${row.id} есть в сиде`).toBeTruthy();
      expect(set!.name).toBe(row.name);
      expect(set!.occupationCode).toBe(occById.get(row.occupation_id!)?.code);
      expect(set!.sourceKind).toBe(row.source_kind);
      expect(set!.sourceLabel).toBe(row.source_label);
    }
  });

  it('вставленная миграцией 0122 номенклатура совпадает с сидом', () => {
    const rows = insertRows(m0122, 'erp_nomenclature');
    expect(rows.length).toBeGreaterThan(0);
    const baseById = new Map(PPE_ORDER_BASE_POSITIONS.map((b) => [b.id, b]));
    const sizeById = new Map(PPE_ORDER_SIZE_POSITIONS.map((s) => [s.id, s]));
    for (const row of rows) {
      const base = baseById.get(row.id!);
      const size = sizeById.get(row.id!);
      expect(base ?? size, `номенклатура ${row.code} есть в сиде`).toBeTruthy();
      expect((base ?? size)!.name).toBe(row.name);
      expect((base ?? size)!.code).toBe(row.code);
      if (size) expect(size.parentId).toBe(row.parent_nomenclature_id);
    }
  });

  it('порядок строк приказа после правок совпадает с сидом', () => {
    const updates = sortOrderUpdates(m0122);
    expect(updates.size).toBeGreaterThan(0);
    for (const [id, sort] of updates) {
      const spec = specById.get(id);
      expect(spec, `строка ${id} есть в сиде`).toBeTruthy();
      expect(spec!.sortOrder).toBe(sort);
    }
  });

  it('название профессии 4581 в миграции — как в ЕТН, и наборы следуют за ним', () => {
    expect(m0122).toContain("'Слесарь-электрик по ремонту электрооборудования'");
    expect(m0122).toMatch(/UPDATE ppe_occupation_ref\s+SET post_title = 'Слесарь-электрик/);
    // Наборы норм профессии переименовываются тем же именем — иначе в бланке
    // и в карточке должность называется по-разному.
    const sets = PPE_ORDER_NORM_SETS.filter((s) => s.occupationCode === '4581');
    expect(sets.length).toBeGreaterThan(0);
    for (const set of sets) {
      expect(m0122).toContain(set.name);
    }
  });

  it('удаление строк приказа — мягкое (с тумбстоуном для зеркала СИЗ)', () => {
    expect(m0122).not.toMatch(/DELETE FROM ppe_norm_line_specs/);
    expect(m0122).not.toMatch(/DELETE FROM ppe_norm_lines/);
    expect(m0122).toMatch(/sync_status = 'pending'/);
  });

  it('миграция числится в журнале drizzle с ростом idx', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const entry = journal.entries.find((e) => e.tag === '0122_ppe_etn_alignment');
    expect(entry).toBeTruthy();
    const idxs = journal.entries.map((e) => e.idx);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
    expect(new Set(idxs).size).toBe(idxs.length);
  });
});
