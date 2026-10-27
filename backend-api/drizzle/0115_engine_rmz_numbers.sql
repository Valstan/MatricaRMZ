-- Сквозной программный номер карточки двигателя — `RMZ451` (план
-- engine-rmz-numbers-2026-10). Номер принадлежит СОЗДАНИЮ карточки, а не железу:
-- повторный заезд = новая карточка = новый номер. Строки реестра не удаляются
-- никогда — поэтому номер не переиспользуется даже после удаления карточки.
--
-- Последовательность, а не MAX(seq)+1: nextval не транзакционен, и откат
-- «сжигает» номер. Это осознанно — владелец просил именно так: номер уже
-- использован, следующий выпуск берёт следующий.
CREATE SEQUENCE IF NOT EXISTS engine_rmz_seq;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS erp_engine_numbers (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text,
	"card_deleted_at" bigint,
	"card_deleted_by" text,
	"delete_reason" text,
	"snapshot_json" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint,
	"sync_status" text DEFAULT 'synced' NOT NULL,
	"last_server_seq" bigint,
	CONSTRAINT "erp_engine_numbers_seq_unique" UNIQUE("seq")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_engine_numbers_status_idx" ON "erp_engine_numbers" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_engine_numbers_seq_idx" ON "erp_engine_numbers" ("last_server_seq");
