CREATE TABLE IF NOT EXISTS "ai_chat_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"username" text NOT NULL,
	"question_text" text NOT NULL,
	"question_file_json" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"answer_text" text,
	"answer_files_json" text,
	"answered_at" bigint,
	"escalation_note" text,
	"verdict_text" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_server_seq" bigint,
	"deleted_at" bigint,
	"sync_status" text DEFAULT 'synced' NOT NULL
);

CREATE INDEX IF NOT EXISTS "ai_chat_requests_user_created_idx" ON "ai_chat_requests" ("user_id","created_at");
CREATE INDEX IF NOT EXISTS "ai_chat_requests_status_idx" ON "ai_chat_requests" ("status");

ALTER TABLE "ai_chat_requests" ADD CONSTRAINT "ai_chat_requests_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "entities"("id") ON DELETE no action ON UPDATE no action;

CREATE TABLE IF NOT EXISTS "ai_chat_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS "ai_chat_rules_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"rules_md" text NOT NULL,
	"changed_by" text NOT NULL,
	"created_at" bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "ai_chat_rules_history_created_at_idx" ON "ai_chat_rules_history" ("created_at");
