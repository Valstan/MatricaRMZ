-- План engine-spec-position-variants-2026-07: модель «Позиции + взаимозаменяемые варианты».
-- Аддитивные колонки на erp_engine_assembly_bom_lines. Обратная совместимость:
-- существующая строка = позиция-одиночка с одним основным вариантом (is_default_option=true).
--   position_key      — группирует строки-варианты в одну позицию (в рамках bom_id + variant_group). NULL = одиночка.
--   position_label    — человекочитаемое имя позиции («Картер верхний»), отдельно от имени детали.
--   is_default_option — основной вариант позиции (идёт в прогноз и сборку). Ровно один true на позицию.
ALTER TABLE "erp_engine_assembly_bom_lines" ADD COLUMN IF NOT EXISTS "position_key" text;
--> statement-breakpoint
ALTER TABLE "erp_engine_assembly_bom_lines" ADD COLUMN IF NOT EXISTS "position_label" text;
--> statement-breakpoint
ALTER TABLE "erp_engine_assembly_bom_lines" ADD COLUMN IF NOT EXISTS "is_default_option" boolean NOT NULL DEFAULT true;
