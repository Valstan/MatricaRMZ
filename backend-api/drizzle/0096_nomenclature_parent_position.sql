-- Обобщённая позиция номенклатуры (план bom-simplify-2026-09 §6.4, решение владельца 13.09 §7 п. 5).
--
-- «Масляный насос должен быть один на все двигатели»: у детали появляется РОДИТЕЛЬ без артикула,
-- а артикульные строки становятся его вариантами. Один уровень: родитель сам родителя не имеет
-- (проверяется сервисом, не БД — аддитивная колонка без CHECK, чтобы реплика не стала строже).
-- Спецификация ссылается на родителя, прогноз раскрывает его в варианты по остатку; склад
-- по-прежнему считает по конкретной строке (ключ остатков не меняется), свод по родителю — в UI.
ALTER TABLE erp_nomenclature ADD COLUMN IF NOT EXISTS parent_nomenclature_id uuid REFERENCES erp_nomenclature(id);
CREATE INDEX IF NOT EXISTS erp_nomenclature_parent_idx ON erp_nomenclature(parent_nomenclature_id) WHERE deleted_at IS NULL;
