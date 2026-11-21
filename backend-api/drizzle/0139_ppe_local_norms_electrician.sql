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
  ('e4c48647-8fc2-51c8-a8b0-74c97f1758cd', 'f2626fff-3c67-5ab3-a450-b3c337e344dc', 'Обувь специальная для защиты от механических воздействий (ударов)', 'Средства защиты ног', 1, 'пар', 'annual', NULL, 2, '1 пара', 'local', 'Заводская норма (решение владельца 17.11.2026)', 1767225600000, 1767225600000, 'synced'),
  ('4de80d4d-c538-5dfb-ab08-46ac0c49b331', 'f2626fff-3c67-5ab3-a450-b3c337e344dc', 'Перчатки для защиты от механических воздействий (истирания) — хлопковые с латексным двойным обливом', 'Средства защиты рук', 6, 'пар', 'annual', NULL, 3, '6 пар', 'local', 'Заводская норма (решение владельца 17.11.2026)', 1767225600000, 1767225600000, 'synced') ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
-- 3. Новых наборов норм в этой миграции нет.
--> statement-breakpoint
-- 4. Строки наборов норм: привязка строки приказа к базовой позиции
-- номенклатуры и к «приказной» строке (spec_id). Размер сотрудника подставляется
-- при выдаче — дерево «база → размеры», поэтому в норме лежит базовая модель.
INSERT INTO ppe_norm_lines (id, norm_set_id, nomenclature_id, qty, wear_months, spec_id, unit, wear_kind, created_at, updated_at, sync_status)
VALUES
  ('401fe873-f65e-5874-aba8-733047341ae4', 'ea1a94de-3300-55de-a3e5-d4c045775026', 'dfd01fa9-a4ed-584d-a9e8-bc51e665af5e', 1, NULL, 'e4c48647-8fc2-51c8-a8b0-74c97f1758cd', 'пара', 'annual', 1767225600000, 1767225600000, 'synced'),
  ('d6c7cb6f-f96d-55c8-a532-d53eaf5ed0ec', 'ea1a94de-3300-55de-a3e5-d4c045775026', 'b5b28a01-d3ae-57b6-a3c8-d4c128b54e5f', 6, NULL, '4de80d4d-c538-5dfb-ab08-46ac0c49b331', 'пар', 'annual', 1767225600000, 1767225600000, 'synced') ON CONFLICT (id) DO NOTHING;
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
   AND s.id IN ('e4c48647-8fc2-51c8-a8b0-74c97f1758cd', '4de80d4d-c538-5dfb-ab08-46ac0c49b331');
--> statement-breakpoint
-- 6. Новых позиций номенклатуры в этой миграции нет: базовые позиции и их размерные ряды уже заведены.
--> statement-breakpoint
