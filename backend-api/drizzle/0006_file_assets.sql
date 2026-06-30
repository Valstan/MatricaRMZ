CREATE TABLE "file_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" bigint NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mime" text,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"storage_kind" text NOT NULL,
	"local_rel_path" text,
	"yandex_disk_path" text
);
--> statement-breakpoint
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "file_assets_sha256_uq" ON "file_assets" USING btree ("sha256");


