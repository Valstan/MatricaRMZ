DROP INDEX IF EXISTS "users_username_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_uq" ON "users" USING btree ("username") WHERE "users"."deleted_at" is null;

