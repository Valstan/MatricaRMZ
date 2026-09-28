-- Шаблон единого списка этапов ремонта (план unified-repair-stages, шаг 5).
-- Таблица НЕ входит в контракт синхронизации, как work_sheet_types:
-- клиент ходит по REST /repair-stage-templates.
-- Строки по умолчанию повторяют состав, утверждённый владельцем 28.09.2026.
CREATE TABLE IF NOT EXISTS "repair_stage_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL,
  "name" text NOT NULL,
  "sort_order" integer NOT NULL DEFAULT 0,
  "auto_from" text,
  "side_branch" boolean NOT NULL DEFAULT false,
  "updated_at" bigint NOT NULL,
  "updated_by" text,
  "archived_at" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "repair_stage_templates_code_uq"
  ON "repair_stage_templates" ("code") WHERE "archived_at" IS NULL;
--> statement-breakpoint
INSERT INTO "repair_stage_templates" ("id", "code", "name", "sort_order", "auto_from", "side_branch", "updated_at")
VALUES
  ('9a1f0c1e-0001-4c2a-9c01-000000000001', 'arrival', 'Принят на завод', 10, NULL, false, (extract(epoch from now()) * 1000)::bigint),
  ('9a1f0c1e-0001-4c2a-9c01-000000000002', 'disassembly_defect', 'Разборка, дефектовка', 20, 'defectAct', false, (extract(epoch from now()) * 1000)::bigint),
  ('9a1f0c1e-0001-4c2a-9c01-000000000003', 'kitting_done', 'Комплектовка сделана', 30, 'kittingAct', false, (extract(epoch from now()) * 1000)::bigint),
  ('9a1f0c1e-0001-4c2a-9c01-000000000004', 'ukladka', 'Укладка', 40, NULL, false, (extract(epoch from now()) * 1000)::bigint),
  ('9a1f0c1e-0001-4c2a-9c01-000000000005', 'sborka', 'Сборка', 50, NULL, false, (extract(epoch from now()) * 1000)::bigint),
  ('9a1f0c1e-0001-4c2a-9c01-000000000006', 'obkatka', 'Обкатка', 60, 'obkatkaRow', false, (extract(epoch from now()) * 1000)::bigint),
  ('9a1f0c1e-0001-4c2a-9c01-000000000007', 'otk', 'Выходной контроль ОТК', 70, NULL, false, (extract(epoch from now()) * 1000)::bigint),
  ('9a1f0c1e-0001-4c2a-9c01-000000000008', 'shipped', 'Отправлен заказчику', 80, NULL, false, (extract(epoch from now()) * 1000)::bigint),
  ('9a1f0c1e-0001-4c2a-9c01-000000000009', 'accepted', 'Принят заказчиком', 90, NULL, false, (extract(epoch from now()) * 1000)::bigint),
  ('9a1f0c1e-0001-4c2a-9c01-000000000010', 'scrap_branch', 'Утиль и брак', 0, NULL, true, (extract(epoch from now()) * 1000)::bigint)
ON CONFLICT ("id") DO NOTHING;
