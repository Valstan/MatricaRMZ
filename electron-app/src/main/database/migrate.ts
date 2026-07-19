import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export function migrateSqlite(
  db: BetterSQLite3Database,
  sqlite: Database.Database,
  migrationsFolder: string,
) {
  // drizzle migrator ожидает исходный sqlite handle
  migrate(db, { migrationsFolder });
  ensureClientSchemaParity(sqlite);
  purgeLeakedCredentialAttributes(sqlite);
  // VACUUM не запускаем автоматически — это дорого. Только при обслуживании.
  sqlite.pragma('optimize');
}

// security-hardening-2026-06 H1-B*: purge employee `password_hash` rows that
// leaked into the client SQLite before the server stopped syncing them (H1-B1a).
// `password_hash` is an employee EAV attribute that used to be pulled to every
// client; authentication is server-side only (no client reads the hash), so any
// local copy is pure exposure. Idempotent and run on every startup (self-healing)
// in the unconditional, pre-sync, pre-auth path so existing installs are cleaned
// without a re-sync.
export function purgeLeakedCredentialAttributes(sqlite: Database.Database) {
  const hasTable = (name: string): boolean =>
    !!sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  if (!hasTable('attribute_values') || !hasTable('attribute_defs')) return;
  sqlite.exec(
    `DELETE FROM attribute_values WHERE attribute_def_id IN (SELECT id FROM attribute_defs WHERE code = 'password_hash');`,
  );
}

// Несколько объектов схемы (см. schema.ts) попали в клиент только через
// version-chained мигратор `clientSchemaMigrations.ts`, но НЕ были продублированы
// в безусловный drizzle-путь (`drizzle/*.sql`). Свежая установка базлайнит
// ClientSchemaVersion сразу до текущей версии и пропускает эту цепочку, поэтому
// колонки/таблица на холодной БД отсутствуют, и cold full-sync падает
// (`table erp_nomenclature has no column named directory_kind`). align добавил бы
// их, но ловит 401 до логина. Чиним в безусловном, до-sync, до-auth шаге миграции.
//
// Почему не drizzle-миграция: drizzle гоняет сырой SQL одной транзакцией, а
// `ALTER TABLE ADD COLUMN` в SQLite не имеет `IF NOT EXISTS`. На долгоживущих
// клиентах эти колонки уже добавлены вне drizzle (alignSchemaWithServer /
// clientSchemaMigrations), и неэкранированный ALTER упал бы с «duplicate column
// name» → откат транзакции → self-heal-перестройка БД в index.ts. Поэтому
// идемпотентная PRAGMA-обёртка в стиле clientSchemaMigrations.ts.
function ensureClientSchemaParity(sqlite: Database.Database) {
  const hasTable = (name: string): boolean =>
    !!sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  const columnNames = (table: string): Set<string> =>
    new Set(
      (sqlite.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );

  // warehouse_command_outbox — локальный outbox, добавлен через clientSchemaMigrations 6->7.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS warehouse_command_outbox (
      id text PRIMARY KEY NOT NULL,
      client_operation_id text NOT NULL,
      command_type text NOT NULL,
      aggregate_type text NOT NULL DEFAULT 'warehouse_document',
      aggregate_id text,
      payload_json text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      attempts integer NOT NULL DEFAULT 0,
      next_retry_at integer NOT NULL DEFAULT 0,
      last_error text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS warehouse_command_outbox_client_operation_id_uq
      ON warehouse_command_outbox(client_operation_id);
    CREATE INDEX IF NOT EXISTS warehouse_command_outbox_status_next_retry_idx
      ON warehouse_command_outbox(status, next_retry_at);
    CREATE INDEX IF NOT EXISTS warehouse_command_outbox_aggregate_idx
      ON warehouse_command_outbox(aggregate_type, aggregate_id);
  `);

  // card_drafts — синкаемая таблица черновиков/recovery (Phase 3). Дублируем в idempotent-путь:
  // свежая установка базлайнит ClientSchemaVersion мимо drizzle-цепочки → таблица иначе не создастся.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS card_drafts (
      id text PRIMARY KEY NOT NULL,
      owner_user_id text NOT NULL,
      card_type text NOT NULL,
      card_id text NOT NULL,
      kind text NOT NULL DEFAULT 'recovery',
      title text,
      payload_json text,
      base_updated_at integer,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE INDEX IF NOT EXISTS card_drafts_owner_kind_idx ON card_drafts(owner_user_id, kind);
    CREATE INDEX IF NOT EXISTS card_drafts_owner_card_idx ON card_drafts(owner_user_id, card_type, card_id);
    CREATE INDEX IF NOT EXISTS card_drafts_sync_status_idx ON card_drafts(sync_status);
  `);

  // ai_chat_requests — синкаемая таблица асинхронного AI-чата. Дублируем в idempotent-путь
  // (та же причина, что card_drafts: свежая установка идёт мимо drizzle-цепочки).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ai_chat_requests (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL,
      username text NOT NULL,
      question_text text NOT NULL,
      question_file_json text,
      status text NOT NULL DEFAULT 'pending',
      answer_text text,
      answer_files_json text,
      answered_at integer,
      escalation_note text,
      verdict_text text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE INDEX IF NOT EXISTS ai_chat_requests_user_created_idx ON ai_chat_requests(user_id, created_at);
    CREATE INDEX IF NOT EXISTS ai_chat_requests_status_idx ON ai_chat_requests(status);
    CREATE INDEX IF NOT EXISTS ai_chat_requests_sync_status_idx ON ai_chat_requests(sync_status);
  `);

  // erp_document_lines.nomenclature_id — добавлен через clientSchemaMigrations 3->4.
  if (hasTable('erp_document_lines')) {
    if (!columnNames('erp_document_lines').has('nomenclature_id')) {
      sqlite.exec(`ALTER TABLE erp_document_lines ADD COLUMN nomenclature_id text;`);
    }
    sqlite.exec(
      `CREATE INDEX IF NOT EXISTS erp_document_lines_nomenclature_idx ON erp_document_lines(nomenclature_id);`,
    );
  }

  // erp_nomenclature.directory_kind / directory_ref_id — добавлены через clientSchemaMigrations 7->8.
  if (hasTable('erp_nomenclature')) {
    const cols = columnNames('erp_nomenclature');
    if (!cols.has('directory_kind')) {
      sqlite.exec(`ALTER TABLE erp_nomenclature ADD COLUMN directory_kind text;`);
    }
    if (!cols.has('directory_ref_id')) {
      sqlite.exec(`ALTER TABLE erp_nomenclature ADD COLUMN directory_ref_id text;`);
    }
    sqlite.exec(
      `CREATE INDEX IF NOT EXISTS erp_nomenclature_directory_kind_idx ON erp_nomenclature(directory_kind);`,
    );
  }
}
