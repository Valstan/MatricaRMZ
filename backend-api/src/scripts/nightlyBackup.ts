import 'dotenv/config';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';

import Database from 'better-sqlite3';

import { db, pool } from '../database/db.js';
import { attributeDefs, attributeValues, auditLog, entities, entityTypes, operations } from '../database/schema.js';
import { deletePath, ensureFolderDeep, listFolderAll, uploadFileStream } from '../services/yandexDisk.js';

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function localDateName(d: Date): string {
  // Local server date, format YYYY-MM-DD
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function requireEnv(name: string): string {
  const v = (process.env[name] ?? '').trim();
  if (!v) throw new Error(`${name} is not configured`);
  return v;
}

function nowMs() {
  return Date.now();
}

async function runPgDump(outPath: string) {
  const host = (process.env.PGHOST ?? 'localhost').trim();
  const port = String(process.env.PGPORT ?? '5432').trim();
  const database = (process.env.PGDATABASE ?? '').trim() || 'matricarmz';
  const user = (process.env.PGUSER ?? '').trim() || 'postgres';
  const password = (process.env.PGPASSWORD ?? '').trim();

  // We prefer explicit flags so it works without relying on ~/.pgpass.
  const args = [
    '--format=custom', // -Fc
    '--no-owner',
    '--no-privileges',
    '--host',
    host,
    '--port',
    port,
    '--username',
    user,
    '--file',
    outPath,
    database,
  ];

  await new Promise<void>((resolve, reject) => {
    const p = spawn('pg_dump', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(password ? { PGPASSWORD: password } : {}) },
    });

    let stderr = '';
    p.stderr.on('data', (d) => {
      stderr += String(d);
    });

    p.on('error', (e) => reject(e));
    p.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`pg_dump failed (code=${code}): ${stderr.trim() || 'no stderr'}`));
    });
  });
}

