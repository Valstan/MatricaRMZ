-- Состав этапов 05.10.2026 (таблица 9 этапов, решения владельца): `kitting_done`
-- сносится слиянием в `arrival` («Приемка двигателя на завод»); №1 — `card_created`;
-- имена линейки — по таблице. Строки этапов мигрируют отдельно скриптом данных;
-- здесь только справочник шаблонов. Все операторы идемпотентны (повторный накат
-- ничего не меняет).
INSERT INTO "repair_stage_templates" ("id", "code", "name", "sort_order", "auto_from", "side_branch", "updated_at")
VALUES
  ('9a1f0c1e-0001-4c2a-9c01-000000000011', 'card_created', 'Создание карточки двигателя', 5, NULL, false, (extract(epoch from now()) * 1000)::bigint)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
UPDATE "repair_stage_templates" SET "name" = 'Приемка двигателя на завод', "auto_from" = 'kittingAct', "updated_at" = (extract(epoch from now()) * 1000)::bigint WHERE "code" = 'arrival' AND "archived_at" IS NULL;
--> statement-breakpoint
UPDATE "repair_stage_templates" SET "name" = 'Разборка/Дефектовка', "updated_at" = (extract(epoch from now()) * 1000)::bigint WHERE "code" = 'disassembly_defect' AND "archived_at" IS NULL;
--> statement-breakpoint
UPDATE "repair_stage_templates" SET "name" = 'Укладка вала', "updated_at" = (extract(epoch from now()) * 1000)::bigint WHERE "code" = 'ukladka' AND "archived_at" IS NULL;
--> statement-breakpoint
UPDATE "repair_stage_templates" SET "name" = 'Сборка двигателя', "updated_at" = (extract(epoch from now()) * 1000)::bigint WHERE "code" = 'sborka' AND "archived_at" IS NULL;
--> statement-breakpoint
UPDATE "repair_stage_templates" SET "name" = 'Обкатка двигателя', "updated_at" = (extract(epoch from now()) * 1000)::bigint WHERE "code" = 'obkatka' AND "archived_at" IS NULL;
--> statement-breakpoint
UPDATE "repair_stage_templates" SET "name" = 'Отгрузка двигателя заказчику', "updated_at" = (extract(epoch from now()) * 1000)::bigint WHERE "code" = 'shipped' AND "archived_at" IS NULL;
--> statement-breakpoint
UPDATE "repair_stage_templates" SET "name" = 'Приемка двигателя заказчиком', "updated_at" = (extract(epoch from now()) * 1000)::bigint WHERE "code" = 'accepted' AND "archived_at" IS NULL;
--> statement-breakpoint
UPDATE "repair_stage_templates" SET "archived_at" = (extract(epoch from now()) * 1000)::bigint WHERE "code" = 'kitting_done' AND "archived_at" IS NULL;
