DROP INDEX "file_assets_sha256_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "file_assets_sha256_uq" ON "file_assets" USING btree ("sha256") WHERE "file_assets"."deleted_at" is null;