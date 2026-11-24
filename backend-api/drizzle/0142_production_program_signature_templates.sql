-- Шаблон подписей производственной программы по умолчанию
-- (промт КАРМАНА #120, план #121; владелец 24.11.2026).
--
-- «Сохранённый шаблон подписи для производственной программы… Он сохранился для
-- текущей производственной программы, а мне нужно, чтобы я мог его применить и
-- для последующих… чтобы все следующие: создаётся новая производственная
-- программа, и к ней уже автоматически, по умолчанию, прикрепляется вот эта
-- печатная форма, которую мы доработали».
--
-- Две сущности:
--   1. `production_program_signature_templates` — сам шаблон: общий для завода
--      набор подписей (должность + ФИО + сотрудник), который подставляется в
--      новые программы. Таблица ВНЕ sync-контракта (как `print_templates`):
--      ведёт её только серверная дверь REST, иначе «общий для парка» шаблон
--      разъехался бы по репликам.
--   2. `erp_production_programs.signature_template_id` — ССЫЛКА на шаблон, из
--      которого взяли состав. Ссылка, а не содержимое: `signature_slots` остаётся
--      трёхзначным (`null` — «оператор не трогал блок», `[]` — «снял всё»), и без
--      ссылки нельзя отличить «применён шаблон» от «правлено руками».
--
-- Nullable: у программ, заведённых до шаблона, ссылки нет (NULL).
-- У клиента (реплика Electron и Android) та же nullability — иначе
-- checkReplicaStrictness уронит pull.
--
-- Миграция чисто АДДИТИВНАЯ: данных не трогает, поэтому её откат — обратное
-- удаление колонки и таблицы.

CREATE TABLE IF NOT EXISTS production_program_signature_templates (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL DEFAULT 'shared',
  name text NOT NULL,
  slots text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  updated_at bigint NOT NULL,
  updated_by text,
  created_at bigint NOT NULL,
  deleted_at bigint
);

CREATE UNIQUE INDEX IF NOT EXISTS production_program_signature_templates_owner_name_uq
  ON production_program_signature_templates(owner_id, name)
  WHERE deleted_at IS NULL;

ALTER TABLE erp_production_programs
  ADD COLUMN IF NOT EXISTS signature_template_id uuid;

CREATE INDEX IF NOT EXISTS erp_production_programs_signature_template_idx
  ON erp_production_programs(signature_template_id);

-- Ссылочная целостность: программа не может ссылаться на несуществующий шаблон.
-- Шаблоны удаляются МЯГКО (deleted_at), поэтому ограничение не блокирует работу.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'erp_production_programs_signature_template_fk'
  ) THEN
    ALTER TABLE erp_production_programs
      ADD CONSTRAINT erp_production_programs_signature_template_fk
      FOREIGN KEY (signature_template_id) REFERENCES production_program_signature_templates(id);
  END IF;
END $$;
