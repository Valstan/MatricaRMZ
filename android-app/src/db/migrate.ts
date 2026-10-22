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
      answer_source text,
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

  // ai_chat_requests.answer_source — источник серверного ответа (`engine` | `deepseek`).
  // Зеркало electron-app/src/main/database/migrate.ts: долгоживущие БД миновали
  // drizzle-цепочку, колонку доводит PRAGMA-проверка + ALTER.
  if ((await columnNames('ai_chat_requests')).has('answer_source') === false) {
    await sqlite.exec(`ALTER TABLE ai_chat_requests ADD COLUMN answer_source text;`);
  }

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

  // erp_counterparties / erp_contracts / directory_engine_brands — реплики словарных
  // зеркал (pull-only, план sync-mirror-dictionaries-2026-10).
  // Зеркало electron-app/src/main/database/migrate.ts: дампы sqlite_master свежей
  // БД по обоим путям сверяет drizzleChain.test.ts.
  //
  // Прототипная 0006 создавала одноимённые erp_counterparties/erp_contracts другой формы
  // (0021 их не сносила). Сносим только прототип (маркер — колонка `code`, которой нет
  // в каноне), живую реплику не трогаем: parity гоняется на каждом старте.
  for (const table of ['erp_counterparties', 'erp_contracts'] as const) {
    if ((await hasTable(sqlite, table)) && (await columnNames(table)).has('code')) {
      await sqlite.exec(`DROP TABLE IF EXISTS ${table};`);
    }
  }
  await sqlite.exec(`
    CREATE TABLE IF NOT EXISTS erp_counterparties (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      short_name text,
      inn text,
      kpp text,
      address text,
      email text,
      phone text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE INDEX IF NOT EXISTS erp_counterparties_name_idx ON erp_counterparties(name);

    CREATE TABLE IF NOT EXISTS erp_contracts (
      id text PRIMARY KEY NOT NULL,
      number text,
      internal_number text,
      goz_name text,
      goz_igk text,
      goz_separate_account_number text,
      goz_separate_account_bank text,
      goz_separate_account text,
      signed_at integer,
      due_at integer,
      customer_id text,
      comment text,
      sections_json text,
      execution_parts_json text,
      payments_json text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE INDEX IF NOT EXISTS erp_contracts_number_idx ON erp_contracts(number);
    CREATE INDEX IF NOT EXISTS erp_contracts_customer_idx ON erp_contracts(customer_id);

    CREATE TABLE IF NOT EXISTS erp_contract_payment_slots (
      id text PRIMARY KEY NOT NULL,
      contract_id text NOT NULL,
      section_key text NOT NULL,
      engine_brand_id text,
      engine_id text,
      contract_price_kop integer,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE INDEX IF NOT EXISTS erp_contract_payment_slots_contract_idx ON erp_contract_payment_slots(contract_id);
    CREATE INDEX IF NOT EXISTS erp_contract_payment_slots_engine_idx ON erp_contract_payment_slots(engine_id);

    CREATE TABLE IF NOT EXISTS erp_contract_payments (
      id text PRIMARY KEY NOT NULL,
      slot_id text NOT NULL,
      date text NOT NULL,
      amount_kop integer NOT NULL,
      kind text NOT NULL,
      note text,
      countdown_start integer NOT NULL DEFAULT 0,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE INDEX IF NOT EXISTS erp_contract_payments_slot_idx ON erp_contract_payments(slot_id);

    CREATE TABLE IF NOT EXISTS directory_engine_brands (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      is_active integer NOT NULL DEFAULT true,
      metadata_json text,
      deprecated_at integer,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE INDEX IF NOT EXISTS directory_engine_brands_name_idx ON directory_engine_brands(name);

    CREATE TABLE IF NOT EXISTS erp_engine_cards (
      id text PRIMARY KEY NOT NULL,
      engine_number text,
      engine_internal_number text,
      engine_internal_number_year integer,
      engine_brand_id text,
      engine_brand text,
      arrival_date integer,
      customer_id text,
      contract_id text,
      contract_section_number text,
      workshop_id text,
      status_rework_sent integer NOT NULL DEFAULT 0,
      status_rework_sent_date integer,
      status_scrap_confirmed integer NOT NULL DEFAULT 0,
      status_scrap_confirmed_date integer,
      status_repair_started integer NOT NULL DEFAULT 0,
      status_repair_started_date integer,
      status_repaired integer NOT NULL DEFAULT 0,
      status_repaired_date integer,
      status_customer_sent integer NOT NULL DEFAULT 0,
      status_customer_sent_date integer,
      status_customer_accepted integer NOT NULL DEFAULT 0,
      status_customer_accepted_date integer,
      status_storage_received integer NOT NULL DEFAULT 0,
      status_storage_received_date integer,
      status_rejected integer NOT NULL DEFAULT 0,
      status_rejected_date integer,
      scrap_reason text,
      reclamation_flag integer NOT NULL DEFAULT 0,
      reclamation_accepted_date integer,
      reclamation_customer_reason text,
      reclamation_actual_defect text,
      reclamation_defect_nature text,
      reclamation_act_number text,
      reclamation_verdict_date integer,
      reclamation_shipped_date integer,
      reclamation_comment text,
      reclamation_verdict text,
      reclamation_repair_status text,
      repeat_arrival_flag integer NOT NULL DEFAULT 0,
      number_collision_flag integer NOT NULL DEFAULT 0,
      previous_arrival_id text,
      merged_into text,
      arrival_invoice text,
      shipment_invoice text,
      engine_note text,
      docs_state text,
      docs_aspvr_contractor_date integer,
      docs_vp_sent_date integer,
      docs_vp_returned_date integer,
      docs_aspvr_customer_scan_date integer,
      docs_aspvr_customer_original_date integer,
      docs_track_or_act text,
      docs_aspvr_signed_customer_date integer,
      docs_aspvr_customer_received integer NOT NULL DEFAULT 0,
      docs_return_scan_date integer,
      docs_return_original_date integer,
      docs_note text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE INDEX IF NOT EXISTS erp_engine_cards_number_idx ON erp_engine_cards(engine_number);
    CREATE INDEX IF NOT EXISTS erp_engine_cards_contract_idx ON erp_engine_cards(contract_id);

    CREATE TABLE IF NOT EXISTS ppe_norm_sets (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      post_title text,
      department_id text,
      gender text,
      season text,
      is_duty integer NOT NULL DEFAULT 0,
      valid_from integer NOT NULL,
      valid_to integer,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE TABLE IF NOT EXISTS ppe_norm_lines (
      id text PRIMARY KEY NOT NULL,
      norm_set_id text NOT NULL,
      nomenclature_id text NOT NULL,
      qty integer NOT NULL,
      wear_months integer NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE TABLE IF NOT EXISTS ppe_issue_cards (
      id text PRIMARY KEY NOT NULL,
      employee_id text NOT NULL,
      opened_at integer NOT NULL,
      closed_at integer,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE TABLE IF NOT EXISTS ppe_card_norms (
      id text PRIMARY KEY NOT NULL,
      card_id text NOT NULL,
      norm_set_id text NOT NULL,
      assigned_at integer NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE TABLE IF NOT EXISTS ppe_issue_entries (
      id text PRIMARY KEY NOT NULL,
      card_id text NOT NULL,
      nomenclature_id text NOT NULL,
      qty integer NOT NULL,
      issued_at integer NOT NULL,
      document_id text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE INDEX IF NOT EXISTS ppe_norm_sets_post_idx ON ppe_norm_sets(post_title, valid_from);
    CREATE INDEX IF NOT EXISTS ppe_norm_lines_set_idx ON ppe_norm_lines(norm_set_id);
    CREATE INDEX IF NOT EXISTS ppe_norm_lines_nomenclature_idx ON ppe_norm_lines(nomenclature_id);
    CREATE UNIQUE INDEX IF NOT EXISTS ppe_norm_lines_set_nomenclature_uq ON ppe_norm_lines(norm_set_id, nomenclature_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS ppe_issue_cards_employee_idx ON ppe_issue_cards(employee_id);
    CREATE UNIQUE INDEX IF NOT EXISTS ppe_issue_cards_employee_open_uq ON ppe_issue_cards(employee_id) WHERE closed_at IS NULL AND deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS ppe_card_norms_card_idx ON ppe_card_norms(card_id);
    CREATE UNIQUE INDEX IF NOT EXISTS ppe_card_norms_card_set_uq ON ppe_card_norms(card_id, norm_set_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS ppe_issue_entries_card_idx ON ppe_issue_entries(card_id, issued_at);
    CREATE INDEX IF NOT EXISTS ppe_issue_entries_nomenclature_idx ON ppe_issue_entries(nomenclature_id, issued_at);
    CREATE INDEX IF NOT EXISTS ppe_issue_entries_document_idx ON ppe_issue_entries(document_id);

    -- Кладовщик, фаза 2 (0110/0035): новые таблицы (зеркало electron-app/migrate.ts).
    -- Условная доводка долгоживущих БД — JS-блоком после закрытия этого exec.
    CREATE TABLE IF NOT EXISTS ppe_absences (
      id text PRIMARY KEY NOT NULL,
      employee_id text NOT NULL,
      from_ms integer NOT NULL,
      to_ms integer NOT NULL,
      kind text NOT NULL DEFAULT 'vacation',
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE INDEX IF NOT EXISTS ppe_absences_employee_from_idx ON ppe_absences(employee_id, from_ms);
    CREATE TABLE IF NOT EXISTS ppe_groups (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE TABLE IF NOT EXISTS ppe_group_members (
      id text PRIMARY KEY NOT NULL,
      group_id text NOT NULL,
      employee_id text NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ppe_group_members_group_employee_uq ON ppe_group_members(group_id, employee_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS ppe_group_members_group_idx ON ppe_group_members(group_id);
    CREATE TABLE IF NOT EXISTS ppe_group_norms (
      id text PRIMARY KEY NOT NULL,
      group_id text NOT NULL,
      norm_set_id text NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ppe_group_norms_group_set_uq ON ppe_group_norms(group_id, norm_set_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS ppe_group_norms_group_idx ON ppe_group_norms(group_id);
    CREATE TABLE IF NOT EXISTS ppe_collectives (
      id text PRIMARY KEY NOT NULL,
      department_id text NOT NULL,
      warehouse_id text NOT NULL,
      document_id text,
      distributed_at integer,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE INDEX IF NOT EXISTS ppe_collectives_department_idx ON ppe_collectives(department_id);
    CREATE TABLE IF NOT EXISTS ppe_collective_lines (
      id text PRIMARY KEY NOT NULL,
      collective_id text NOT NULL,
      employee_id text NOT NULL,
      nomenclature_id text NOT NULL,
      qty integer NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE INDEX IF NOT EXISTS ppe_collective_lines_collective_idx ON ppe_collective_lines(collective_id);
    -- Конец блока фазы 2. Условная доводка (ADD COLUMN, снос старого индекса,
    -- пересборка entries) — JS-блоком после закрытия этого exec.
    CREATE TABLE IF NOT EXISTS signature_defaults (
      id text PRIMARY KEY NOT NULL,
      field_key text NOT NULL,
      employee_id text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS signature_defaults_field_key_uq ON signature_defaults(field_key) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS signature_defaults_employee_idx ON signature_defaults(employee_id);
  `);

  // Кладовщик, фаза 2 (0110/0035): условная доводка долгоживущих БД
  // (зеркало electron-app/src/main/database/migrate.ts).
  if (await hasTable(sqlite, 'ppe_norm_sets')) {
    const ppeCols = await columnNames('ppe_norm_sets');
    if (!ppeCols.has('gender')) {
      await sqlite.exec(`ALTER TABLE ppe_norm_sets ADD COLUMN gender text;`);
    }
    if (!ppeCols.has('season')) {
      await sqlite.exec(`ALTER TABLE ppe_norm_sets ADD COLUMN season text;`);
    }
    if (!ppeCols.has('is_duty')) {
      await sqlite.exec(`ALTER TABLE ppe_norm_sets ADD COLUMN is_duty integer NOT NULL DEFAULT 0;`);
    }
    // DROP INDEX IF EXISTS через execSQL бросает, если индекса нет, — проверяем
    // через sqlite_master (тот же приём, что ниже у engine_version_uq).
    const oldPostIdx = await sqlite.get(
      `SELECT 1 AS one FROM sqlite_master WHERE type='index' AND name='ppe_norm_sets_post_idx'`,
    );
    if (oldPostIdx) {
      await sqlite.exec(`DROP INDEX ppe_norm_sets_post_idx;`);
    }
    await sqlite.exec(
      `CREATE INDEX IF NOT EXISTS ppe_norm_sets_post_gender_season_idx ON ppe_norm_sets(post_title, gender, season, valid_from);`,
    );
  }
  // ppe_issue_entries.document_id nullable с 0110 — пересборка тем же составом
  // колонок (зеркало десктопа; срабатывает один раз).
  if (await hasTable(sqlite, 'ppe_issue_entries')) {
    const entryInfo = await sqlite.all<{ name: string; notnull: number }>(`PRAGMA table_info(ppe_issue_entries)`);
    const entryDocumentCol = entryInfo.find((c) => c.name === 'document_id');
    if (entryDocumentCol && Number(entryDocumentCol.notnull) === 1) {
      const entryCols = entryInfo.map((c) => c.name).join(', ');
      await sqlite.exec(`
      BEGIN;
      CREATE TABLE ppe_issue_entries_new (
        id text PRIMARY KEY NOT NULL,
        card_id text NOT NULL,
        nomenclature_id text NOT NULL,
        qty integer NOT NULL,
        issued_at integer NOT NULL,
        document_id text,
        created_at integer NOT NULL,
        updated_at integer NOT NULL,
        last_server_seq integer,
        deleted_at integer,
        sync_status text NOT NULL DEFAULT 'synced'
      );
      INSERT INTO ppe_issue_entries_new (${entryCols}) SELECT ${entryCols} FROM ppe_issue_entries;
      DROP TABLE ppe_issue_entries;
      ALTER TABLE ppe_issue_entries_new RENAME TO ppe_issue_entries;
      CREATE INDEX IF NOT EXISTS ppe_issue_entries_card_idx ON ppe_issue_entries(card_id, issued_at);
      CREATE INDEX IF NOT EXISTS ppe_issue_entries_nomenclature_idx ON ppe_issue_entries(nomenclature_id, issued_at);
      CREATE INDEX IF NOT EXISTS ppe_issue_entries_document_idx ON ppe_issue_entries(document_id);
      COMMIT;
      `);
    }
  }

  // Сотрудники СИЗ (0111/PR-6): erp_employee_cards вошла в sync-контракт зеркалом
  // (server-write / pull-only). Таблица приходит из drizzle-цепочки, а sync-хвоста в ней
  // нет — доводим здесь (зеркало десктопа; парити свежей схемы держит drizzleChain.test).
  if (await hasTable(sqlite, 'erp_employee_cards')) {
    const empCols = await columnNames('erp_employee_cards');
    if (!empCols.has('last_server_seq')) {
      await sqlite.exec(`ALTER TABLE erp_employee_cards ADD COLUMN last_server_seq integer;`);
    }
    if (!empCols.has('sync_status')) {
      await sqlite.exec(`ALTER TABLE erp_employee_cards ADD COLUMN sync_status text NOT NULL DEFAULT 'synced';`);
    }
  }

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
        CREATE INDEX IF NOT EXISTS erp_engine_assembly_bom_engine_idx
          ON erp_engine_assembly_bom(engine_nomenclature_id);
        CREATE INDEX IF NOT EXISTS erp_engine_assembly_bom_status_idx
          ON erp_engine_assembly_bom(status);
        COMMIT;
      `);
    }

    // Зеркало правки десктопа (electron-app/src/main/database/migrate.ts): пары
    // (engine_nomenclature_id, version) на сервере НЕ уникальны — в PG такого ограничения
    // нет вообще, колонка устарела. Клиентский UNIQUE делал законные серверные строки
    // непринимаемыми, и pull падал целиком у всего парка (инцидент 18.09.2026, GOTCHAS M142).
    // Android: DROP INDEX IF EXISTS через execSQL бросает SQLiteException, если индекс
    // не существует — проверяем через sqlite_master перед удалением.
    const indexExists = await sqlite.get(
      `SELECT 1 AS one FROM sqlite_master WHERE type='index' AND name='erp_engine_assembly_bom_engine_version_uq'`,
    );
    if (indexExists) {
      await sqlite.exec(`DROP INDEX erp_engine_assembly_bom_engine_version_uq;`);
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
    // parent_nomenclature_id — обобщённая позиция (шаг 12→13); здесь дубль для баз, минующих цепочку.
    if (!cols.has('parent_nomenclature_id')) {
      await sqlite.exec(`ALTER TABLE erp_nomenclature ADD COLUMN parent_nomenclature_id text;`);
    }
    await sqlite.exec(
      `CREATE INDEX IF NOT EXISTS erp_nomenclature_directory_kind_idx ON erp_nomenclature(directory_kind);`,
    );
    // Индекс родителя шаг 12→13 ставит, а свежая установка идёт мимо цепочки — дубль здесь.
    await sqlite.exec(
      `CREATE INDEX IF NOT EXISTS erp_nomenclature_parent_idx ON erp_nomenclature(parent_nomenclature_id);`,
    );
  }

  // Зеркало electron-app/src/main/database/migrate.ts: ежесекундная проба COUNT по
  // sync_status full-scan'ила таблицы реплики без индекса (живой прод 02.10.2026:
  // erp_engine_inventory_lines — 400+мс на каждый тик). Проход по факту — всем таблицам
  // с колонкой sync_status, а не перечислением вручную.
  const syncTables = await sqlite.all<{ name: string }>(
    `SELECT m.name AS name FROM sqlite_master m WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%' AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) p WHERE p.name='sync_status') ORDER BY m.name`,
  );
  for (const row of syncTables) {
    const table = String(row?.name ?? '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) continue;
    await sqlite.exec(`CREATE INDEX IF NOT EXISTS ${table}_sync_status_idx ON ${table}(sync_status);`);
  }
}
