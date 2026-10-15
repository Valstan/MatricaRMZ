-- Модуль «Кладовщик» (учёт спецодежды/СИЗ), фаза 2: условия норм (пол/сезон/дежурные),
-- отпуска, группы, коллективная выдача. План: docs/plans/ppe-kladovshik-phase2.md (PR-0).
-- Аддитивно: только ADD COLUMN / CREATE TABLE / ослабление NOT NULL у document_id;
-- данные не трогаем. FK только на уровне приложения (как 0107) — в SQL ограничений
-- нет, чтобы миграция не падала на порядке. `ppe_issue_entries.document_id` → nullable:
-- доввод истории при импорте (запись без документа в системе), решение 4 плана.
-- Групповые привязки — отдельная `ppe_group_norms` (упущена в §2, входит в PR-0 по §4).
ALTER TABLE ppe_norm_sets ADD COLUMN IF NOT EXISTS gender text;
--> statement-breakpoint
ALTER TABLE ppe_norm_sets ADD COLUMN IF NOT EXISTS season text;
--> statement-breakpoint
ALTER TABLE ppe_norm_sets ADD COLUMN IF NOT EXISTS is_duty boolean NOT NULL DEFAULT false;
--> statement-breakpoint
DROP INDEX IF EXISTS ppe_norm_sets_post_idx;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppe_norm_sets_post_gender_season_idx ON ppe_norm_sets (post_title, gender, season, valid_from);
--> statement-breakpoint
ALTER TABLE ppe_issue_entries ALTER COLUMN document_id DROP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ppe_absences (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL,
  from_ms bigint NOT NULL,
  to_ms bigint NOT NULL,
  kind text NOT NULL DEFAULT 'vacation',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppe_absences_employee_from_idx ON ppe_absences (employee_id, from_ms);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ppe_groups (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ppe_group_members (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ppe_group_members_group_employee_uq ON ppe_group_members (group_id, employee_id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppe_group_members_group_idx ON ppe_group_members (group_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ppe_group_norms (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL,
  norm_set_id uuid NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ppe_group_norms_group_set_uq ON ppe_group_norms (group_id, norm_set_id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppe_group_norms_group_idx ON ppe_group_norms (group_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ppe_collectives (
  id uuid PRIMARY KEY,
  department_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  document_id uuid,
  distributed_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppe_collectives_department_idx ON ppe_collectives (department_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ppe_collective_lines (
  id uuid PRIMARY KEY,
  collective_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  nomenclature_id uuid NOT NULL,
  qty integer NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppe_collective_lines_collective_idx ON ppe_collective_lines (collective_id);
