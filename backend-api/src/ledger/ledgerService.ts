import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, createSign, randomBytes } from 'node:crypto';
import { LedgerStore, type LedgerSignedTx, type LedgerTxPayload, type LedgerTableName } from '@matricarmz/ledger';
import { generateLedgerKeyPair } from '@matricarmz/ledger';
import { SyncTableName, SyncTableRegistry } from '@matricarmz/shared';
import { sql } from 'drizzle-orm';

import { db } from '../database/db.js';
import {
  attributeDefs,
  attributeValues,
  auditLog,
  chatMessages,
  chatReads,
  entities,
  entityTypes,
  notes,
  noteShares,
  operations,
  userPresence,
} from '../database/schema.js';

const DEFAULT_LEDGER_DIR = resolve(process.cwd(), 'ledger');
const KEY_FILE = 'server-key.json';
const DATA_KEY_FILE = 'data-key.json';
const BOOTSTRAP_FILE = 'bootstrap.json';
const SIGNED_CHECKPOINT_FILE = 'checkpoint.signed.json';

let store: LedgerStore | null = null;
let serverKeys: { publicKeyPem: string; privateKeyPem: string } | null = null;
let cachedLedgerDir: string | null = null;
let dataKey: Buffer | null = null;

function loadOrCreateServerKeys(ledgerDir: string) {
  if (serverKeys) return serverKeys;
  const keyPath = join(ledgerDir, KEY_FILE);
  if (existsSync(keyPath)) {
    serverKeys = JSON.parse(readFileSync(keyPath, 'utf8')) as { publicKeyPem: string; privateKeyPem: string };
    return serverKeys;
  }
  const keys = generateLedgerKeyPair();
  writeFileSync(keyPath, JSON.stringify(keys, null, 2));
  serverKeys = keys;
  return keys;
}

function loadOrCreateDataKey(ledgerDir: string): Buffer {
  if (dataKey) return dataKey;
  if (process.env.MATRICA_LEDGER_DATA_KEY) {
    dataKey = Buffer.from(process.env.MATRICA_LEDGER_DATA_KEY, 'base64');
    return dataKey;
  }
  const keyPath = join(ledgerDir, DATA_KEY_FILE);
  if (existsSync(keyPath)) {
    const saved = JSON.parse(readFileSync(keyPath, 'utf8')) as { keyBase64: string };
    dataKey = Buffer.from(saved.keyBase64, 'base64');
    return dataKey;
  }
  const key = randomBytes(32);
  writeFileSync(keyPath, JSON.stringify({ keyBase64: key.toString('base64') }, null, 2));
  dataKey = key;
  return key;
}

/** Convert DB row (camelCase) -> DTO row (snake_case) using the shared registry. */
function toSyncRow(table: SyncTableName, row: any): any {
  return SyncTableRegistry.toSyncRow(table, row as Record<string, unknown>);
}

