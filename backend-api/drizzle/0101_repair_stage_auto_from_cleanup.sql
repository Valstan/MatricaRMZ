-- Шаг 8 плана unified-repair-stages: источник автопростановки «Строка обкатки»
-- мёртв (создание строк этапов работ закрыто, обкатка отмечается вручную из
-- карточки). Гасим badge «автомат» у «Обкатки», чтобы шаблон не обещал
-- несуществующей автоматики. Остальные источники (defectAct, kittingAct)
-- проведены кодом и остаются.
UPDATE "repair_stage_templates" SET "auto_from" = NULL, "updated_at" = (extract(epoch from now()) * 1000)::bigint WHERE "auto_from" = 'obkatkaRow';
