-- Свой договор и контрагент у каждого заезда по рекламации (промты КАРМАНА
-- #42/#43, владелец 19.11.2026).
--
-- Владелец: «в каждом заезде могут быть разные договоры, разные поставщики и
-- заказчики — поэтому по каждому заезду это заполняется отдельно».
--
-- Что за колонки:
--   - `erp_engine_reclamations.contract_id` — договор ЗАЕЗДА (не карточки):
--     движок мог вернуться по рекламации уже по другому договору;
--   - `erp_engine_reclamations.customer_id` — контрагент заезда (заказчик/
--     поставщик). Запасной путь: если договора нет, заказчик берётся отсюда;
--     при договоре главный источник — договор (домен `resolveEngineVisitCustomer`),
--     иначе появятся две правды.
--
-- Строгие колонки, а не EAV-атрибуты: EAV под заморожкой (AGENTS.md §EAV).
-- Nullable: заезды, заведённые до миграции, договора и контрагента не знают.
-- У клиента (реплика Electron и Android) та же nullability — иначе
-- checkReplicaStrictness уронит pull.
--
-- Цеха (workshop_id) здесь нет: двигатель не привязан к цеху (решение 2026-10),
-- цех — атрибут этапа ремонта, а не заезда.

ALTER TABLE erp_engine_reclamations
  ADD COLUMN IF NOT EXISTS contract_id uuid;
--> statement-breakpoint
ALTER TABLE erp_engine_reclamations
  ADD COLUMN IF NOT EXISTS customer_id uuid;
