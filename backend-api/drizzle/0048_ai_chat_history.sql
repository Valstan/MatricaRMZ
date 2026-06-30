-- История нейрочата (Часть 5а плана immutable-tumbling-dongarra).
-- Хранит сообщения пользователя и ассистента в разрезе разговоров (conversation_id).
-- Используется в endpoints /ai/conversations* и POST /ai/assist?stream=1.

CREATE TABLE IF NOT EXISTS "ai_chat_history" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users" ("id"),
  "conversation_id" uuid NOT NULL,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "tool_calls_json" text,
  "tool_results_json" text,
  "model" text,
  "input_tokens" integer,
  "output_tokens" integer,
  "context_json" text,
  "ts" bigint NOT NULL,
  "created_at" bigint NOT NULL,
  CONSTRAINT "ai_chat_history_role_chk" CHECK ("role" IN ('user', 'assistant', 'tool'))
);

CREATE INDEX IF NOT EXISTS "ai_chat_history_user_conv_ts_idx"
  ON "ai_chat_history" ("user_id", "conversation_id", "ts");

CREATE INDEX IF NOT EXISTS "ai_chat_history_user_ts_idx"
  ON "ai_chat_history" ("user_id", "ts" DESC);

CREATE INDEX IF NOT EXISTS "ai_chat_history_created_at_idx"
  ON "ai_chat_history" ("created_at");
