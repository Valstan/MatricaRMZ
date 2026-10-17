-- Сотрудники СИЗ входят в контракт синхронизации (план ppe-kladovshik-phase2, PR-6).
--
-- Зачем: фаза 2 валидирует отпуска/группы/коллективные выдачи строго по
-- erp_employee_cards, а отчёты СИЗ резолвят ФИО из клиентской реплики. Пока
-- таблица жила вне контракта, карточки сотрудников не приезжали на клиент:
-- пикеры не видели никого, отчёты печатали прочерк вместо ФИО.
--
-- Таблица server-write / pull-only: заводит её только импорт ЗУП (ставит
-- sync_status='pending'), публикатор зеркала (ppeSyncPublisherService) доводит
-- строку до журнала. attrs_json в зеркальный DTO НЕ входит (birth/hire-даты,
-- которые pull-фильтр скрывает от операторов) — колонка на сервере остаётся.
--
-- Инкрементальный pull отбирает строки условием `last_server_seq > since`;
-- у строк со значением NULL это условие НИКОГДА не истинно, поэтому
-- существующие строки помечаются к публикации прямо здесь (приём 0093/0108).
ALTER TABLE erp_employee_cards ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'synced';
--> statement-breakpoint
ALTER TABLE erp_employee_cards ADD COLUMN IF NOT EXISTS last_server_seq bigint;
--> statement-breakpoint
UPDATE erp_employee_cards SET sync_status = 'pending';
