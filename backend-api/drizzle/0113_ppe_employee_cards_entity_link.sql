-- Сотрудники «Кладовщика»: связь строгой карточки с карточкой справочника (EAV).
--
-- Зачем: субъект модуля — erp_employee_cards, а наполнял её только импорт 1С:ЗУП.
-- На проде импорт ни разу не запускался: 408 сотрудников живут в EAV-справочнике,
-- карточек — 0, поэтому пикеры «Карточек СИЗ» пусты (жалоба владельца 20.10.2026).
-- Зеркало (ppeEmployeeMirrorService) ведёт строку из справочника и по этой колонке
-- узнаёт свою строку на следующем проходе — иначе каждый проход заводил бы дубль.
--
-- Колонка серверная: в зеркальный DTO не входит (клиенту достаточно card id),
-- поэтому клиентская реплика и контракт синхронизации не меняются.
ALTER TABLE erp_employee_cards ADD COLUMN IF NOT EXISTS entity_id uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS erp_employee_cards_entity_id_uq
  ON erp_employee_cards (entity_id)
  WHERE entity_id IS NOT NULL AND deleted_at IS NULL;