function encryptText(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptText(value: string, key: Buffer): string {
  if (!value.startsWith('enc:v1:')) return value;
  const parts = value.split(':');
  if (parts.length !== 5) return value;
  const ivRaw = parts[2];
  const tagRaw = parts[3];
  const dataRaw = parts[4];
  if (!ivRaw || !tagRaw || !dataRaw) return value;
  const iv = Buffer.from(ivRaw, 'base64');
  const tag = Buffer.from(tagRaw, 'base64');
  const data = Buffer.from(dataRaw, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

function encryptRowSensitive(row: Record<string, unknown>, key: Buffer) {
  const next = { ...row };
  for (const field of ['meta_json', 'payload_json']) {
    const val = next[field];
    if (typeof val === 'string' && val.length > 0) {
      if (val.startsWith('enc:e2e:v1:')) continue;
      next[field] = encryptText(val, key);
    }
  }
  return next;
}

function decryptRowSensitive(row: Record<string, unknown>, key: Buffer) {
  const next = { ...row };
  for (const field of ['meta_json', 'payload_json']) {
    const val = next[field];
    if (typeof val === 'string' && val.startsWith('enc:v1:')) {
      next[field] = decryptText(val, key);
    }
  }
  return next;
}

function resolveLedgerDir(): string {
  if (cachedLedgerDir) return cachedLedgerDir;
  cachedLedgerDir = process.env.MATRICA_LEDGER_DIR ? resolve(process.env.MATRICA_LEDGER_DIR) : DEFAULT_LEDGER_DIR;
  return cachedLedgerDir;
}

export function getLedgerStore(): LedgerStore {
  if (store) return store;
  const ledgerDir = resolveLedgerDir();
  mkdirSync(ledgerDir, { recursive: true });
  store = new LedgerStore(ledgerDir);
  loadOrCreateServerKeys(ledgerDir);
  return store;
}

export function signAndAppendDetailed(
  payloads: LedgerTxPayload[],
): { applied: number; lastSeq: number; blockHeight: number; signed: LedgerSignedTx[] } {
  const ledger = getLedgerStore();
  const ledgerDir = resolveLedgerDir();
  const keys = loadOrCreateServerKeys(ledgerDir);
  const key = loadOrCreateDataKey(ledgerDir);
  const encryptedPayloads = payloads.map((p) => (p.row ? { ...p, row: encryptRowSensitive(p.row, key) } : p));
  const signed = ledger.signTxs(encryptedPayloads, keys.privateKeyPem, keys.publicKeyPem);
  const block = ledger.appendBlock(signed);
  const lastSeq = signed.at(-1)?.seq ?? ledger.loadIndex().lastSeq;
  const checkpointEvery = Math.max(1, Number(process.env.MATRICA_LEDGER_SIGNED_CHECKPOINT_EVERY_BLOCKS ?? 100));
  if (block.height % checkpointEvery === 0) {
    void createSignedCheckpoint().catch(() => {});
  }
  return { applied: signed.length, lastSeq, blockHeight: block.height, signed };
}

export function signAndAppend(payloads: LedgerTxPayload[]): { applied: number; lastSeq: number; blockHeight: number } {
  const result = signAndAppendDetailed(payloads);
  return { applied: result.applied, lastSeq: result.lastSeq, blockHeight: result.blockHeight };
}

export function listChangesSince(
  since: number,
  limit: number,
): { hasMore: boolean; lastSeq: number; changes: Array<{ table: LedgerTableName; row_id: string; op: 'upsert' | 'delete'; payload_json: string; server_seq: number }> } {
  const ledger = getLedgerStore();
  const safeLimit = Math.max(1, Math.min(20000, Number(limit) || 5000));
  const txs = ledger.listTxsSince(since, safeLimit + 1);
  const page = txs.slice(0, safeLimit);
  const hasMore = txs.length > safeLimit;
  const lastSeq = page.at(-1)?.seq ?? since;
  const key = loadOrCreateDataKey(resolveLedgerDir());
  const changes = page.map((tx) => {
    const op: 'upsert' | 'delete' = tx.type === 'delete' ? 'delete' : 'upsert';
    const payload =
      (tx.row ? decryptRowSensitive(tx.row, key) : undefined) ??
      (tx.row_id
        ? {
            id: tx.row_id,
            deleted_at: tx.type === 'delete' ? tx.ts : null,
            updated_at: tx.ts,
          }
        : {});
    return {
      table: tx.table,
      row_id: String((payload as any)?.id ?? tx.row_id ?? ''),
      op,
      payload_json: JSON.stringify(payload),
      server_seq: tx.seq,
    };
  });
  return { hasMore, lastSeq, changes };
}

export function listBlocksSince(height: number, limit: number) {
  const ledger = getLedgerStore();
  const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 200));
  return ledger.listBlocksSince(height, safeLimit);
}

export function getLedgerLastSeq(): number {
  const ledger = getLedgerStore();
  return ledger.loadIndex().lastSeq ?? 0;
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function signCheckpointPayload(payload: Record<string, unknown>, privateKeyPem: string) {
  const canonical = stableStringify(payload);
  const signer = createSign('RSA-SHA256');
  signer.update(canonical);
  signer.end();
  const signature = signer.sign(privateKeyPem, 'base64');
  const digest = createHash('sha256').update(canonical).digest('hex');
  return { canonical, signature, digest };
}

export async function createSignedCheckpoint() {
  const ledgerDir = resolveLedgerDir();
  const ledger = getLedgerStore();
  const keys = loadOrCreateServerKeys(ledgerDir);
  const checkpoint = ledger.buildCheckpoint();
  const payload = {
    version: 1,
    createdAt: Date.now(),
    ledgerDir,
    checkpoint,
  };
  const signed = signCheckpointPayload(payload, keys.privateKeyPem);
  const row = {
    ...payload,
    signature: signed.signature,
    digest: signed.digest,
    publicKeyPem: keys.publicKeyPem,
  };
  writeFileSync(join(ledgerDir, SIGNED_CHECKPOINT_FILE), JSON.stringify(row, null, 2));
  return row;
}

export function getSignedCheckpoint() {
  const ledgerDir = resolveLedgerDir();
  const path = join(ledgerDir, SIGNED_CHECKPOINT_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function ensureLedgerBootstrap(): Promise<{ ran: boolean; reason: string }> {
  const ledgerDir = resolveLedgerDir();
  const markerPath = join(ledgerDir, BOOTSTRAP_FILE);
  if (existsSync(markerPath)) return { ran: false, reason: 'marker exists' };

  const ledger = getLedgerStore();
  const state = ledger.loadState();
  const ledgerCounts = {
    entityTypes: Object.keys(state.tables[SyncTableName.EntityTypes] ?? {}).length,
    entities: Object.keys(state.tables[SyncTableName.Entities] ?? {}).length,
    attributeDefs: Object.keys(state.tables[SyncTableName.AttributeDefs] ?? {}).length,
    attributeValues: Object.keys(state.tables[SyncTableName.AttributeValues] ?? {}).length,
  };

  const dbCounts = {
    entityTypes: Number((await db.select({ count: sql<number>`count(*)` }).from(entityTypes).limit(1))[0]?.count ?? 0),
    entities: Number((await db.select({ count: sql<number>`count(*)` }).from(entities).limit(1))[0]?.count ?? 0),
    attributeDefs: Number((await db.select({ count: sql<number>`count(*)` }).from(attributeDefs).limit(1))[0]?.count ?? 0),
    attributeValues: Number((await db.select({ count: sql<number>`count(*)` }).from(attributeValues).limit(1))[0]?.count ?? 0),
  };

  const needsBootstrap =
    ledgerCounts.entityTypes < dbCounts.entityTypes ||
    ledgerCounts.entities < dbCounts.entities ||
    ledgerCounts.attributeDefs < dbCounts.attributeDefs ||
    ledgerCounts.attributeValues < dbCounts.attributeValues;

  if (!needsBootstrap) {
    writeFileSync(markerPath, JSON.stringify({ at: Date.now(), reason: 'counts-ok', ledgerCounts, dbCounts }, null, 2));
    return { ran: false, reason: 'counts ok' };
  }

  const actor = { userId: 'system', username: 'system', role: 'system' };
  const CHUNK_SIZE = 1000;
  const importTable = async (tableName: SyncTableName, rows: any[]) => {
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      const payloads: LedgerTxPayload[] = chunk.map((row) => {
        const syncRow = toSyncRow(tableName, row);
        const deletedAt = syncRow.deleted_at ?? null;
        const ts = Number(syncRow.updated_at ?? Date.now());
        return {
          type: deletedAt ? 'delete' : 'upsert',
          table: tableName,
          row: syncRow,
          row_id: syncRow.id,
          actor,
          ts,
        };
      });
      signAndAppend(payloads);
    }
  };

  await importTable(SyncTableName.EntityTypes, await db.select().from(entityTypes));
  await importTable(SyncTableName.Entities, await db.select().from(entities));
  await importTable(SyncTableName.AttributeDefs, await db.select().from(attributeDefs));
  await importTable(SyncTableName.AttributeValues, await db.select().from(attributeValues));
  await importTable(SyncTableName.Operations, await db.select().from(operations));
  await importTable(SyncTableName.AuditLog, await db.select().from(auditLog));
  await importTable(SyncTableName.ChatMessages, await db.select().from(chatMessages));
  await importTable(SyncTableName.ChatReads, await db.select().from(chatReads));
  await importTable(SyncTableName.UserPresence, await db.select().from(userPresence));
  await importTable(SyncTableName.Notes, await db.select().from(notes));
  await importTable(SyncTableName.NoteShares, await db.select().from(noteShares));

  writeFileSync(markerPath, JSON.stringify({ at: Date.now(), reason: 'bootstrap', ledgerCounts, dbCounts }, null, 2));
  return { ran: true, reason: 'bootstrap complete' };
}

export function queryState(
  table: LedgerTableName,
  opts: {
    id?: string;
    filter?: Record<string, string>;
    orFilter?: Array<Record<string, string>>;
    limit?: number;
    offset?: number;
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
    includeDeleted?: boolean;
    dateField?: string;
    dateFrom?: number;
    dateTo?: number;
    likeField?: string;
    like?: string;
    regexField?: string;
    regex?: string;
    regexFlags?: string;
    cursorValue?: string | number;
    cursorId?: string;
  },
) {
  const ledger = getLedgerStore();
  const state = ledger.loadState();
  const rows = state.tables[table] ?? {};
  const key = loadOrCreateDataKey(resolveLedgerDir());
  const list = Object.values(rows);
  let filtered = list.map((row) => decryptRowSensitive(row as Record<string, unknown>, key));
  if (opts.id) {
    const row = rows[opts.id];
    return row ? [decryptRowSensitive(row as Record<string, unknown>, key)] : [];
  }
  if (opts.filter) {
    filtered = filtered.filter((row) =>
      Object.entries(opts.filter ?? {}).every(([k, v]) => String((row as any)?.[k] ?? '') === String(v)),
    );
  }
  if (opts.orFilter && opts.orFilter.length > 0) {
    const clauses = opts.orFilter.filter((c) => c && Object.keys(c).length > 0);
    if (clauses.length > 0) {
      filtered = filtered.filter((row) =>
        clauses.some((clause) =>
          Object.entries(clause).every(([k, v]) => String((row as any)?.[k] ?? '') === String(v)),
        ),
      );
    }
  }
  if (opts.like && opts.likeField) {
    const needle = String(opts.like).toLowerCase();
    const field = String(opts.likeField);
    filtered = filtered.filter((row) => String((row as any)?.[field] ?? '').toLowerCase().includes(needle));
  }
  if (opts.regex && opts.regexField) {
    try {
      const field = String(opts.regexField);
      const flags = opts.regexFlags ? String(opts.regexFlags) : 'i';
      const re = new RegExp(String(opts.regex), flags);
      filtered = filtered.filter((row) => re.test(String((row as any)?.[field] ?? '')));
    } catch {
      // ignore invalid regex
    }
  }
  if (opts.dateFrom != null || opts.dateTo != null) {
    const field = opts.dateField ?? 'created_at';
    const from = opts.dateFrom != null ? Number(opts.dateFrom) : null;
    const to = opts.dateTo != null ? Number(opts.dateTo) : null;
    filtered = filtered.filter((row) => {
      const value = Number((row as any)?.[field]);
      if (!Number.isFinite(value)) return false;
      if (from != null && value < from) return false;
      if (to != null && value > to) return false;
      return true;
    });
  }
  if (!opts.includeDeleted) {
    filtered = filtered.filter((row) => (row as any)?.deleted_at == null);
  }
  if (opts.sortBy) {
    const dir = opts.sortDir === 'asc' ? 1 : -1;
    const keyName = opts.sortBy;
    filtered = filtered.sort((a, b) => {
      const av = (a as any)?.[keyName];
      const bv = (b as any)?.[keyName];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av === bv) return 0;
      return av > bv ? dir : -dir;
    });
  }
  if (opts.cursorValue != null && opts.sortBy) {
    const dir = opts.sortDir === 'asc' ? 1 : -1;
    const cursorVal = opts.cursorValue;
    const cursorId = opts.cursorId ? String(opts.cursorId) : null;
    const keyName = opts.sortBy;
    filtered = filtered.filter((row) => {
      const value = (row as any)?.[keyName];
      const rowId = String((row as any)?.id ?? '');
      if (value == null) return false;
      if (value === cursorVal) {
        return cursorId ? (dir === 1 ? rowId > cursorId : rowId < cursorId) : false;
      }
      return dir === 1 ? value > cursorVal : value < cursorVal;
    });
  }
  const offset = Math.max(0, Number(opts.offset ?? 0));
  const limit = Math.max(1, Math.min(20000, Number(opts.limit ?? 5000)));
  return filtered.slice(offset, offset + limit);
}
