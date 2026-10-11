-- Модуль «Кладовщик» (учёт спецодежды/СИЗ), MVP: нормы выдачи, личные карточки, факты выдачи.
-- План: C:\Users\valstan\.opencode\plan\ppe-kladovshik-mvp.md (PR-0).
-- Решения: размер = позиция erp_nomenclature (category='workwear', связь через
-- parent_nomenclature_id); нормы версионируются (valid_from/valid_to); каждая выдача
-- ссылается на erp_document_headers (документ stock_issue). FK только на уровне
-- приложения (как 0105) — в SQL ограничений нет, чтобы миграция не падала на порядке.
-- sync_status/last_server_seq — для pull-only паблишера (образец: directory_* из 0102).

CREATE TABLE IF NOT EXISTS ppe_norm_sets (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  post_title text,
  department_id uuid,
  valid_from bigint NOT NULL,
  valid_to bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ppe_norm_lines (
  id uuid PRIMARY KEY,
  norm_set_id uuid NOT NULL,
  nomenclature_id uuid NOT NULL,
  qty integer NOT NULL,
  wear_months integer NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ppe_issue_cards (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL,
  opened_at bigint NOT NULL,
  closed_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ppe_card_norms (
  id uuid PRIMARY KEY,
  card_id uuid NOT NULL,
  norm_set_id uuid NOT NULL,
  assigned_at bigint NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ppe_issue_entries (
  id uuid PRIMARY KEY,
  card_id uuid NOT NULL,
  nomenclature_id uuid NOT NULL,
  qty integer NOT NULL,
  issued_at bigint NOT NULL,
  document_id uuid NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppe_norm_sets_post_idx ON ppe_norm_sets (post_title, valid_from);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppe_norm_sets_department_idx ON ppe_norm_sets (department_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ppe_norm_lines_set_nomenclature_uq ON ppe_norm_lines (norm_set_id, nomenclature_id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppe_norm_lines_set_idx ON ppe_norm_lines (norm_set_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppe_norm_lines_nomenclature_idx ON ppe_norm_lines (nomenclature_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ppe_issue_cards_employee_open_uq ON ppe_issue_cards (employee_id) WHERE closed_at IS NULL AND deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppe_issue_cards_employee_idx ON ppe_issue_cards (employee_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ppe_card_norms_card_set_uq ON ppe_card_norms (card_id, norm_set_id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppe_card_norms_card_idx ON ppe_card_norms (card_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppe_issue_entries_card_idx ON ppe_issue_entries (card_id, issued_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppe_issue_entries_nomenclature_idx ON ppe_issue_entries (nomenclature_id, issued_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppe_issue_entries_document_idx ON ppe_issue_entries (document_id);
