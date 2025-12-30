DROP INDEX "users_username_uq";--> statement-breakpoint
ALTER TABLE "sync_state" ALTER COLUMN "last_pulled_server_seq" SET DATA TYPE bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_uq" ON "users" USING btree ("username") WHERE "users"."deleted_at" is null;