-- Сид приказа о СИЗ (Минтруд 767н, Приложение №1): профессии, строки норм,
-- наборы норм и справочник номенклатуры СИЗ.
--
-- Сгенерировано помощником `backend-api/scripts/generate-ppe-order-data.mjs` из
-- документа «РМЗ Приказ о СИЗ (приложения).doc»; источник правды по данным —
-- `backend-api/src/data/ppeOrderNorms767.ts` (если файлы разошлись — правьте
-- генератор и документ, а не этот SQL).
--
-- Идемпотентно: фиксированные UUID + ON CONFLICT DO NOTHING. Повторный прогон
-- безвреден. Норма приказа (количество, единица, форма срока) разбирается
-- доменом `parseOrderNormQty` и в SQL не дублируется — здесь лежит РОВНО ТО,
-- что написано в документе.
-- Новых профессий в этой миграции нет.
--> statement-breakpoint
-- 2. Строки нормы приказа («приказные» строки): наименование, тип СИЗ, норма
-- как написана в документе, привязка к профессии и источнику (ЕТН 767н, 766н или заводская норма).
INSERT INTO ppe_norm_line_specs (id, occupation_id, name, ppe_type, qty, unit, wear_kind, wear_months, sort_order, source_ref, source_kind, source_label, created_at, updated_at, sync_status)
VALUES
  ('aeedebb9-6c1c-59c9-a55c-cf1e3bb32dd1', '16be8a92-80db-5b4e-a691-334af36d8bff', 'Противошумные вкладыши (беруши) или противошумные наушники, включая активные, и их комплектующие', 'Средства защиты органа слуха', 1, 'шт.', 'by_manufacturer', NULL, 9, 'определяется документами изготовителя', 'ton', 'Пункт № 4872', 1767225600000, 1767225600000, 'synced'),
  ('cf6a9127-cea8-5e64-a406-4a935b9d79f8', 'ec6b139c-13e9-5c52-a8a1-84c671de3d16', 'Противошумные вкладыши (беруши) или противошумные наушники, включая активные, и их комплектующие', 'Средства защиты органа слуха', 1, 'шт.', 'by_manufacturer', NULL, 9, 'определяется документами изготовителя', 'ton', 'Пункт № 5066', 1767225600000, 1767225600000, 'synced'),
  ('7ffe64a5-afb6-586f-a8c1-80b594ae60a3', '6432ce1a-9642-5ae2-a170-b47b96d9dcae', 'Противошумные вкладыши (беруши) или противошумные наушники, включая активные, и их комплектующие', 'Средства защиты органа слуха', 1, 'шт.', 'by_manufacturer', NULL, 10, 'определяется документами изготовителя', 'ton', 'Пункт № 5160', 1767225600000, 1767225600000, 'synced'),
  ('1115bb81-a3fe-52b0-a933-8f90c08f8100', 'ce84ecdb-5e0c-5cd1-afb6-63ccdd13f86a', 'Средства индивидуальной защиты органов дыхания с принудительной подачей воздуха — У-2К', 'Средства защиты органов дыхания', 1, 'шт.', 'until_wearout', NULL, 3, 'до износа', 'local', 'Заводская норма (решение владельца 17.11.2026)', 1767225600000, 1767225600000, 'synced') ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
-- 3. Новых наборов норм в этой миграции нет.
--> statement-breakpoint
-- 4. Строки наборов норм: привязка строки приказа к базовой позиции
-- номенклатуры и к «приказной» строке (spec_id). Размер сотрудника подставляется
-- при выдаче — дерево «база → размеры», поэтому в норме лежит базовая модель.
INSERT INTO ppe_norm_lines (id, norm_set_id, nomenclature_id, qty, wear_months, spec_id, unit, wear_kind, created_at, updated_at, sync_status)
VALUES
  ('8fa4e5cc-ca32-59d5-aacc-045a25258401', '27847a2b-3f88-54c9-a2cc-5a467599b5e5', '7750e458-c09f-5571-ab07-5993e765e241', 1, NULL, 'aeedebb9-6c1c-59c9-a55c-cf1e3bb32dd1', 'шт.', 'by_manufacturer', 1767225600000, 1767225600000, 'synced'),
  ('81dad627-fd72-5506-a163-1b6f43a16b53', 'bed8d849-a652-5eb9-a67d-be727b478c03', '7750e458-c09f-5571-ab07-5993e765e241', 1, NULL, 'cf6a9127-cea8-5e64-a406-4a935b9d79f8', 'шт.', 'by_manufacturer', 1767225600000, 1767225600000, 'synced'),
  ('eead396e-9635-5756-aceb-a3600282fa19', 'b8d533ca-b3e8-59fe-a7c9-5be0427630f1', '7750e458-c09f-5571-ab07-5993e765e241', 1, NULL, '7ffe64a5-afb6-586f-a8c1-80b594ae60a3', 'шт.', 'by_manufacturer', 1767225600000, 1767225600000, 'synced'),
  ('a6e1c562-f199-5e7d-a5ea-c31d2a753476', '7b868878-f384-5720-af1b-eaafa850b79e', '55af538a-8988-5ef6-a53a-a24f7261278c', 1, NULL, '1115bb81-a3fe-52b0-a933-8f90c08f8100', 'шт.', 'until_wearout', 1767225600000, 1767225600000, 'synced') ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
-- 5. Привязка «приказная строка → базовая позиция номенклатуры». Это ключ
-- подстановки: привязал позицию один раз — карточка сама подставляет наименование,
-- единицу измерения, количество и пункт приложения.
UPDATE ppe_norm_line_specs s
   SET nomenclature_id = n.nomenclature_id
  FROM (
    SELECT spec_id, nomenclature_id FROM ppe_norm_lines
     WHERE deleted_at IS NULL AND spec_id IS NOT NULL
  ) n
 WHERE s.id = n.spec_id AND s.nomenclature_id IS NULL
   AND s.id IN ('aeedebb9-6c1c-59c9-a55c-cf1e3bb32dd1', 'cf6a9127-cea8-5e64-a406-4a935b9d79f8', '7ffe64a5-afb6-586f-a8c1-80b594ae60a3', '1115bb81-a3fe-52b0-a933-8f90c08f8100');
--> statement-breakpoint
-- 6. Номенклатура СИЗ: базовая позиция (без размера) и её размерный ряд.
-- Размер — отдельная позиция-вариант с родителем-базой (один уровень), как
-- заведено для остальной номенклатуры. Категория 'workwear' отделяет СИЗ от
-- деталей — в фонд деталей они не попадают.
INSERT INTO erp_nomenclature (id, code, name, item_type, category, parent_nomenclature_id, is_active, sync_status, created_at, updated_at)
VALUES
  ('55af538a-8988-5ef6-a53a-a24f7261278c', 'СИЗ-070', 'Средства индивидуальной защиты органов дыхания с принудительной подачей воздуха — У-2К', 'material', 'workwear', NULL, true, 'synced', 1767225600000, 1767225600000) ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
