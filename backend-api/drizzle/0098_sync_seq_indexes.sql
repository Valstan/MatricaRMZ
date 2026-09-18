-- Индексы по номеру журнала для всех синкаемых таблиц.
--
-- Инкрементальный pull (`pullChangesSince`) отбирает строки условием `last_server_seq > since`
-- по КАЖДОЙ синкаемой таблице. Индекса на этой колонке до сих пор не было почти нигде: один
-- pull означал последовательное чтение ~75 тыс. строк (attribute_values 46k, audit_log 11k,
-- operations 7k, entities 5.8k, …) — и это на каждого клиента. При интервале синка в 5 минут
-- цена терялась в фоне; с мгновенной доставкой (ждущий запрос `/ledger/state/wait`) клиенты
-- pull'ят на каждое изменение, и такая цена стала бы заметной на глаз.
--
-- С индексом «после моего курсора ничего нет» — это спуск по B-дереву, а не чтение таблицы.
--
-- CONCURRENTLY не используем намеренно: мигратор drizzle гонит шаги в транзакции, а
-- CREATE INDEX CONCURRENTLY в транзакции запрещён. Обычный CREATE INDEX держит SHARE-замок
-- (чтения не блокирует, запись — на время построения); самая крупная таблица здесь 46 тыс.
-- строк, это доли секунды, и шаг идёт в окне выката.
--
-- Имя индекса — `<таблица>_seq_idx`, как у четырёх уже существующих
-- (users, user_section_access, warehouse_locations, erp_engine_inventory_lines).
CREATE INDEX IF NOT EXISTS entity_types_seq_idx ON entity_types (last_server_seq);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS entities_seq_idx ON entities (last_server_seq);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS attribute_defs_seq_idx ON attribute_defs (last_server_seq);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS attribute_values_seq_idx ON attribute_values (last_server_seq);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS operations_seq_idx ON operations (last_server_seq);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_log_seq_idx ON audit_log (last_server_seq);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chat_messages_seq_idx ON chat_messages (last_server_seq);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chat_reads_seq_idx ON chat_reads (last_server_seq);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chat_rooms_seq_idx ON chat_rooms (last_server_seq);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_presence_seq_idx ON user_presence (last_server_seq);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notes_seq_idx ON notes (last_server_seq);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS note_shares_seq_idx ON note_shares (last_server_seq);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS card_drafts_seq_idx ON card_drafts (last_server_seq);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ai_chat_requests_seq_idx ON ai_chat_requests (last_server_seq);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_nomenclature_seq_idx ON erp_nomenclature (last_server_seq);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_engine_assembly_bom_seq_idx ON erp_engine_assembly_bom (last_server_seq);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_engine_assembly_bom_lines_seq_idx ON erp_engine_assembly_bom_lines (last_server_seq);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_engine_assembly_bom_brand_links_seq_idx ON erp_engine_assembly_bom_brand_links (last_server_seq);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_engine_instances_seq_idx ON erp_engine_instances (last_server_seq);
