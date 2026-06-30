CREATE TABLE IF NOT EXISTS "row_owners" (
	"id" uuid PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"owner_username" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "row_owners_table_row_uq" ON "row_owners" USING btree ("table_name","row_id");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'row_owners_owner_user_id_users_id_fk'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "row_owners" r
      LEFT JOIN "users" u ON u.id = r.owner_user_id
      WHERE r.owner_user_id IS NOT NULL AND u.id IS NULL
    ) THEN
      ALTER TABLE "row_owners"
        ADD CONSTRAINT "row_owners_owner_user_id_users_id_fk"
        FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id")
        ON DELETE no action ON UPDATE no action;
    END IF;
  END IF;
END$$;
--> statement-breakpoint

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
CREATE UNIQUE INDEX IF NOT EXISTS "change_requests_status_id" ON "change_requests" USING btree ("status","id");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'change_requests_record_owner_user_id_users_id_fk'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "change_requests" r
      LEFT JOIN "users" u ON u.id = r.record_owner_user_id
      WHERE r.record_owner_user_id IS NOT NULL AND u.id IS NULL
    ) THEN
      ALTER TABLE "change_requests"
        ADD CONSTRAINT "change_requests_record_owner_user_id_users_id_fk"
        FOREIGN KEY ("record_owner_user_id") REFERENCES "public"."users"("id")
        ON DELETE no action ON UPDATE no action;
    END IF;
  END IF;
END$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'change_requests_change_author_user_id_users_id_fk'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "change_requests" r
      LEFT JOIN "users" u ON u.id = r.change_author_user_id
      WHERE r.change_author_user_id IS NOT NULL AND u.id IS NULL
    ) THEN
      ALTER TABLE "change_requests"
        ADD CONSTRAINT "change_requests_change_author_user_id_users_id_fk"
        FOREIGN KEY ("change_author_user_id") REFERENCES "public"."users"("id")
        ON DELETE no action ON UPDATE no action;
    END IF;
  END IF;
END$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'change_requests_decided_by_user_id_users_id_fk'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "change_requests" r
      LEFT JOIN "users" u ON u.id = r.decided_by_user_id
      WHERE r.decided_by_user_id IS NOT NULL AND u.id IS NULL
    ) THEN
      ALTER TABLE "change_requests"
        ADD CONSTRAINT "change_requests_decided_by_user_id_users_id_fk"
        FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id")
        ON DELETE no action ON UPDATE no action;
    END IF;
  END IF;
END$$;


