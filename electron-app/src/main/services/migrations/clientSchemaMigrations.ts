import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { getSqliteHandle } from '../../database/db.js';
import { SettingsKey, settingsGetNumber, settingsGetString, settingsSetNumber, settingsSetString } from '../settingsStore.js';

export type SyncSchemaColumn = {
  name: string;
  notNull: boolean;
  dataType?: string | null;
  default?: string | null;
};

export type SyncSchemaForeignKey = {
  column: string;
  refTable: string;
  refColumn: string;
  onUpdate?: string | null;
  onDelete?: string | null;
};

export type SyncSchemaUniqueConstraint = {
  columns: string[];
  isPrimary?: boolean;
};

export type SyncSchemaTable = {
  columns: SyncSchemaColumn[];
  foreignKeys: SyncSchemaForeignKey[];
  uniqueConstraints?: SyncSchemaUniqueConstraint[];
};

export type SyncSchemaSnapshot = {
  generatedAt: number;
  tables: Record<string, SyncSchemaTable>;
};

type Migration = {
  from: number;
  to: number;
  name: string;
  up: (db: BetterSQLite3Database, sqlite: Database.Database) => Promise<void>;
};

export const CURRENT_CLIENT_SCHEMA_VERSION = 3;

const MIGRATIONS: Migration[] = [
  {
    from: 1,
    to: 2,
    name: 'baseline no-op migration',
    up: async () => {
      // Intentionally empty. Ensures automated migration pipeline is exercised.
    },
  },
  {
    from: 2,
    to: 3,
    name: 'warehouse schema tables and indexes',
    up: async (_db, sqlite) => {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS erp_nomenclature (
          id text PRIMARY KEY NOT NULL,
          code text NOT NULL,
          name text NOT NULL,
          item_type text NOT NULL DEFAULT 'material',
          group_id text,
          unit_id text,
          barcode text,
          min_stock integer,
          max_stock integer,
          default_warehouse_id text,
          spec_json text,
          is_active integer NOT NULL DEFAULT 1,
          created_at integer NOT NULL,
          updated_at integer NOT NULL,
          deleted_at integer
        );
        CREATE UNIQUE INDEX IF NOT EXISTS erp_nomenclature_code_uq ON erp_nomenclature(code);
        CREATE INDEX IF NOT EXISTS erp_nomenclature_item_type_idx ON erp_nomenclature(item_type);
        CREATE INDEX IF NOT EXISTS erp_nomenclature_group_idx ON erp_nomenclature(group_id);
        CREATE INDEX IF NOT EXISTS erp_nomenclature_name_idx ON erp_nomenclature(name);
      `);

      const stockColumns = sqlite.prepare(`PRAGMA table_info('erp_reg_stock_balance')`).all() as Array<{
        name: string;
        notnull: number;
      }>;
      const partCardColumn = stockColumns.find((c) => c.name === 'part_card_id');
      const hasNomenclatureId = stockColumns.some((c) => c.name === 'nomenclature_id');
      const hasReservedQty = stockColumns.some((c) => c.name === 'reserved_qty');
      const mustRebuildStockBalance = !hasNomenclatureId || !hasReservedQty || Number(partCardColumn?.notnull ?? 0) === 1;

      if (mustRebuildStockBalance) {
        const selectNomenclatureExpr = hasNomenclatureId ? 'nomenclature_id' : 'NULL';
        const selectReservedExpr = hasReservedQty ? 'COALESCE(reserved_qty, 0)' : '0';
        sqlite.exec(`PRAGMA foreign_keys=OFF;`);
        sqlite.exec(`
          CREATE TABLE IF NOT EXISTS __erp_reg_stock_balance_new (
            id text PRIMARY KEY NOT NULL,
            nomenclature_id text,
            part_card_id text,
            warehouse_id text NOT NULL DEFAULT 'default',
            qty integer NOT NULL DEFAULT 0,
            reserved_qty integer NOT NULL DEFAULT 0,
            updated_at integer NOT NULL
          );
        `);
        sqlite.exec(`
          INSERT INTO __erp_reg_stock_balance_new (id, nomenclature_id, part_card_id, warehouse_id, qty, reserved_qty, updated_at)
          SELECT id, ${selectNomenclatureExpr}, part_card_id, warehouse_id, qty, ${selectReservedExpr}, updated_at
          FROM erp_reg_stock_balance;
        `);
        sqlite.exec(`DROP TABLE erp_reg_stock_balance;`);
        sqlite.exec(`ALTER TABLE __erp_reg_stock_balance_new RENAME TO erp_reg_stock_balance;`);
        sqlite.exec(`PRAGMA foreign_keys=ON;`);
      }
      sqlite.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS erp_reg_stock_balance_part_warehouse_uq
          ON erp_reg_stock_balance(part_card_id, warehouse_id);
      `);
      sqlite.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS erp_reg_stock_balance_nomenclature_warehouse_uq
          ON erp_reg_stock_balance(nomenclature_id, warehouse_id);
      `);

      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS erp_reg_stock_movements (
          id text PRIMARY KEY NOT NULL,
          nomenclature_id text NOT NULL,
          warehouse_id text NOT NULL DEFAULT 'default',
          document_header_id text,
          movement_type text NOT NULL,
          qty integer NOT NULL DEFAULT 0,
          direction text NOT NULL,
          counterparty_id text,
          reason text,
          performed_at integer NOT NULL,
          performed_by text,
          created_at integer NOT NULL
        );
        CREATE INDEX IF NOT EXISTS erp_reg_stock_movements_nomenclature_warehouse_idx
          ON erp_reg_stock_movements(nomenclature_id, warehouse_id);
        CREATE INDEX IF NOT EXISTS erp_reg_stock_movements_header_idx
          ON erp_reg_stock_movements(document_header_id);
        CREATE INDEX IF NOT EXISTS erp_reg_stock_movements_performed_at_idx
          ON erp_reg_stock_movements(performed_at);
      `);
    },
  },
];

