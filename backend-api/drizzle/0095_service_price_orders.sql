-- Приказы о ценах на услуги (решение владельца 11.09.2026: «завести миграцию и доделать»).
-- Обе таблицы описаны в schema.ts с июня 2026 и попали в snapshot, но ни одна миграция их не
-- создавала: сервис и маршруты /service-pricing/* существовали, а первый же запрос на проде
-- отвечал `relation "service_price_orders" does not exist` (найдено 11.09 при слиянии дублей
-- сотрудников). Таблицы НЕ входят в контракт синхронизации: клиент ходит к ним по REST.
--
-- service_price_orders — сам приказ (номер, дата, кем издан, с какого числа действует).
-- service_price_history — строки приказа: цена конкретной услуги (erp_nomenclature) с даты.
-- Действующая цена услуги = строка с максимальным effective_from, не позднее сегодняшнего дня.
CREATE TABLE IF NOT EXISTS "service_price_orders" (
  "id" uuid PRIMARY KEY,
  "order_number" text NOT NULL,
  "order_date" bigint NOT NULL,
  "title" text NOT NULL,
  "notes" text,
  "document_link" text,
  "issued_by_employee_id" uuid,
  "effective_from" bigint NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "sync_status" text NOT NULL DEFAULT 'synced',
  "last_server_seq" bigint,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "service_price_orders_number_uq"
  ON "service_price_orders" ("order_number") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_price_orders_effective_from_idx"
  ON "service_price_orders" ("effective_from");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_price_history" (
  "id" uuid PRIMARY KEY,
  "nomenclature_id" uuid NOT NULL REFERENCES "erp_nomenclature"("id"),
  "order_id" uuid NOT NULL REFERENCES "service_price_orders"("id"),
  "price" integer NOT NULL,
  "price_currency" text NOT NULL DEFAULT 'RUB',
  "effective_from" bigint NOT NULL,
  "notes" text,
  "sync_status" text NOT NULL DEFAULT 'synced',
  "last_server_seq" bigint,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "deleted_at" bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_price_history_nomenclature_effective_idx"
  ON "service_price_history" ("nomenclature_id", "effective_from");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_price_history_order_idx"
  ON "service_price_history" ("order_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "service_price_history_nomenclature_order_uq"
  ON "service_price_history" ("nomenclature_id", "order_id") WHERE "deleted_at" IS NULL;
