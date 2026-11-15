-- Детский модуль и организационный модуль (план docs/plans/children-and-organization-modules-2026-11.md).
--
-- Три строгие таблицы: карточка ребёнка сотрудника, мероприятие и журнал выдачи
-- подарков, призов и грамот. EAV под заморожкой (AGENTS.md §EAV), а у ребёнка свои
-- фильтры и свои отчёты — значит, отдельная сущность, а не атрибут сотрудника.
--
-- Ведёт только серверная дверь (childrenService / organizationService, REST), клиент
-- читает реплику (server-write / pull-only, владение таблиц — в shared/domain/ledgerAuthz):
-- запись строки sync_status='pending', публикатор зеркала доводит её до журнала.
--
-- Возраст ребёнка НЕ хранится — считается от birth_date в домене. Статус «серенький»
-- тоже не хранится: выводится из статуса занятости родителя, иначе разъедется.

CREATE TABLE IF NOT EXISTS erp_employee_children (
  id uuid PRIMARY KEY,
  employee_id uuid,
  full_name text NOT NULL,
  birth_date bigint,
  gender text NOT NULL DEFAULT '',
  tags_json text,
  note text NOT NULL DEFAULT '',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_employee_children_employee_idx ON erp_employee_children (employee_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_employee_children_birth_idx ON erp_employee_children (birth_date);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS erp_org_events (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  kind text NOT NULL DEFAULT 'other',
  event_date bigint,
  description text NOT NULL DEFAULT '',
  selections_json text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_org_events_date_idx ON erp_org_events (event_date);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS erp_gift_records (
  id uuid PRIMARY KEY,
  event_id uuid,
  recipient_kind text NOT NULL DEFAULT 'child',
  recipient_employee_id uuid,
  recipient_child_id uuid,
  kind text NOT NULL DEFAULT 'gift',
  title text NOT NULL DEFAULT '',
  place text NOT NULL DEFAULT '',
  given_at bigint,
  note text NOT NULL DEFAULT '',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_gift_records_event_idx ON erp_gift_records (event_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_gift_records_child_idx ON erp_gift_records (recipient_child_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_gift_records_employee_idx ON erp_gift_records (recipient_employee_id);
--> statement-breakpoint
-- Новые коды прав в справочник permissions: матрица прав в админке читает ТАБЛИЦУ —
-- без строк здесь новые права нельзя было бы выдать вручную до отдельного perm:seed.
INSERT INTO permissions (code, description, created_at)
VALUES
  ('children.view', 'Просмотр карточек детей', 1794700800000),
  ('children.edit', 'Ведение карточек детей', 1794700800000),
  ('organization.view', 'Просмотр организационного модуля', 1794700800000),
  ('organization.edit', 'Ведение организационного модуля', 1794700800000)
ON CONFLICT (code) DO NOTHING;
