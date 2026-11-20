-- Накладные по заезду по рекламации (владелец 20.11.2026).
--
-- Владелец, про ленту заездов: «ну ладно история ремонта она вобще отдельно идет во
-- вкладке история ремонта, но тут хотя бы знать когда приехал в тот заезд когда уехал
-- какой номер накладных был, сколько по контракту наверно там оплачено было».
--
-- Накладные прихода и отгрузки по заезду:
--   - у основного цикла они лежат в карточке двигателя (`erp_engine_cards.arrival_invoice`
--     и `.shipment_invoice`) — там им и место;
--   - у заезда по рекламации своих накладных не было: двигатель возвращался, а номер
--     накладной нигде не записывался. Теперь заезд несёт свои.
--
-- Строгие колонки, а не EAV-атрибуты: EAV под заморожкой (AGENTS.md §EAV).
-- Nullable — у заездов, заведённых до миграции, накладных нет. У клиента (реплика
-- Electron и Android) та же nullability — иначе checkReplicaStrictness уронит pull.

ALTER TABLE erp_engine_reclamations
  ADD COLUMN IF NOT EXISTS arrival_invoice text;
--> statement-breakpoint
ALTER TABLE erp_engine_reclamations
  ADD COLUMN IF NOT EXISTS shipment_invoice text;
