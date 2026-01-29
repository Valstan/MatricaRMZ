import { SyncTableName } from '@matricarmz/shared';

import { pool } from '../database/db.js';

type SyncSchemaColumn = {
  name: string;
  dataType: string;
  notNull: boolean;
  default: string | null;
};

type SyncSchemaForeignKey = {
  column: string;
  refTable: string;
  refColumn: string;
  onUpdate: string;
  onDelete: string;
};

type SyncSchemaUniqueConstraint = {
  columns: string[];
  isPrimary: boolean;
};

export type SyncSchemaSnapshot = {
  generatedAt: number;
  tables: Record<
    string,
    {
      columns: SyncSchemaColumn[];
      foreignKeys: SyncSchemaForeignKey[];
      uniqueConstraints: SyncSchemaUniqueConstraint[];
    }
  >;
};

function mapAction(code: string | null | undefined) {
  switch (code) {
    case 'a':
      return 'no_action';
    case 'r':
      return 'restrict';
    case 'c':
      return 'cascade';
    case 'n':
      return 'set_null';
    case 'd':
      return 'set_default';
    default:
      return 'no_action';
  }
}

export async function getSyncSchemaSnapshot(): Promise<SyncSchemaSnapshot> {
  const tables = Object.values(SyncTableName);
  const columnsRes = await pool.query(
    `
      SELECT
        c.table_name,
        c.column_name,
        c.is_nullable,
        c.column_default,
        c.data_type
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = ANY($1)
      ORDER BY c.table_name, c.ordinal_position
    `,
    [tables],
  );
  const fkRes = await pool.query(
    `
      SELECT
        conrelid::regclass::text AS table_name,
        att2.attname AS column_name,
        confrelid::regclass::text AS ref_table,
        att.attname AS ref_column,
        confupdtype,
        confdeltype
      FROM pg_constraint
      JOIN pg_attribute att2
        ON att2.attrelid = conrelid AND att2.attnum = conkey[1]
      JOIN pg_attribute att
        ON att.attrelid = confrelid AND att.attnum = confkey[1]
      WHERE contype = 'f'
        AND array_length(conkey, 1) = 1
        AND array_length(confkey, 1) = 1
        AND conrelid::regclass::text = ANY($1)
    `,
    [tables],
  );
  const uniqueRes = await pool.query(
    `
      SELECT
        t.relname AS table_name,
        i.relname AS index_name,
        ix.indisprimary AS is_primary,
        array_agg(a.attname ORDER BY x.n) AS columns
      FROM pg_class t
      JOIN pg_index ix ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS x(attnum, n) ON true
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum
      WHERE t.relname = ANY($1)
        AND ix.indisunique = true
      GROUP BY t.relname, i.relname, ix.indisprimary
      ORDER BY t.relname, i.relname
    `,
    [tables],
  );

  const snapshot: SyncSchemaSnapshot = { generatedAt: Date.now(), tables: {} };
  for (const table of tables) {
    snapshot.tables[table] = { columns: [], foreignKeys: [], uniqueConstraints: [] };
  }

  for (const row of columnsRes.rows as Array<{
    table_name: string;
    column_name: string;
    is_nullable: 'YES' | 'NO';
    column_default: string | null;
    data_type: string;
  }>) {
    if (!snapshot.tables[row.table_name]) {
      snapshot.tables[row.table_name] = { columns: [], foreignKeys: [], uniqueConstraints: [] };
    }
    snapshot.tables[row.table_name].columns.push({
      name: row.column_name,
      dataType: row.data_type,
      notNull: row.is_nullable === 'NO',
      default: row.column_default,
    });
  }

  for (const row of fkRes.rows as Array<{
    table_name: string;
    column_name: string;
    ref_table: string;
    ref_column: string;
    confupdtype: string;
    confdeltype: string;
  }>) {
    if (!snapshot.tables[row.table_name]) {
      snapshot.tables[row.table_name] = { columns: [], foreignKeys: [], uniqueConstraints: [] };
    }
    snapshot.tables[row.table_name].foreignKeys.push({
      column: row.column_name,
      refTable: row.ref_table,
      refColumn: row.ref_column,
      onUpdate: mapAction(row.confupdtype),
      onDelete: mapAction(row.confdeltype),
    });
  }

  for (const row of uniqueRes.rows as Array<{
    table_name: string;
    columns: string[];
    is_primary: boolean;
  }>) {
    if (!snapshot.tables[row.table_name]) {
      snapshot.tables[row.table_name] = { columns: [], foreignKeys: [], uniqueConstraints: [] };
    }
    const cols = Array.isArray(row.columns) ? row.columns.filter(Boolean) : [];
    if (cols.length === 0) continue;
    snapshot.tables[row.table_name].uniqueConstraints.push({
      columns: cols.map(String),
      isPrimary: !!row.is_primary,
    });
  }

  return snapshot;
}
