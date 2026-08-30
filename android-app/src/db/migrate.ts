// Async-порт безусловного шага миграции клиента
// (electron-app/src/main/database/migrate.ts) поверх AsyncSqlite.
// Логика и комментарии — источник в electron-app; при правках там не забыть сюда
// (и наоборот). Порт 1:1, отличается только await-стилем обращений к БД.

import type { AsyncSqlite } from './asyncSqlite.js';
import { applyDrizzleChain } from './migrations/drizzleChain.js';

export async function migrateSqliteAsync(sqlite: AsyncSqlite): Promise<void> {
  await applyDrizzleChain(sqlite);
  await ensureClientSchemaParity(sqlite);
  await purgeLeakedCredentialAttributes(sqlite);
  // VACUUM не запускаем автоматически — это дорого. Только при обслуживании.
  await sqlite.exec('PRAGMA optimize;');
}

async function hasTable(sqlite: AsyncSqlite, name: string): Promise<boolean> {
  const row = await sqlite.get(`SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name=?`, [name]);
  return !!row;
}

// security-hardening-2026-06 H1-B*: чистка утёкших employee `password_hash`
// (см. оригинал в electron-app — идемпотентно, гоняется на каждом старте).
export async function purgeLeakedCredentialAttributes(sqlite: AsyncSqlite): Promise<void> {
  if (!(await hasTable(sqlite, 'attribute_values')) || !(await hasTable(sqlite, 'attribute_defs'))) return;
  await sqlite.exec(
    `DELETE FROM attribute_values WHERE attribute_def_id IN (SELECT id FROM attribute_defs WHERE code = 'password_hash');`,
  );
}

// Идемпотентная доводка схемы, продублированная из version-chained
// clientSchemaMigrations в безусловный путь (историю см. в electron-app/migrate.ts).
export async function ensureClientSchemaParity(sqlite: AsyncSqlite): Promise<void> {
  const columnNames = async (table: string): Promise<Set<string>> => {
    const rows = await sqlite.all<{ name: string }>(`PRAGMA table_info(${JSON.stringify(table)})`);
    return new Set(rows.map((c) => c.name));
  };

  // warehouse_command_outbox — локальный outbox, добавлен через clientSchemaMigrations 6->7.
  await sqlite.exec(`
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

  // card_drafts — синкаемая таблица черновиков/recovery (Phase 3).
  await sqlite.exec(`
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

  // ai_chat_requests — синкаемая таблица асинхронного AI-чата.
  await sqlite.exec(`
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

  // users / user_section_access — реплика аккаунтов и доступов по разделам (B3/R3).
  // Зеркало electron-app/src/main/database/migrate.ts: дампы sqlite_master свежей
  // БД по обоим путям сверяет drizzleChain.test.ts.
  await sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY NOT NULL,
      login text NOT NULL,
      system_role text NOT NULL,
      access_enabled integer NOT NULL DEFAULT false,
      delete_requested_at integer,
      delete_requested_by text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_login_live_uq ON users(login) WHERE deleted_at is null;
    CREATE INDEX IF NOT EXISTS users_role_idx ON users(system_role);

    CREATE TABLE IF NOT EXISTS user_section_access (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL,
      section_id text NOT NULL,
      level text NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS user_section_access_pair_uq ON user_section_access(user_id, section_id);
    CREATE INDEX IF NOT EXISTS user_section_access_user_idx ON user_section_access(user_id);
  `);

  // erp_document_lines.nomenclature_id — добавлен через clientSchemaMigrations 3->4.
  if (await hasTable(sqlite, 'erp_document_lines')) {
    if (!(await columnNames('erp_document_lines')).has('nomenclature_id')) {
      await sqlite.exec(`ALTER TABLE erp_document_lines ADD COLUMN nomenclature_id text;`);
    }
    await sqlite.exec(
      `CREATE INDEX IF NOT EXISTS erp_document_lines_nomenclature_idx ON erp_document_lines(nomenclature_id);`,
    );
  }

  // erp_engine_assembly_bom.engine_nomenclature_id — снятие ошибочного NOT NULL
  // пересборкой таблицы (историю см. в electron-app/migrate.ts).
  if (await hasTable(sqlite, 'erp_engine_assembly_bom')) {
    const info = await sqlite.all<{ name: string; notnull: number }>(`PRAGMA table_info(erp_engine_assembly_bom)`);
    const engineCol = info.find((c) => c.name === 'engine_nomenclature_id');
    if (engineCol && Number(engineCol.notnull) === 1) {
      const cols = info.map((c) => c.name).join(', ');
      await sqlite.exec(`
        BEGIN;
        CREATE TABLE erp_engine_assembly_bom_new (
          id text PRIMARY KEY NOT NULL,
          name text NOT NULL,
          engine_nomenclature_id text,
          version integer NOT NULL DEFAULT 1,
          status text NOT NULL DEFAULT 'draft',
          is_default integer NOT NULL DEFAULT 0,
          notes text,
          created_at integer NOT NULL,
          updated_at integer NOT NULL,
          deleted_at integer,
          sync_status text NOT NULL DEFAULT 'synced',
          last_server_seq integer,
          default_variant_key text,
          execution_profile_json text
        );
        INSERT INTO erp_engine_assembly_bom_new (${cols}) SELECT ${cols} FROM erp_engine_assembly_bom;
        DROP TABLE erp_engine_assembly_bom;
        ALTER TABLE erp_engine_assembly_bom_new RENAME TO erp_engine_assembly_bom;
        CREATE UNIQUE INDEX IF NOT EXISTS erp_engine_assembly_bom_engine_version_uq
          ON erp_engine_assembly_bom(engine_nomenclature_id, version);
        CREATE INDEX IF NOT EXISTS erp_engine_assembly_bom_engine_idx
          ON erp_engine_assembly_bom(engine_nomenclature_id);
        CREATE INDEX IF NOT EXISTS erp_engine_assembly_bom_status_idx
          ON erp_engine_assembly_bom(status);
        COMMIT;
      `);
    }
  }

  // erp_nomenclature.directory_kind / directory_ref_id — clientSchemaMigrations 7->8.
  if (await hasTable(sqlite, 'erp_nomenclature')) {
    const cols = await columnNames('erp_nomenclature');
    if (!cols.has('directory_kind')) {
      await sqlite.exec(`ALTER TABLE erp_nomenclature ADD COLUMN directory_kind text;`);
    }
    if (!cols.has('directory_ref_id')) {
      await sqlite.exec(`ALTER TABLE erp_nomenclature ADD COLUMN directory_ref_id text;`);
    }
    await sqlite.exec(
      `CREATE INDEX IF NOT EXISTS erp_nomenclature_directory_kind_idx ON erp_nomenclature(directory_kind);`,
    );
  }
}
