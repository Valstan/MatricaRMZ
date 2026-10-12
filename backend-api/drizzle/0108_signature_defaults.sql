-- Умолчания подписей (план favorites-work-stages-defaults-2026-10, PR-5):
-- ключ поля подписи (id пункта акта, напр. 'defect_signed_by') → сотрудник.
-- Храним id работника, ФИО резолвится на чтении. EAV-freeze: строгая таблица.
-- Ведёт только админская дверь (REST), клиент читает реплику (владение server):
-- запись ставит sync_status='pending', публикатор зеркала доводит до журнала.
-- sync_status/last_server_seq — для pull-only паблишера (образец: ppe_* из 0107).

CREATE TABLE IF NOT EXISTS signature_defaults (
  id uuid PRIMARY KEY,
  field_key text NOT NULL,
  employee_id uuid,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS signature_defaults_field_key_uq ON signature_defaults (field_key) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS signature_defaults_employee_idx ON signature_defaults (employee_id);
