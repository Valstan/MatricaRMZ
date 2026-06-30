-- Учёт «активного» времени работы (input-based) + колонка active_ms в дневной сводке.
-- active_ms приходит дельтой на существующем 60-сек heartbeat'е (без новых запросов); сервер
-- хранит кумулятив за день на клиента (GREATEST → идемпотентно). Дневная сводка суммирует по login.
-- Аддитивно и безопасно на проде: active_ms в statistics_audit_daily дефолтится 0; новая таблица
-- пустая до первого heartbeat'а с активностью.
ALTER TABLE "statistics_audit_daily" ADD COLUMN IF NOT EXISTS "active_ms" bigint DEFAULT 0 NOT NULL;
CREATE TABLE IF NOT EXISTS "statistics_active_time" (
	"summary_date" text NOT NULL,
	"client_id" text NOT NULL,
	"login" text NOT NULL,
	"active_ms" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "statistics_active_time_summary_date_client_id_pk" PRIMARY KEY ("summary_date", "client_id")
);
CREATE INDEX IF NOT EXISTS "statistics_active_time_login_idx" ON "statistics_active_time" ("summary_date", "login");
