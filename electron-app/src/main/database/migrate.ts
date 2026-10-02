import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

// ⚠️ Android-клиент держит async-порт этого файла (android-app/src/db/migrate.ts);
// правки в ensureClientSchemaParity/purge зеркаль туда (парити ловит тест android-app
// только по итоговой схеме свежей БД).
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
export function ensureClientSchemaParity(sqlite: Database.Database) {
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

  // users / user_section_access — реплика аккаунтов и доступов по разделам (B3/R3).
  // Та же причина дубля, что у card_drafts и ai_chat_requests: свежая установка
  // базлайнит ClientSchemaVersion и идёт мимо версионной цепочки, а холодный
  // full-sync запросит таблицу и упадёт на «no such table». Реплика НЕ строже
  // сервера (0020_replica_not_stricter), unique логина — частичный, среди живых.
  sqlite.exec(`
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

  // erp_engine_inventory_lines — реплика списка деталей двигателя построчно (план
  // engine-inventory-lines-2026-09, E2.1). Та же причина дубля, что у users выше: свежая
  // установка идёт мимо версионной цепочки, а холодный full-sync запросит таблицу.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS erp_engine_inventory_lines (
      id text PRIMARY KEY NOT NULL,
      operation_id text NOT NULL,
      engine_entity_id text NOT NULL,
      line_key text NOT NULL,
      sort_order integer NOT NULL,
      part_id text,
      brand_managed integer NOT NULL DEFAULT false,
      part_name text NOT NULL DEFAULT '',
      assembly_unit_number text NOT NULL DEFAULT '',
      part_number text NOT NULL DEFAULT '',
      stamped_number text NOT NULL DEFAULT '',
      bom_variant_group text,
      quantity integer NOT NULL DEFAULT 0,
      present integer NOT NULL DEFAULT false,
      actual_qty integer NOT NULL DEFAULT 0,
      repairable_qty integer NOT NULL DEFAULT 0,
      scrap_qty integer NOT NULL DEFAULT 0,
      replace_qty integer NOT NULL DEFAULT 0,
      replenishment_branch text,
      scrap_reason text NOT NULL DEFAULT '',
      in_completeness_act integer,
      in_defect_act integer,
      in_completeness_act_override integer,
      in_defect_act_override integer,
      has_own_number integer,
      has_own_number_override integer,
      selected integer NOT NULL DEFAULT false,
      photos_json text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE INDEX IF NOT EXISTS erp_engine_inventory_lines_operation_order_idx ON erp_engine_inventory_lines(operation_id, sort_order);
    CREATE INDEX IF NOT EXISTS erp_engine_inventory_lines_engine_idx ON erp_engine_inventory_lines(engine_entity_id);
    CREATE INDEX IF NOT EXISTS erp_engine_inventory_lines_part_idx ON erp_engine_inventory_lines(part_id);
  `);

  // has_own_number / has_own_number_override («свой номер», 22.09.2026) — добавлены в уже
  // существующую реплику клиентской миграцией 0026. Здесь тот же ALTER под проверкой наличия:
  // SQLite не знает ADD COLUMN IF NOT EXISTS, а повторный ALTER уронил бы транзакцию миграции.
  {
    const cols = columnNames('erp_engine_inventory_lines');
    if (!cols.has('has_own_number')) {
      sqlite.exec(`ALTER TABLE erp_engine_inventory_lines ADD COLUMN has_own_number integer;`);
    }
    if (!cols.has('has_own_number_override')) {
      sqlite.exec(`ALTER TABLE erp_engine_inventory_lines ADD COLUMN has_own_number_override integer;`);
    }
  }

  // warehouse_locations — реплика справочника складов и цехов (pull-only, 07.09.2026). Та же
  // причина дубля, что у таблиц выше: свежая установка идёт мимо версионной цепочки, а холодный
  // full-sync запросит таблицу. Реплика не строже сервера (0020): ни CHECK по type, ни unique
  // по code здесь не повторяем.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS warehouse_locations (
      id text PRIMARY KEY NOT NULL,
      type text NOT NULL,
      code text NOT NULL,
      name text NOT NULL,
      workshop_id text,
      is_active integer NOT NULL DEFAULT true,
      sort_order integer NOT NULL DEFAULT 0,
      metadata_json text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE INDEX IF NOT EXISTS warehouse_locations_type_idx ON warehouse_locations(type);
    CREATE INDEX IF NOT EXISTS warehouse_locations_code_idx ON warehouse_locations(code);
  `);

  // erp_counterparties / erp_contracts / directory_engine_brands — реплики словарных
  // зеркал (pull-only, план sync-mirror-dictionaries-2026-10). Та же причина дубля, что
  // у таблиц выше: свежая установка идёт мимо версионной цепочки, а холодный full-sync
  // запросит таблицы. Реплика не строже сервера (0020): повторяем ровно серверную
  // nullability, без добавок.
  //
  // Прототипная 0006 создавала одноимённые erp_counterparties/erp_contracts другой формы
  // (0021 их не сносила). Сносим только прототип (маркер — колонка `code`, которой нет
  // в каноне), живую реплику не трогаем: parity гоняется на каждом старте, и безусловный
  // DROP стирал бы справочник до первого pull'а. Данные терять нечего: прототипные таблицы
  // никогда не входили в sync-контракт и всегда пусты.
  {
    for (const table of ['erp_counterparties', 'erp_contracts'] as const) {
      if (hasTable(table) && columnNames(table).has('code')) {
        sqlite.exec(`DROP TABLE IF EXISTS ${table};`);
      }
    }
  }
  sqlite.exec(`
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
  `);

  // chat_rooms — комнаты чата (владелец 08.09.2026). Та же причина дубля, что у таблиц выше:
  // свежая установка идёт мимо версионной цепочки, а холодный full-sync запросит таблицу.
  // Горячий путь синка и списков: ежесекундная проба COUNT по sync_status и полный скан
  // списка двигателей. Базы, прошедшие старые цепочки миграций мимо этих индексов,
  // платили full-scan'ом на каждый тик — чиним ниже динамическим проходом по всем
  // таблицам с колонкой sync_status, идемпотентно. Колонку проверяем: таблица без
  // sync_status индекс не примет, а уронить старт клиента нельзя.
  // entity_types.code читается точечно по маленькой таблице — полный скан там не больно.
  // Уникальные не трогаем вовсе: в диких базах встречались дубли (entity, attr) —
  // CREATE UNIQUE уронил бы старт клиента, а для скорости важен только sync_status.
  if (hasTable('operations')) {
    sqlite.exec(
      `CREATE INDEX IF NOT EXISTS operations_type_deleted_updated_idx ON operations(operation_type, deleted_at, updated_at);`,
    );
    sqlite.exec(
      `CREATE INDEX IF NOT EXISTS operations_engine_type_idx ON operations(engine_entity_id, operation_type);`,
    );
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS chat_rooms (
      id text PRIMARY KEY NOT NULL,
      owner_user_id text NOT NULL,
      title text NOT NULL,
      members_json text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE INDEX IF NOT EXISTS chat_rooms_sync_status_idx ON chat_rooms(sync_status);
  `);

  // chat_messages.room_id — адрес комнаты. SQLite не знает ADD COLUMN IF NOT EXISTS, поэтому
  // проверяем наличие сами: повторный ALTER уронил бы всю транзакцию миграции.
  if (hasTable('chat_messages')) {
    if (!columnNames('chat_messages').has('room_id')) {
      sqlite.exec(`ALTER TABLE chat_messages ADD COLUMN room_id text;`);
    }
    sqlite.exec(`CREATE INDEX IF NOT EXISTS chat_messages_room_idx ON chat_messages(room_id);`);
  }

  // erp_document_lines.nomenclature_id — добавлен через clientSchemaMigrations 3->4.
  if (hasTable('erp_document_lines')) {
    if (!columnNames('erp_document_lines').has('nomenclature_id')) {
      sqlite.exec(`ALTER TABLE erp_document_lines ADD COLUMN nomenclature_id text;`);
    }
    sqlite.exec(
      `CREATE INDEX IF NOT EXISTS erp_document_lines_nomenclature_idx ON erp_document_lines(nomenclature_id);`,
    );
  }

  // erp_engine_assembly_bom.engine_nomenclature_id — на сервере колонка nullable
  // (BOM может быть привязан только к маркам через brand_links, без конкретной
  // номенклатуры двигателя), но клиентский drizzle 0009 создал её NOT NULL.
  // Живые серверные BOM с NULL валили pull у всех клиентов
  // (SQLITE_CONSTRAINT_NOTNULL, critical-events 2026-07). ALTER не умеет снять
  // NOT NULL → пересборка таблицы тем же составом колонок.
  if (hasTable('erp_engine_assembly_bom')) {
    const info = sqlite
      .prepare(`PRAGMA table_info(erp_engine_assembly_bom)`)
      .all() as Array<{ name: string; notnull: number }>;
    const engineCol = info.find((c) => c.name === 'engine_nomenclature_id');
    if (engineCol && engineCol.notnull === 1) {
      const cols = info.map((c) => c.name).join(', ');
      sqlite.exec(`
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

    // Пары (engine_nomenclature_id, version) на сервере НЕ уникальны: колонка устарела
    // (марки BOM переехали в erp_engine_assembly_bom_brand_links), и в PG такого
    // ограничения нет ВООБЩЕ. Клиентский UNIQUE делал пару строк, законных на сервере,
    // физически непринимаемой — и любой pull, который их вёз, падал целиком:
    // `UNIQUE constraint failed: erp_engine_assembly_bom.engine_nomenclature_id, .version`.
    //
    // Индекс уже снимают версионные миграции (clientSchemaMigrations 4->5 и 8->9), но
    // пересборка выше создавала его заново, а свежая установка базлайнит версию и цепочку
    // пропускает. Поэтому снос здесь — безусловный и идемпотентный: он и есть то место,
    // где чинится долгоживущая БД, до sync и до логина.
    //
    // Это ВТОРОЙ инцидент того же вида на этой же таблице: в июле 2026 клиентский NOT NULL
    // на той же колонке так же валил pull у всего парка (см. комментарий к пересборке выше).
    // Общее правило — ограничение на клиенте не может быть строже серверного: сервер решает,
    // какие строки законны, клиент обязан суметь их принять (GOTCHAS M142).
    // Android: DROP INDEX IF EXISTS через execSQL бросает SQLiteException, если индекс
    // не существует — проверяем через sqlite_master перед удалением.
    const indexExists = sqlite.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='index' AND name='erp_engine_assembly_bom_engine_version_uq'`,
    ).get();
    if (indexExists) {
      sqlite.exec(`DROP INDEX erp_engine_assembly_bom_engine_version_uq;`);
    }
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
    // parent_nomenclature_id — обобщённая позиция (шаг 12→13); здесь дубль для баз, минующих цепочку.
    if (!cols.has('parent_nomenclature_id')) {
      sqlite.exec(`ALTER TABLE erp_nomenclature ADD COLUMN parent_nomenclature_id text;`);
    }
    sqlite.exec(
      `CREATE INDEX IF NOT EXISTS erp_nomenclature_directory_kind_idx ON erp_nomenclature(directory_kind);`,
    );
    // Индекс родителя шаг 12→13 ставит, а свежая установка идёт мимо цепочки — дубль здесь.
    sqlite.exec(
      `CREATE INDEX IF NOT EXISTS erp_nomenclature_parent_idx ON erp_nomenclature(parent_nomenclature_id);`,
    );
  }

  // Ежесекундная проба COUNT по sync_status (SyncManager.localWatchTick) full-scan'ила
  // таблицы реплики без индекса — поймано живьём 02.10.2026: erp_engine_inventory_lines
  // давал 400+мс на каждый тик у всего парка, а better-sqlite3 синхронный, то есть main
  // стоял. Перечислением не покрыть — новые таблицы снова приедут без индекса; идём по
  // факту: всем таблицам с колонкой sync_status. Имена те же, что давались вручную
  // раньше, — существующие индексы переиспользуются, а не дублируются. Стоит последним:
  // выше есть пересборки таблиц (erp_engine_assembly_bom), которые сносят индексы.
  const syncStatusTables = (
    sqlite.prepare(
      `SELECT m.name AS name FROM sqlite_master m WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%' AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) p WHERE p.name='sync_status') ORDER BY m.name`,
    ).all() as Array<{ name: string }>
  ).map((r) => String(r.name));
  for (const table of syncStatusTables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) continue;
    sqlite.exec(`CREATE INDEX IF NOT EXISTS ${table}_sync_status_idx ON ${table}(sync_status);`);
  }
}
