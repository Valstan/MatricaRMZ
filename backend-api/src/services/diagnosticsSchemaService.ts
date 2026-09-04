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

/**
 * Состав таблиц снимка, каким его знали сборки ДО входа аккаунтов в контракт
 * (B3/R3). Список ЗАМОРОЖЕН намеренно и не выводится из `SyncTableName`.
 *
 * Зачем. Клиент хеширует полученный снимок и сравнивает с сохранённым; сборки
 * **до v3.5.0** на расхождение хеша отвечают ПЕРЕСБОРКОЙ локальной базы — вместе
 * с неотправленной работой и сессией. На 2026-08-30 таких машин в парке 12 из 26
 * активных, и одна выходила на связь за два дня до релиза. Добавление двух
 * таблиц в контракт меняет хеш у всех разом, то есть выкат стёр бы им локальные
 * данные в течение шестичасового окна кэша схемы.
 *
 * Поэтому клиент, не представившийся версией (а старый и не умеет), получает
 * ровно тот состав, который у него уже закеширован, и его хеш не двигается.
 * Список не выводится из `SyncTableName` именно ради этого: следующая таблица,
 * добавленная в контракт, не должна автоматически попасть сюда и уронить парк.
 *
 * Снимать вместе с остальными переходными ветками, когда в парке не останется
 * сборок ниже v3.5.0.
 */
export const LEGACY_SCHEMA_SNAPSHOT_TABLES: readonly string[] = [
  SyncTableName.EntityTypes,
  SyncTableName.Entities,
  SyncTableName.AttributeDefs,
  SyncTableName.AttributeValues,
  SyncTableName.Operations,
  SyncTableName.AuditLog,
  SyncTableName.ChatMessages,
  SyncTableName.ChatReads,
  SyncTableName.UserPresence,
  SyncTableName.Notes,
  SyncTableName.NoteShares,
  SyncTableName.CardDrafts,
  SyncTableName.AiChatRequests,
  SyncTableName.ErpNomenclature,
  SyncTableName.ErpEngineAssemblyBom,
  SyncTableName.ErpEngineAssemblyBomLines,
  SyncTableName.ErpEngineAssemblyBomBrandLinks,
  SyncTableName.ErpEngineInstances,
  SyncTableName.ErpRegStockBalance,
  SyncTableName.ErpRegStockMovements,
];

// Список колонок из array_agg: массив, если драйвер разобрал тип; строка вида
// "{a,b}" — если не разобрал (name[] без ::text). Строку тоже принимаем, чтобы
// класс поломки «тип не разобран → ограничение молча выпало» не повторился.
export function pgArrayColumns(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((c) => String(c ?? '').trim()).filter(Boolean);
  const s = String(raw ?? '').trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return [];
  return s
    .slice(1, -1)
    .split(',')
    .map((c) => c.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

// Клиент хеширует снимок ВМЕСТЕ с uniqueConstraints. До 04.09.2026 они были пусты у всех
// (name[] не разбирался), значит любое их появление меняет хеш всему парку: сборки до v3.5.0
// на это ПЕРЕСОБИРАЮТ локальную базу, а сборки до 3.20.0 применяют дедуп по unique без
// режима отчёта. Поэтому unique отдаются только клиентам, которые умеют лишь отчитываться
// (SCHEMA_UNIQUE_SAFE_CLIENT_VERSION в routes/diagnostics.ts); по умолчанию — пусто, как было.
// С этой сборки клиент по серверным unique только ОТЧИТЫВАЕТСЯ (UNIQUE_DEDUP_APPLY=false в
// electron-app syncService.ts). Более старым unique не отдаём: у них дедуп удаляет сразу.
// Первый релиз с режимом отчёта — 3.20.0 (сторож: константа строго выше текущего VERSION,
// пока релиз не вышел).
export const SCHEMA_UNIQUE_SAFE_CLIENT_VERSION = '3.20.0';

export async function getSyncSchemaSnapshot(opts?: {
  tables?: readonly string[];
  includeUniqueConstraints?: boolean;
}): Promise<SyncSchemaSnapshot> {
  const tables = [...(opts?.tables ?? Object.values(SyncTableName))];
  const includeUnique = opts?.includeUniqueConstraints === true;
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
        -- ::text обязателен: attname имеет тип name, и name[] node-postgres НЕ разбирает —
        -- строка "{code}" приходила как есть, потребитель ниже требовал массив и
        -- выбрасывал КАЖДУЮ запись. С 2026-08-30 известно, что uniqueConstraints был пуст у
        -- всех таблиц снимка с самого рождения (PENDING §«Уникальные ограничения…»).
        array_agg(a.attname::text ORDER BY x.n) AS columns
      FROM pg_class t
      JOIN pg_index ix ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS x(attnum, n) ON true
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum
      WHERE t.relname = ANY($1)
        AND ix.indisunique = true
        -- ЧАСТИЧНЫЕ unique сюда не попадают, и это принципиально. Снимок едет на
        -- клиент, где repairLocalSyncTables по нему СХЛОПЫВАЕТ дубли: оставляет
        -- одну строку, переписывает на неё чужие ссылки, остальные удаляет. Для
        -- частичного индекса это означает применение ограничения там, где сервер
        -- его сознательно НЕ применяет.
        -- Живые примеры на сегодня: erp_nomenclature_code_uq
        -- (WHERE deleted_at IS NULL AND code <> '' — пустой артикул легален и
        -- повторяем, это конвенция «артикула нет») и users_login_live_uq
        -- (WHERE deleted_at IS NULL — логин освобождается при отзыве аккаунта).
        -- Без этого условия ремонт реплики сливал бы разные номенклатуры с
        -- пустым артикулом в одну, а отозванный аккаунт — с живым однофамильцем,
        -- перенося доступы мёртвого на живого. Молча и на каждой машине парка.
        AND ix.indpred IS NULL
      GROUP BY t.relname, i.relname, ix.indisprimary
      ORDER BY t.relname, i.relname
    `,
    [tables],
  );

  const snapshot: SyncSchemaSnapshot = { generatedAt: Date.now(), tables: {} };
  const ensureTable = (tableName: string) => {
    if (!snapshot.tables[tableName]) {
      snapshot.tables[tableName] = { columns: [], foreignKeys: [], uniqueConstraints: [] };
    }
    return snapshot.tables[tableName];
  };
  for (const table of tables) {
    ensureTable(table);
  }

  for (const row of columnsRes.rows as Array<{
    table_name: string;
    column_name: string;
    is_nullable: 'YES' | 'NO';
    column_default: string | null;
    data_type: string;
  }>) {
    const table = ensureTable(row.table_name);
    table.columns.push({
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
    const table = ensureTable(row.table_name);
    table.foreignKeys.push({
      column: row.column_name,
      refTable: row.ref_table,
      refColumn: row.ref_column,
      onUpdate: mapAction(row.confupdtype),
      onDelete: mapAction(row.confdeltype),
    });
  }

  for (const row of uniqueRes.rows as Array<{
    table_name: string;
    columns: string[] | string;
    is_primary: boolean;
  }>) {
    if (!includeUnique) break;
    const table = ensureTable(row.table_name);
    const cols = pgArrayColumns(row.columns);
    if (cols.length === 0) continue;
    table.uniqueConstraints.push({
      columns: cols.map(String),
      isPrimary: !!row.is_primary,
    });
  }

  return snapshot;
}
