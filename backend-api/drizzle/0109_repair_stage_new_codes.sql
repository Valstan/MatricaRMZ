-- Новые этапы линейки 14.10.2026 (слово владельца: канонический порядок):
-- `incoming_otk` («Входной контроль ОТК», автомат акта комплектности, рангом
-- сразу за приёмкой) и `parts_repair` («Ремонт деталей», между разборкой
-- и укладкой, только вручную). Только справочник шаблонов; строки этапов
-- переносит скрипт `stages:backfill`. Все операторы идемпотентны.
INSERT INTO "repair_stage_templates" ("id", "code", "name", "sort_order", "auto_from", "side_branch", "updated_at")
VALUES
  ('9a1f0c1e-0001-4c2a-9c01-000000000012', 'incoming_otk', 'Входной контроль ОТК', 15, 'kittingAct', false, (extract(epoch from now()) * 1000)::bigint),
  ('9a1f0c1e-0001-4c2a-9c01-000000000013', 'parts_repair', 'Ремонт деталей', 30, NULL, false, (extract(epoch from now()) * 1000)::bigint)
ON CONFLICT ("id") DO NOTHING;
