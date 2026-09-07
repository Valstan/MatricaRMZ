-- Справочник складов и цехов входит в контракт синхронизации (pull-only).
--
-- Зачем: разрез отчётов «по цехам» и подписи складов строятся по типу локации, а справочник жил
-- только на сервере и запрашивался по сети. Без связи клиент не мог отличить цех от склада, и
-- отчёт отдавал пустую таблицу, неотличимую от «за период ничего не ремонтировали» (GOTCHAS M112).
--
-- Таблица маленькая (15 строк на 07.09.2026) и меняется раз в год — реплика дешёвая.
--
-- Колонки те же, что у любой синхронизируемой таблицы: `sync_status` и `last_server_seq`.
-- Номер журнала проставляет `writeSyncChanges`, инкрементальный pull отбирает строки условием
-- `last_server_seq > since` — у строк со значением NULL это условие НИКОГДА не истинно (в SQL
-- `NULL > n` не TRUE). Поэтому существующие строки помечаются к публикации прямо здесь: первый
-- же тик публикатора (`warehouseLocationsSyncPublisherService`) проведёт их через путь записи и
-- проставит seq. Отдельного ручного шага при выкате не требуется.
ALTER TABLE warehouse_locations ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'synced';
--> statement-breakpoint
ALTER TABLE warehouse_locations ADD COLUMN IF NOT EXISTS last_server_seq bigint;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS warehouse_locations_seq_idx ON warehouse_locations (last_server_seq);
--> statement-breakpoint
UPDATE warehouse_locations SET sync_status = 'pending';
