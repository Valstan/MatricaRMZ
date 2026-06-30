-- Ensure chat_reads upsert has a matching unique constraint.
-- Deduplicate if needed, then enforce unique(message_id, user_id).
DELETE FROM chat_reads a
USING chat_reads b
WHERE a.ctid < b.ctid
  AND a.message_id = b.message_id
  AND a.user_id = b.user_id;

DROP INDEX IF EXISTS "chat_reads_message_user_uq";
CREATE UNIQUE INDEX "chat_reads_message_user_uq" ON "chat_reads" USING btree ("message_id","user_id");