function createSnapshotSchema(sqlite: Database.Database) {
  // Data tables (match electron-app schema + migrations)
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS entity_types (
  id TEXT PRIMARY KEY NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  sync_status TEXT DEFAULT 'synced' NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS entity_types_code_uq ON entity_types (code);
CREATE INDEX IF NOT EXISTS entity_types_sync_status_idx ON entity_types (sync_status);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY NOT NULL,
  type_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  sync_status TEXT DEFAULT 'synced' NOT NULL
);
CREATE INDEX IF NOT EXISTS entities_sync_status_idx ON entities (sync_status);

CREATE TABLE IF NOT EXISTS attribute_defs (
  id TEXT PRIMARY KEY NOT NULL,
  entity_type_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  data_type TEXT NOT NULL,
  is_required INTEGER DEFAULT false NOT NULL,
  sort_order INTEGER DEFAULT 0 NOT NULL,
  meta_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  sync_status TEXT DEFAULT 'synced' NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS attribute_defs_type_code_uq ON attribute_defs (entity_type_id, code);
CREATE INDEX IF NOT EXISTS attribute_defs_sync_status_idx ON attribute_defs (sync_status);

CREATE TABLE IF NOT EXISTS attribute_values (
  id TEXT PRIMARY KEY NOT NULL,
  entity_id TEXT NOT NULL,
  attribute_def_id TEXT NOT NULL,
  value_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  sync_status TEXT DEFAULT 'synced' NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS attribute_values_entity_attr_uq ON attribute_values (entity_id, attribute_def_id);
CREATE INDEX IF NOT EXISTS attribute_values_sync_status_idx ON attribute_values (sync_status);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY NOT NULL,
  engine_entity_id TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  performed_at INTEGER,
  performed_by TEXT,
  meta_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  sync_status TEXT DEFAULT 'synced' NOT NULL
);
CREATE INDEX IF NOT EXISTS operations_sync_status_idx ON operations (sync_status);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_id TEXT,
  table_name TEXT,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  sync_status TEXT DEFAULT 'synced' NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_sync_status_idx ON audit_log (sync_status);

-- Keep for compatibility with client schema (not used in view-only snapshot)
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`);
}

async function buildSqliteSnapshot(outPath: string) {
  const sqlite = new Database(outPath);
  try {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = OFF');
    sqlite.pragma('synchronous = NORMAL');
    createSnapshotSchema(sqlite);

    const insertEntityTypes = sqlite.prepare(
      `INSERT INTO entity_types (id, code, name, created_at, updated_at, deleted_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEntities = sqlite.prepare(
      `INSERT INTO entities (id, type_id, created_at, updated_at, deleted_at, sync_status) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertAttrDefs = sqlite.prepare(
      `INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, is_required, sort_order, meta_json, created_at, updated_at, deleted_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAttrVals = sqlite.prepare(
      `INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at, deleted_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertOps = sqlite.prepare(
      `INSERT INTO operations (id, engine_entity_id, operation_type, status, note, performed_at, performed_by, meta_json, created_at, updated_at, deleted_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAudit = sqlite.prepare(
      `INSERT INTO audit_log (id, actor, action, entity_id, table_name, payload_json, created_at, updated_at, deleted_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const tx = sqlite.transaction((fn: () => void) => fn());

    // NOTE: For typical MatricaRMZ volumes, full select is acceptable.
    // If it grows, we can chunk by created_at or by server_seq later.
    const [tRows, eRows, dRows, vRows, oRows, aRows] = await Promise.all([
      db.select().from(entityTypes),
      db.select().from(entities),
      db.select().from(attributeDefs),
      db.select().from(attributeValues),
      db.select().from(operations),
      db.select().from(auditLog),
    ]);

    tx(() => {
      for (const r of tRows as any[]) {
        insertEntityTypes.run(
          String(r.id),
          String(r.code),
          String(r.name),
          Number(r.createdAt),
          Number(r.updatedAt),
          r.deletedAt == null ? null : Number(r.deletedAt),
          String(r.syncStatus ?? 'synced'),
        );
      }
      for (const r of eRows as any[]) {
        insertEntities.run(
          String(r.id),
          String(r.typeId),
          Number(r.createdAt),
          Number(r.updatedAt),
          r.deletedAt == null ? null : Number(r.deletedAt),
          String(r.syncStatus ?? 'synced'),
        );
      }
      for (const r of dRows as any[]) {
        insertAttrDefs.run(
          String(r.id),
          String(r.entityTypeId),
          String(r.code),
          String(r.name),
          String(r.dataType),
          r.isRequired ? 1 : 0,
          Number(r.sortOrder ?? 0),
          r.metaJson == null ? null : String(r.metaJson),
          Number(r.createdAt),
          Number(r.updatedAt),
          r.deletedAt == null ? null : Number(r.deletedAt),
          String(r.syncStatus ?? 'synced'),
        );
      }
      for (const r of vRows as any[]) {
        insertAttrVals.run(
          String(r.id),
          String(r.entityId),
          String(r.attributeDefId),
          r.valueJson == null ? null : String(r.valueJson),
          Number(r.createdAt),
          Number(r.updatedAt),
          r.deletedAt == null ? null : Number(r.deletedAt),
          String(r.syncStatus ?? 'synced'),
        );
      }
      for (const r of oRows as any[]) {
        insertOps.run(
          String(r.id),
          String(r.engineEntityId),
          String(r.operationType),
          String(r.status),
          r.note == null ? null : String(r.note),
          r.performedAt == null ? null : Number(r.performedAt),
          r.performedBy == null ? null : String(r.performedBy),
          r.metaJson == null ? null : String(r.metaJson),
          Number(r.createdAt),
          Number(r.updatedAt),
          r.deletedAt == null ? null : Number(r.deletedAt),
          String(r.syncStatus ?? 'synced'),
        );
      }
      for (const r of aRows as any[]) {
        insertAudit.run(
          String(r.id),
          String(r.actor),
          String(r.action),
          r.entityId == null ? null : String(r.entityId),
          r.tableName == null ? null : String(r.tableName),
          r.payloadJson == null ? null : String(r.payloadJson),
          Number(r.createdAt),
          Number(r.updatedAt),
          r.deletedAt == null ? null : Number(r.deletedAt),
          String(r.syncStatus ?? 'synced'),
        );
      }
    });

    // Checkpoint WAL into main DB so upload is a single .sqlite file.
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    sqlite.close();
  }
}

function parseBackupDateFromName(name: string): string | null {
  const m = String(name).match(/^(\d{4}-\d{2}-\d{2})\.(sqlite|dump)$/);
  return m?.[1] ?? null;
}

function dateNameToInt(name: string): number {
  // YYYY-MM-DD -> YYYYMMDD for easy compare
  return Number(name.replaceAll('-', ''));
}

async function applyRetention(args: { folderPath: string; keepDays: number; todayName: string }) {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - Math.max(0, args.keepDays - 1));
  const cutoffName = localDateName(cutoff);
  const cutoffInt = dateNameToInt(cutoffName);

  const items = await listFolderAll({ folderPath: args.folderPath, sort: '-modified', pageSize: 200, max: 5000 });
  for (const it of items) {
    if (it.type !== 'file') continue;
    const dn = parseBackupDateFromName(it.name);
    if (!dn) continue;
    if (dateNameToInt(dn) < cutoffInt) {
      // API expects /path, but list returns disk:/...; normalize to /...
      const p = String(it.path || '');
      const diskPath = p.startsWith('disk:') ? p.slice('disk:'.length) : p;
      await deletePath(diskPath).catch(() => {});
    }
  }
}

async function main() {
  const startedAt = nowMs();
  const todayName = localDateName(new Date());

  const baseYandexPath = requireEnv('YANDEX_DISK_BASE_PATH'); // e.g. /MatricaRMZ/releases
  const backupFolder = `${baseYandexPath.replace(/\/+$/, '')}/base_reserv`;

  mkdirSync(tmpdir(), { recursive: true });
  const tmpBase = join(tmpdir(), 'matricarmz_backups');
  mkdirSync(tmpBase, { recursive: true });

  const tmpDump = join(tmpBase, `${todayName}.dump`);
  const tmpSqlite = join(tmpBase, `${todayName}.sqlite`);

  console.log(`[nightlyBackup] start date=${todayName} folder=${backupFolder}`);

  try {
    await ensureFolderDeep(backupFolder);

    console.log(`[nightlyBackup] pg_dump -> ${tmpDump}`);
    await runPgDump(tmpDump);

    console.log(`[nightlyBackup] sqlite snapshot -> ${tmpSqlite}`);
    await buildSqliteSnapshot(tmpSqlite);

    console.log(`[nightlyBackup] upload dump`);
    await uploadFileStream({ diskPath: `${backupFolder}/${todayName}.dump`, localFilePath: tmpDump, mime: 'application/octet-stream' });

    console.log(`[nightlyBackup] upload sqlite`);
    await uploadFileStream({
      diskPath: `${backupFolder}/${todayName}.sqlite`,
      localFilePath: tmpSqlite,
      mime: 'application/x-sqlite3',
    });

    console.log(`[nightlyBackup] retention keepDays=10`);
    await applyRetention({ folderPath: backupFolder, keepDays: 10, todayName });

    console.log(`[nightlyBackup] done in ${nowMs() - startedAt}ms`);
  } finally {
    await unlink(tmpDump).catch(() => {});
    await unlink(tmpSqlite).catch(() => {});
    await pool.end().catch(() => {});
  }
}

void main().catch((e) => {
  console.error(`[nightlyBackup] failed: ${String(e)}`);
  process.exitCode = 1;
});


