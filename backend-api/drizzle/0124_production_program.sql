-- Производственная программа (ПП): шапка плана производства и его строки.
--
-- Модуль плана производства на две недели/месяц по Word-форме «ПП Цех № 1»
-- (план docs/plans/proizvodstvennaya-programma-2026-11.md).
--
-- Ведёт только серверная дверь (productionProgramService, REST), клиент читает
-- реплику (server-write / pull-only, владение таблиц — в shared/domain/ledgerAuthz):
-- запись строки sync_status='pending', публикатор зеркала доводит её до журнала.
-- sync_status/last_server_seq — для pull-only палицы (как ppe_* из 0107).

CREATE TABLE IF NOT EXISTS erp_production_programs (
  id uuid PRIMARY KEY,
  period_start bigint NOT NULL,
  period_end bigint NOT NULL,
  shop text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  signature_slots text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_production_programs_period_idx ON erp_production_programs (period_start);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_production_programs_shop_idx ON erp_production_programs (shop);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS erp_production_program_rows (
  id uuid PRIMARY KEY,
  program_id uuid NOT NULL,
  order_no integer NOT NULL,
  contract_id uuid,
  group_label text NOT NULL,
  contract_kind text,
  engine_id uuid,
  engine_mark text NOT NULL,
  engine_number text NOT NULL,
  state text,
  shipping_plan_at bigint,
  factors text NOT NULL,
  note text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_production_program_rows_program_idx ON erp_production_program_rows (program_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS erp_production_program_rows_order_uq
    ON erp_production_program_rows (program_id, order_no)
    WHERE deleted_at IS NULL;
--> statement-breakpoint
-- Новые коды прав в справочник permissions. Роль оператора получает их из каталога
-- (shared/domain/permissions.ts), но матрица прав в админке читает ТАБЛИЦУ — без строк
-- здесь новые права нельзя было бы выдать вручную до отдельного perm:seed.
INSERT INTO permissions (code, description, created_at)
VALUES
  ('production_program.view', 'Просмотр производственной программы (ПП)', 1794268800000),
  ('production_program.edit', 'Ведение производственной программы (ПП)', 1794268800000)
ON CONFLICT (code) DO NOTHING;
