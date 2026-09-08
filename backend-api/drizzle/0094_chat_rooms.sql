-- Комнаты чата (владелец 08.09.2026): создатель набирает в комнату сотрудников и обсуждает
-- с ними производственные вопросы. Кто не приглашён — не видит комнату вовсе, включая её
-- название: выдача фильтруется в syncPrivacy по этим же двум полям.
--
-- Участники лежат JSON-массивом ВНУТРИ строки комнаты, а не отдельной таблицей членства:
-- приглашение — правка одной строки её создателем, «кто видит» читается одним полем, и не
-- возникает состояния «комната приехала, участники ещё нет» (у клиента порядок строк в
-- пределах одной посылки не гарантирован).
CREATE TABLE IF NOT EXISTS "chat_rooms" (
  "id" uuid PRIMARY KEY,
  "owner_user_id" uuid NOT NULL REFERENCES "entities"("id"),
  "title" text NOT NULL,
  "members_json" text,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "last_server_seq" bigint,
  "deleted_at" bigint,
  "sync_status" text NOT NULL DEFAULT 'synced'
);
--> statement-breakpoint
-- Сообщение комнаты: recipient_user_id пуст (адресата-человека нет), адрес несёт room_id.
-- Старые сообщения общего чата остаются с обоими пустыми полями и читаются как прежде.
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "room_id" uuid REFERENCES "chat_rooms"("id");
--> statement-breakpoint
-- Выдача комнат и их переписки идёт по членству, поэтому оба поля читаются на каждом pull.
CREATE INDEX IF NOT EXISTS "chat_rooms_owner_idx" ON "chat_rooms" ("owner_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_room_idx" ON "chat_messages" ("room_id");
