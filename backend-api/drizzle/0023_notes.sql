CREATE TABLE IF NOT EXISTS "notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body_json" text,
	"importance" text DEFAULT 'normal' NOT NULL,
	"due_at" bigint,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint,
	"sync_status" text DEFAULT 'synced' NOT NULL
);

CREATE TABLE IF NOT EXISTS "note_shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"note_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint,
	"sync_status" text DEFAULT 'synced' NOT NULL
);

CREATE INDEX IF NOT EXISTS "notes_owner_sort_idx" ON "notes" ("owner_user_id","sort_order");
CREATE INDEX IF NOT EXISTS "note_shares_recipient_sort_idx" ON "note_shares" ("recipient_user_id","sort_order");

CREATE UNIQUE INDEX IF NOT EXISTS "note_shares_note_recipient_uq" ON "note_shares" ("note_id","recipient_user_id");

ALTER TABLE "notes" ADD CONSTRAINT "notes_owner_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "entities"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "note_shares" ADD CONSTRAINT "note_shares_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "note_shares" ADD CONSTRAINT "note_shares_recipient_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "entities"("id") ON DELETE no action ON UPDATE no action;
