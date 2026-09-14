-- Ведомости работ (владелец 15.09.2026): справочник УЗЛОВ — видов ведомостей (укладка, вал,
-- обкатка, сборка, …), каждый со своим набором колонок и признаком «строка завершает ремонт».
-- Таблица НЕ входит в контракт синхронизации (как work_order_templates и service_price_orders):
-- клиент ходит по REST /work-sheet-types, строки ведомостей самоописываемы и живут в operations.
-- Узлы по умолчанию заводятся с фиксированными id (shared DEFAULT_WORK_SHEET_TYPES), чтобы стенды
-- и прод давали одни ссылки; повтор миграции безвреден.
CREATE TABLE IF NOT EXISTS "work_sheet_types" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL,
  "name" text NOT NULL,
  "workshop_id" text,
  "completes_repair" boolean NOT NULL DEFAULT false,
  "columns_json" text NOT NULL DEFAULT '[]',
  "sort_order" integer NOT NULL DEFAULT 0,
  "updated_at" bigint NOT NULL,
  "updated_by" text,
  "archived_at" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "work_sheet_types_code_uq"
  ON "work_sheet_types" ("code") WHERE "archived_at" IS NULL;
--> statement-breakpoint
INSERT INTO "work_sheet_types" ("id", "code", "name", "completes_repair", "columns_json", "sort_order", "updated_at")
VALUES
  ('7a1f0c1e-0001-4c2a-9c01-000000000001', 'ukladka', 'Укладка', false, '[]', 10, (extract(epoch from now()) * 1000)::bigint),
  ('7a1f0c1e-0001-4c2a-9c01-000000000002', 'val', 'Вал', false, '[]', 20, (extract(epoch from now()) * 1000)::bigint),
  ('7a1f0c1e-0001-4c2a-9c01-000000000003', 'sborka', 'Сборка', false, '[]', 30, (extract(epoch from now()) * 1000)::bigint),
  ('7a1f0c1e-0001-4c2a-9c01-000000000004', 'obkatka', 'Обкатка', true, '[{"code":"hours","label":"Часы обкатки","type":"number"}]', 40, (extract(epoch from now()) * 1000)::bigint)
ON CONFLICT ("id") DO NOTHING;
