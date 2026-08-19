-- B0: реплики мёртвого /erp-прототипа. Ни одна из этих таблиц никогда не синкалась
-- (dead erp:* handlers сняты 2026-07-25, серверные таблицы пусты и дропнуты миграцией
-- backend 0082) — локально они всегда пусты. Дропаем вместе с их индексами.
DROP TABLE IF EXISTS `erp_reg_employee_access`;--> statement-breakpoint
DROP TABLE IF EXISTS `erp_reg_contract_settlement`;--> statement-breakpoint
DROP TABLE IF EXISTS `erp_reg_part_usage`;--> statement-breakpoint
DROP TABLE IF EXISTS `erp_tool_cards`;--> statement-breakpoint
DROP TABLE IF EXISTS `erp_tool_templates`;--> statement-breakpoint
DROP TABLE IF EXISTS `erp_part_cards`;--> statement-breakpoint
DROP TABLE IF EXISTS `erp_part_templates`;
