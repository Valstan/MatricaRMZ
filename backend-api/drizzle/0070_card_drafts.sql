CREATE TABLE IF NOT EXISTS "card_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"card_type" text NOT NULL,
	"card_id" uuid NOT NULL,
	"kind" text DEFAULT 'recovery' NOT NULL,
	"title" text,
	"payload_json" text,
	"base_updated_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_server_seq" bigint,
	"deleted_at" bigint,
	"sync_status" text DEFAULT 'synced' NOT NULL
);

CREATE INDEX IF NOT EXISTS "card_drafts_owner_kind_idx" ON "card_drafts" ("owner_user_id","kind");
CREATE INDEX IF NOT EXISTS "card_drafts_owner_card_idx" ON "card_drafts" ("owner_user_id","card_type","card_id");

ALTER TABLE "card_drafts" ADD CONSTRAINT "card_drafts_owner_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "entities"("id") ON DELETE no action ON UPDATE no action;
