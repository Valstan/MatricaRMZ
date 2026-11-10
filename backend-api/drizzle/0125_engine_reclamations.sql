-- Рекламации двигателя: очередь заездов по рекламации (1-я, 2-я, 3-я …).
--
-- Владелец (10.11.2026): «рекламаций может быть несколько, и они должны иметь свою
-- очередность, то есть первая, вторая, третья, чтобы у нас там даты прихода
-- двигателя и отгрузки двигателя по рекламациям тоже не пересекались друг с другом».
--
-- Основной цикл карточки — заезд №1, рекламация №1 — заезд №2, и так далее.
-- Отдельная строгая таблица, а не EAV-атрибут: EAV под заморожкой (AGENTS.md §EAV),
-- а рекламаций у двигателя может быть несколько.
--
-- Ведёт серверная дверь (engineReclamationService, REST /engine-reclamations),
-- клиент читает реплику (server-write / pull-only — владение таблиц в
-- shared/domain/ledgerAuthz). sync_status/last_server_seq — для pull-only палицы.

CREATE TABLE IF NOT EXISTS erp_engine_reclamations (
  id uuid PRIMARY KEY,
  engine_id uuid NOT NULL,
  queue_no integer NOT NULL,
  accepted_at bigint,
  shipped_at bigint,
  customer_reason text,
  actual_defect text,
  defect_nature text,
  act_number text,
  act_date bigint,
  comment text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_engine_reclamations_engine_idx ON erp_engine_reclamations (engine_id);
--> statement-breakpoint
-- Номер очереди у одного двигателя один: две рекламации №1 — это путаница в учёте.
CREATE UNIQUE INDEX IF NOT EXISTS erp_engine_reclamations_queue_uq
    ON erp_engine_reclamations (engine_id, queue_no)
    WHERE deleted_at IS NULL;
