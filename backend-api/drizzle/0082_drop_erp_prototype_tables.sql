-- B0 (план matrica-v4-kickoff, трек B этап 0 «гигиена»): снос мёртвого /erp-прототипа
-- весны 2026. На проде все пять таблиц держат 0 строк (точный count(*) 2026-08-18),
-- маршрут /erp/* и erpService удалены этим же PR. Живой складской контур
-- (erp_nomenclature / erp_document_* / erp_reg_stock_*) НЕ трогается.
--
-- Порядок: сначала регистры с NOT NULL FK на справочники прототипа, затем карточки
-- инструмента (FK на шаблоны), затем сами шаблоны. CASCADE подстраховывает от
-- забытых inbound-FK на средах, где схема дрейфовала.
DROP TABLE IF EXISTS "erp_reg_employee_access";
--> statement-breakpoint
DROP TABLE IF EXISTS "erp_reg_contract_settlement";
--> statement-breakpoint
DROP TABLE IF EXISTS "erp_tool_cards";
--> statement-breakpoint
DROP TABLE IF EXISTS "erp_tool_templates" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "erp_part_templates" CASCADE;
