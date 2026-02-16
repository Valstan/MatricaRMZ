import { sql } from 'drizzle-orm';
import { SyncTableName } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { ledgerTxIndex } from '../database/schema.js';
import { getLedgerLastSeq, queryState } from '../ledger/ledgerService.js';

type TableKey = 'entity_types' | 'entities' | 'attribute_defs' | 'attribute_values' | 'operations';

type TableHealth = {
  ledgerCount: number;
  projectionCount: number;
  diffAbs: number;
  diffRatio: number;
};

const TABLES: Array<{ key: TableKey; syncName: SyncTableName; projectionTable: string }> = [
  { key: 'entity_types', syncName: SyncTableName.EntityTypes, projectionTable: 'entity_types' },
  { key: 'entities', syncName: SyncTableName.Entities, projectionTable: 'entities' },
  { key: 'attribute_defs', syncName: SyncTableName.AttributeDefs, projectionTable: 'attribute_defs' },
  { key: 'attribute_values', syncName: SyncTableName.AttributeValues, projectionTable: 'attribute_values' },
  { key: 'operations', syncName: SyncTableName.Operations, projectionTable: 'operations' },
];

function toNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function computeRatio(a: number, b: number) {
  const base = Math.max(1, a);
  return Math.abs(a - b) / base;
}

function computeStatus(args: {
  ledgerToIndexLag: number;
  indexToProjectionLag: number;
  maxTableRatio: number;
}) {
  const { ledgerToIndexLag, indexToProjectionLag, maxTableRatio } = args;
  if (ledgerToIndexLag > 10_000 || indexToProjectionLag > 10_000 || maxTableRatio > 0.15) return 'critical';
  if (ledgerToIndexLag > 2_000 || indexToProjectionLag > 2_000 || maxTableRatio > 0.05) return 'warn';
  return 'ok';
}

function reasons(args: {
  ledgerToIndexLag: number;
  indexToProjectionLag: number;
  worstTable: { key: string; diffRatio: number } | null;
}) {
  const out: string[] = [];
  if (args.ledgerToIndexLag > 0) out.push(`ledger_tx_index lag=${args.ledgerToIndexLag}`);
  if (args.indexToProjectionLag > 0) out.push(`projection lag by last_server_seq=${args.indexToProjectionLag}`);
  if (args.worstTable && args.worstTable.diffRatio > 0) {
    out.push(`table drift ${args.worstTable.key} ratio=${args.worstTable.diffRatio.toFixed(4)}`);
  }
  return out;
}

function countLedgerRows(syncTable: SyncTableName): number {
  const pageSize = 5000;
  let total = 0;
  let cursorValue: string | number | undefined;
  let cursorId: string | undefined;
  for (let i = 0; i < 20_000; i += 1) {
    const rows = queryState(syncTable as any, {
      includeDeleted: false,
      sortBy: 'id',
      sortDir: 'asc',
      limit: pageSize,
      ...(cursorValue != null ? { cursorValue } : {}),
      ...(cursorId ? { cursorId } : {}),
    }) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows) || rows.length === 0) break;
    total += rows.length;
    if (rows.length < pageSize) break;
    const last = rows[rows.length - 1];
    const nextId = String(last?.id ?? '');
    if (!nextId) break;
    cursorValue = nextId;
    cursorId = nextId;
  }
  return total;
}

function loadLedgerRows(syncTable: SyncTableName): Array<Record<string, unknown>> {
  const pageSize = 5000;
  const out: Array<Record<string, unknown>> = [];
  let cursorValue: string | number | undefined;
  let cursorId: string | undefined;
  for (let i = 0; i < 20_000; i += 1) {
    const rows = queryState(syncTable as any, {
      includeDeleted: false,
      sortBy: 'id',
      sortDir: 'asc',
      limit: pageSize,
      ...(cursorValue != null ? { cursorValue } : {}),
      ...(cursorId ? { cursorId } : {}),
    }) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows) || rows.length === 0) break;
    out.push(...rows);
    if (rows.length < pageSize) break;
    const last = rows[rows.length - 1];
    const nextId = String(last?.id ?? '');
    if (!nextId) break;
    cursorValue = nextId;
    cursorId = nextId;
  }
  return out;
}

