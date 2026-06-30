-- Custom signature captions (roles) typed by operators in the work-order card,
-- shared across all clients (D1 hybrid: captions in DB, "recent signers" stay local
-- in renderer localStorage). Accessed via direct authed HTTP like work_order_templates
-- — NOT a synced table (no sync_status/last_server_seq columns), so it stays out of the
-- sync schema guard. text_norm is the dedupe key (trim + collapse spaces + lowercase + ё→е);
-- the unique index keeps the same caption from being stored twice.
--
-- Hand-written (not drizzle-kit generate) because the drizzle snapshot has pre-existing
-- drift (GOTCHAS G74) that makes `db:generate` interactive; the runtime migrator only
-- needs _journal.json + this .sql. Additive and safe on prod: brand-new empty table.
CREATE TABLE IF NOT EXISTS "work_order_signature_captions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"text" text NOT NULL,
	"text_norm" text NOT NULL,
	"created_at" bigint NOT NULL,
	"created_by" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "work_order_signature_captions_norm_uq" ON "work_order_signature_captions" ("text_norm");
