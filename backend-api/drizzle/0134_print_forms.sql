-- Модуль печатных форм (промты КАРМАНА #4/#5, план docs/plans/print-forms-module-2026-11.md).
--
-- Две таблицы:
--
--   - `print_templates` — шаблоны печатных форм с привязкой к ВИДУ ОБЪЕКТА
--     (`entity_key`: карточка СИЗ, карточка двигателя, наряд, списки) и общие/личные;
--   - `print_documents` — документы, созданные по форме (служебная записка, заявление
--     на отпуск), с состояниями приёмки `draft → sent → accepted | rejected`.
--
-- Шаблоны и документы хранятся ОТДЕЛЬНО — как карточки двигателей и карточки деталей.
--
-- Почему НОВАЯ таблица, а не переименование `ppe_print_templates`: та таблица в
-- sync-контракте, её имя живёт в `SyncTableName`, `syncService.ts` и `errorRecovery.ts` —
-- переименование тронет контур доставки, который работает каждый день. Старая таблица
-- остаётся на месте до выпила, её шаблоны переносятся сюда один раз (ниже).
--
-- Обе таблицы живут ВНЕ sync-контракта (прецедент — «Приказ о ценах на услуги»):
-- шаблоны и документы ведут серверные двери, клиент ходит по REST — ровно так же,
-- как уже устроены шаблоны печати СИЗ (`ppe:printTemplates:list` → REST).

CREATE TABLE IF NOT EXISTS print_templates (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL DEFAULT 'shared',
  entity_key text NOT NULL,
  form_key text NOT NULL,
  name text NOT NULL,
  layout_json text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  updated_at bigint NOT NULL,
  updated_by text,
  created_at bigint NOT NULL,
  deleted_at bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS print_templates_owner_entity_form_name_uq
  ON print_templates (owner_id, entity_key, form_key, name) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS print_templates_entity_idx ON print_templates (entity_key);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS print_documents (
  id uuid PRIMARY KEY,
  entity_key text NOT NULL,
  form_key text NOT NULL,
  template_id uuid,
  title text NOT NULL,
  values_json text NOT NULL DEFAULT '{}',
  layout_json text NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'draft',
  author_id text NOT NULL,
  author_username text NOT NULL DEFAULT '',
  recipient_id text,
  recipient_username text,
  note text NOT NULL DEFAULT '',
  decision_note text NOT NULL DEFAULT '',
  decided_at bigint,
  decided_by text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS print_documents_recipient_status_idx
  ON print_documents (recipient_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS print_documents_author_idx ON print_documents (author_id);
--> statement-breakpoint
-- Перенос шаблонов печати СИЗ в общий модуль: entity_key = 'ppe_card' (личная карточка).
-- Только живые строки; удалённые не переносим — их и нельзя выбрать при печати.
INSERT INTO print_templates (
  id, owner_id, entity_key, form_key, name, layout_json, is_default,
  updated_at, updated_by, created_at, deleted_at
)
SELECT
  id, owner_id, 'ppe_card', form_key, name, layout_json, is_default,
  updated_at, updated_by, created_at, deleted_at
FROM ppe_print_templates
WHERE deleted_at IS NULL
ON CONFLICT DO NOTHING;
