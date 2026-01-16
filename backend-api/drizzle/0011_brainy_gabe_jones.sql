CREATE TABLE IF NOT EXISTS "change_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"table_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"root_entity_id" uuid,
	"before_json" text,
	"after_json" text NOT NULL,
	"record_owner_user_id" uuid,
	"record_owner_username" text,
	"change_author_user_id" uuid NOT NULL,
	"change_author_username" text NOT NULL,
	"note" text,
	"created_at" bigint NOT NULL,
	"decided_at" bigint,
	"decided_by_user_id" uuid,
	"decided_by_username" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "row_owners" (
	"id" uuid PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"owner_username" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN IF NOT EXISTS "preview_mime" text;--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN IF NOT EXISTS "preview_size" bigint;--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN IF NOT EXISTS "preview_local_rel_path" text;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'change_requests_record_owner_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "change_requests"
      ADD CONSTRAINT "change_requests_record_owner_user_id_users_id_fk"
      FOREIGN KEY ("record_owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'change_requests_change_author_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "change_requests"
      ADD CONSTRAINT "change_requests_change_author_user_id_users_id_fk"
      FOREIGN KEY ("change_author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'change_requests_decided_by_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "change_requests"
      ADD CONSTRAINT "change_requests_decided_by_user_id_users_id_fk"
      FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'row_owners_owner_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "row_owners"
      ADD CONSTRAINT "row_owners_owner_user_id_users_id_fk"
      FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "change_requests_status_id" ON "change_requests" USING btree ("status","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "row_owners_table_row_uq" ON "row_owners" USING btree ("table_name","row_id");