function isBulkEntityTypeRow(row: Record<string, unknown>) {
  const code = String(row?.code ?? '');
  const name = String(row?.name ?? '');
  return code.startsWith('t_bulk_') || name.startsWith('Type Bulk ');
}

function rowUpdatedAt(row: Record<string, unknown>) {
  return toNumber(row.updated_at ?? row.created_at ?? 0);
}

async function countProjectionRows(table: string): Promise<number> {
  const q = await db.execute(sql.raw(`select count(*)::bigint as cnt from ${table} where deleted_at is null`));
  return toNumber((q.rows?.[0] as any)?.cnt ?? 0);
}

async function maxProjectionSeq(): Promise<number> {
  const chunks = await Promise.all(
    TABLES.map((t) => db.execute(sql.raw(`select coalesce(max(last_server_seq), 0)::bigint as seq from ${t.projectionTable}`))),
  );
  let max = 0;
  for (const r of chunks) {
    const n = toNumber((r.rows?.[0] as any)?.seq ?? 0);
    if (n > max) max = n;
  }
  return max;
}

export async function getSyncPipelineHealth() {
  const generatedAt = Date.now();
  const ledgerLastSeq = toNumber(getLedgerLastSeq());

  const idxMax = await db
    .select({ maxSeq: sql<number>`coalesce(max(${ledgerTxIndex.serverSeq}), 0)` })
    .from(ledgerTxIndex)
    .limit(1);
  const indexMaxSeq = toNumber(idxMax[0]?.maxSeq ?? 0);
  const projectionMaxSeq = await maxProjectionSeq();

  const tables: Record<TableKey, TableHealth> = {
    entity_types: { ledgerCount: 0, projectionCount: 0, diffAbs: 0, diffRatio: 0 },
    entities: { ledgerCount: 0, projectionCount: 0, diffAbs: 0, diffRatio: 0 },
    attribute_defs: { ledgerCount: 0, projectionCount: 0, diffAbs: 0, diffRatio: 0 },
    attribute_values: { ledgerCount: 0, projectionCount: 0, diffAbs: 0, diffRatio: 0 },
    operations: { ledgerCount: 0, projectionCount: 0, diffAbs: 0, diffRatio: 0 },
  };

  const ledgerEntityTypes = loadLedgerRows(SyncTableName.EntityTypes);
  const entityTypeByCode = new Map<string, Record<string, unknown>>();
  const entityTypeCodeById = new Map<string, string>();
  const bulkEntityTypeIds = new Set<string>();
  for (const row of ledgerEntityTypes) {
    const id = String(row.id ?? '');
    const code = String(row.code ?? '');
    if (!id) continue;
    entityTypeCodeById.set(id, code);
    if (isBulkEntityTypeRow(row)) {
      bulkEntityTypeIds.add(id);
      continue;
    }
    const key = code || id;
    const prev = entityTypeByCode.get(key);
    if (!prev || rowUpdatedAt(prev) < rowUpdatedAt(row)) {
      entityTypeByCode.set(key, row);
    }
  }
  const canonicalEntityTypeIdByCode = new Map<string, string>();
  for (const [key, row] of entityTypeByCode) canonicalEntityTypeIdByCode.set(key, String(row.id ?? ''));
  const canonicalEntityTypeIdById = new Map<string, string>();
  for (const row of ledgerEntityTypes) {
    const id = String(row.id ?? '');
    const code = String(row.code ?? '');
    if (!id || bulkEntityTypeIds.has(id)) continue;
    const key = code || id;
    const canonicalId = canonicalEntityTypeIdByCode.get(key);
    if (canonicalId) canonicalEntityTypeIdById.set(id, canonicalId);
  }

  const ledgerAttributeDefs = loadLedgerRows(SyncTableName.AttributeDefs);
  const attributeDefByKey = new Map<string, Record<string, unknown>>();
  for (const row of ledgerAttributeDefs) {
    const id = String(row.id ?? '');
    const typeId = String(row.entity_type_id ?? '');
    const code = String(row.code ?? '');
    if (!id || !typeId || !code || bulkEntityTypeIds.has(typeId)) continue;
    const canonicalTypeId = canonicalEntityTypeIdById.get(typeId) ?? typeId;
    const key = `${canonicalTypeId}::${code}`;
    const prev = attributeDefByKey.get(key);
    if (!prev || rowUpdatedAt(prev) < rowUpdatedAt(row)) {
      attributeDefByKey.set(key, row);
    }
  }
  const canonicalAttributeDefIdByKey = new Map<string, string>();
  for (const [key, row] of attributeDefByKey) canonicalAttributeDefIdByKey.set(key, String(row.id ?? ''));
  const canonicalAttributeDefIdById = new Map<string, string>();
  for (const row of ledgerAttributeDefs) {
    const id = String(row.id ?? '');
    const typeId = String(row.entity_type_id ?? '');
    const code = String(row.code ?? '');
    if (!id || !typeId || !code || bulkEntityTypeIds.has(typeId)) continue;
    const canonicalTypeId = canonicalEntityTypeIdById.get(typeId) ?? typeId;
    const key = `${canonicalTypeId}::${code}`;
    const canonicalDefId = canonicalAttributeDefIdByKey.get(key);
    if (canonicalDefId) canonicalAttributeDefIdById.set(id, canonicalDefId);
  }

  const ledgerAttributeValues = loadLedgerRows(SyncTableName.AttributeValues);
  const attributeValueByPair = new Map<string, Record<string, unknown>>();
  for (const row of ledgerAttributeValues) {
    const entityId = String(row.entity_id ?? '');
    const defId = String(row.attribute_def_id ?? '');
    if (!entityId || !defId) continue;
    const canonicalDefId = canonicalAttributeDefIdById.get(defId) ?? defId;
    const key = `${entityId}::${canonicalDefId}`;
    const prev = attributeValueByPair.get(key);
    if (!prev || rowUpdatedAt(prev) < rowUpdatedAt(row)) {
      attributeValueByPair.set(key, row);
    }
  }

  for (const t of TABLES) {
    let ledgerCount = countLedgerRows(t.syncName);
    if (t.syncName === SyncTableName.EntityTypes) {
      ledgerCount = entityTypeByCode.size;
    } else if (t.syncName === SyncTableName.AttributeDefs) {
      ledgerCount = attributeDefByKey.size;
    } else if (t.syncName === SyncTableName.AttributeValues) {
      ledgerCount = attributeValueByPair.size;
    }
    const projectionCount = await countProjectionRows(t.projectionTable);
    const diffAbs = Math.abs(ledgerCount - projectionCount);
    const diffRatio = computeRatio(ledgerCount, projectionCount);
    tables[t.key] = { ledgerCount, projectionCount, diffAbs, diffRatio };
  }

  const ledgerToIndexLag = Math.max(0, ledgerLastSeq - indexMaxSeq);
  const indexToProjectionLag = Math.max(0, indexMaxSeq - projectionMaxSeq);
  const worstTable = Object.entries(tables)
    .map(([key, v]) => ({ key, diffRatio: v.diffRatio }))
    .sort((a, b) => b.diffRatio - a.diffRatio)[0] ?? null;
  const maxTableRatio = worstTable?.diffRatio ?? 0;
  const status = computeStatus({ ledgerToIndexLag, indexToProjectionLag, maxTableRatio });

  return {
    ok: true as const,
    generatedAt,
    status,
    seq: {
      ledgerLastSeq,
      indexMaxSeq,
      projectionMaxSeq,
      ledgerToIndexLag,
      indexToProjectionLag,
    },
    tables,
    reasons: reasons({ ledgerToIndexLag, indexToProjectionLag, worstTable }),
  };
}