function normalizeSchema(snapshot: SyncSchemaSnapshot) {
  const tables: Record<string, SyncSchemaTable> = {};
  const tableNames = Object.keys(snapshot.tables || {}).sort((a, b) => a.localeCompare(b));
  for (const table of tableNames) {
    const info = snapshot.tables[table];
    const columns = (info?.columns ?? [])
      .map((c) => ({
        name: String(c.name),
        notNull: !!c.notNull,
        dataType: c.dataType ?? null,
        default: c.default ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const foreignKeys = (info?.foreignKeys ?? [])
      .map((fk) => ({
        column: String(fk.column),
        refTable: String(fk.refTable),
        refColumn: String(fk.refColumn),
        onUpdate: fk.onUpdate ?? null,
        onDelete: fk.onDelete ?? null,
      }))
      .sort((a, b) => {
        const ak = `${a.column}:${a.refTable}:${a.refColumn}`;
        const bk = `${b.column}:${b.refTable}:${b.refColumn}`;
        return ak.localeCompare(bk);
      });
    const uniqueConstraints = (info?.uniqueConstraints ?? [])
      .map((uq) => ({
        columns: Array.isArray(uq.columns) ? uq.columns.map(String).sort() : [],
        isPrimary: !!uq.isPrimary,
      }))
      .filter((uq) => uq.columns.length > 0)
      .sort((a, b) => {
        const ak = `${a.isPrimary ? 1 : 0}:${a.columns.join(',')}`;
        const bk = `${b.isPrimary ? 1 : 0}:${b.columns.join(',')}`;
        return ak.localeCompare(bk);
      });
    tables[table] = { columns, foreignKeys, uniqueConstraints };
  }
  return { tables };
}

export function hashServerSchema(snapshot: SyncSchemaSnapshot): string {
  const normalized = normalizeSchema(snapshot);
  const raw = JSON.stringify(normalized);
  return createHash('sha256').update(raw).digest('hex');
}

function buildMigrationChain(fromVersion: number, toVersion: number): Migration[] | null {
  if (fromVersion === toVersion) return [];
  const chain: Migration[] = [];
  let current = fromVersion;
  for (let i = 0; i < 1000 && current < toVersion; i += 1) {
    const next = MIGRATIONS.find((m) => m.from === current);
    if (!next) return null;
    chain.push(next);
    current = next.to;
  }
  return current === toVersion ? chain : null;
}

export async function ensureClientSchemaCompatible(
  db: BetterSQLite3Database,
  serverSchema: SyncSchemaSnapshot | null,
  opts?: { log?: (message: string) => void },
): Promise<{ action: 'ok' | 'migrated' | 'rebuild'; reason?: string; serverHash?: string | null }> {
  const log = opts?.log ?? (() => {});
  const storedVersion = await settingsGetNumber(db, SettingsKey.ClientSchemaVersion, 0);
  const storedHash = await settingsGetString(db, SettingsKey.ServerSchemaHash);
  const serverHash = serverSchema ? hashServerSchema(serverSchema) : null;

  if (storedVersion === 0) {
    await settingsSetNumber(db, SettingsKey.ClientSchemaVersion, CURRENT_CLIENT_SCHEMA_VERSION);
    if (serverHash) await settingsSetString(db, SettingsKey.ServerSchemaHash, serverHash);
    return { action: 'ok', reason: 'baseline', serverHash };
  }

  if (storedVersion > CURRENT_CLIENT_SCHEMA_VERSION) {
    return { action: 'rebuild', reason: 'client schema downgrade detected', serverHash };
  }

  if (storedVersion < CURRENT_CLIENT_SCHEMA_VERSION) {
    const chain = buildMigrationChain(storedVersion, CURRENT_CLIENT_SCHEMA_VERSION);
    if (!chain) {
      return { action: 'rebuild', reason: `missing migrations ${storedVersion} -> ${CURRENT_CLIENT_SCHEMA_VERSION}`, serverHash };
    }
    const sqlite = getSqliteHandle();
    if (!sqlite) return { action: 'rebuild', reason: 'sqlite handle unavailable', serverHash };
    try {
      for (const m of chain) {
        log(`schema migration ${m.from} -> ${m.to}: ${m.name}`);
        await m.up(db, sqlite);
      }
      await settingsSetNumber(db, SettingsKey.ClientSchemaVersion, CURRENT_CLIENT_SCHEMA_VERSION);
      if (serverHash) await settingsSetString(db, SettingsKey.ServerSchemaHash, serverHash);
      return { action: 'migrated', reason: `migrated ${storedVersion} -> ${CURRENT_CLIENT_SCHEMA_VERSION}`, serverHash };
    } catch (e) {
      return { action: 'rebuild', reason: `migration failed: ${String(e)}`, serverHash };
    }
  }

  if (serverHash && storedHash && serverHash !== storedHash) {
    return { action: 'rebuild', reason: 'server schema hash mismatch', serverHash };
  }

  if (serverHash && serverHash !== storedHash) {
    await settingsSetString(db, SettingsKey.ServerSchemaHash, serverHash);
  }

  return { action: 'ok', reason: 'compatible', serverHash };
}
