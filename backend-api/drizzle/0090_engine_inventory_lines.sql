-- Список деталей двигателя построчно (план docs/plans/engine-inventory-lines-2026-09.md, E1).
--
-- До сих пор список целиком жил в operations.meta_json (answers.engine_inventory_items.rows):
-- одна галочка оператора = новая версия всего листа = 48–255 КБ шифротекста в ledger'е.
-- Теперь одна строка = одна деталь одного листа; лист остаётся контейнером прочих ответов.
--
-- Источник строк — JSON листа, а не EAV, поэтому триггеров-зеркал (приём 0052/0083) здесь
-- нет намеренно: парсер payload в PL/pgSQL стал бы вторым источником правил нормализации
-- рядом с shared `normalizeEngineInventoryRow`. Строки выводит сервер (writeSyncChanges →
-- engineInventoryLinesService) при каждой записи листа и разовый бэкфилл.
--
-- part_id без FK: legacy-строки ссылаются на детали разных эпох справочника.
-- Только CREATE — старые сборки таблицу не знают и не должны (LEGACY_SCHEMA_SNAPSHOT_TABLES).

CREATE TABLE IF NOT EXISTS erp_engine_inventory_lines (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES operations(id),
  engine_entity_id uuid NOT NULL REFERENCES entities(id),
  line_key text NOT NULL,
  sort_order integer NOT NULL,
  part_id text,
  brand_managed boolean NOT NULL DEFAULT false,
  part_name text NOT NULL DEFAULT '',
  assembly_unit_number text NOT NULL DEFAULT '',
  part_number text NOT NULL DEFAULT '',
  stamped_number text NOT NULL DEFAULT '',
  bom_variant_group text,
  quantity integer NOT NULL DEFAULT 0,
  present boolean NOT NULL DEFAULT false,
  actual_qty integer NOT NULL DEFAULT 0,
  repairable_qty integer NOT NULL DEFAULT 0,
  scrap_qty integer NOT NULL DEFAULT 0,
  replace_qty integer NOT NULL DEFAULT 0,
  replenishment_branch text,
  scrap_reason text NOT NULL DEFAULT '',
  in_completeness_act boolean,
  in_defect_act boolean,
  in_completeness_act_override boolean,
  in_defect_act_override boolean,
  selected boolean NOT NULL DEFAULT false,
  photos_json text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  last_server_seq bigint,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  CONSTRAINT erp_engine_inventory_lines_branch_ck
    CHECK (replenishment_branch IS NULL OR replenishment_branch IN ('customer', 'repair', 'purchase')),
  CONSTRAINT erp_engine_inventory_lines_qty_ck
    CHECK (quantity >= 0 AND actual_qty >= 0 AND repairable_qty >= 0 AND scrap_qty >= 0 AND replace_qty >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_engine_inventory_lines_operation_order_idx ON erp_engine_inventory_lines (operation_id, sort_order);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_engine_inventory_lines_operation_key_idx ON erp_engine_inventory_lines (operation_id, line_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_engine_inventory_lines_engine_idx ON erp_engine_inventory_lines (engine_entity_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_engine_inventory_lines_part_idx ON erp_engine_inventory_lines (part_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_engine_inventory_lines_seq_idx ON erp_engine_inventory_lines (last_server_seq);
