CREATE EXTENSION IF NOT EXISTS "pgcrypto";
--> statement-breakpoint

DO $$
DECLARE
  employee_type_id uuid;
  ts bigint := (extract(epoch from now()) * 1000)::bigint;
BEGIN
  SELECT id INTO employee_type_id
  FROM entity_types
  WHERE code = 'employee' AND deleted_at IS NULL
  LIMIT 1;

  IF employee_type_id IS NOT NULL THEN
    INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, is_required, sort_order, meta_json, created_at, updated_at, deleted_at, sync_status)
    SELECT gen_random_uuid(), employee_type_id, 'login', 'Логин', 'text', false, 9900, '{"serverOnly":true}', ts, ts, NULL, 'synced'
    WHERE NOT EXISTS (
      SELECT 1 FROM attribute_defs WHERE entity_type_id = employee_type_id AND code = 'login'
    );
    INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, is_required, sort_order, meta_json, created_at, updated_at, deleted_at, sync_status)
    SELECT gen_random_uuid(), employee_type_id, 'password_hash', 'Пароль (хэш)', 'text', false, 9900, '{"serverOnly":true}', ts, ts, NULL, 'synced'
    WHERE NOT EXISTS (
      SELECT 1 FROM attribute_defs WHERE entity_type_id = employee_type_id AND code = 'password_hash'
    );
    INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, is_required, sort_order, meta_json, created_at, updated_at, deleted_at, sync_status)
    SELECT gen_random_uuid(), employee_type_id, 'system_role', 'Системная роль', 'text', false, 9900, '{"serverOnly":true}', ts, ts, NULL, 'synced'
    WHERE NOT EXISTS (
      SELECT 1 FROM attribute_defs WHERE entity_type_id = employee_type_id AND code = 'system_role'
    );
    INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, is_required, sort_order, meta_json, created_at, updated_at, deleted_at, sync_status)
    SELECT gen_random_uuid(), employee_type_id, 'access_enabled', 'Доступ разрешен', 'boolean', false, 9900, '{"serverOnly":true}', ts, ts, NULL, 'synced'
    WHERE NOT EXISTS (
      SELECT 1 FROM attribute_defs WHERE entity_type_id = employee_type_id AND code = 'access_enabled'
    );
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "refresh_tokens" DROP CONSTRAINT IF EXISTS "refresh_tokens_user_id_users_id_fk";
ALTER TABLE "refresh_tokens"
  ADD CONSTRAINT "refresh_tokens_user_id_entities_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "user_permissions" DROP CONSTRAINT IF EXISTS "user_permissions_user_id_users_id_fk";
ALTER TABLE "user_permissions"
  ADD CONSTRAINT "user_permissions_user_id_entities_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "permission_delegations" DROP CONSTRAINT IF EXISTS "permission_delegations_from_user_id_users_id_fk";
ALTER TABLE "permission_delegations" DROP CONSTRAINT IF EXISTS "permission_delegations_to_user_id_users_id_fk";
ALTER TABLE "permission_delegations" DROP CONSTRAINT IF EXISTS "permission_delegations_created_by_user_id_users_id_fk";
ALTER TABLE "permission_delegations" DROP CONSTRAINT IF EXISTS "permission_delegations_revoked_by_user_id_users_id_fk";
ALTER TABLE "permission_delegations"
  ADD CONSTRAINT "permission_delegations_from_user_id_entities_id_fk"
  FOREIGN KEY ("from_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "permission_delegations"
  ADD CONSTRAINT "permission_delegations_to_user_id_entities_id_fk"
  FOREIGN KEY ("to_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "permission_delegations"
  ADD CONSTRAINT "permission_delegations_created_by_user_id_entities_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "permission_delegations"
  ADD CONSTRAINT "permission_delegations_revoked_by_user_id_entities_id_fk"
  FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "file_assets" DROP CONSTRAINT IF EXISTS "file_assets_created_by_user_id_users_id_fk";
ALTER TABLE "file_assets"
  ADD CONSTRAINT "file_assets_created_by_user_id_entities_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "row_owners" DROP CONSTRAINT IF EXISTS "row_owners_owner_user_id_users_id_fk";
ALTER TABLE "row_owners"
  ADD CONSTRAINT "row_owners_owner_user_id_entities_id_fk"
  FOREIGN KEY ("owner_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "change_requests" DROP CONSTRAINT IF EXISTS "change_requests_record_owner_user_id_users_id_fk";
ALTER TABLE "change_requests" DROP CONSTRAINT IF EXISTS "change_requests_change_author_user_id_users_id_fk";
ALTER TABLE "change_requests" DROP CONSTRAINT IF EXISTS "change_requests_decided_by_user_id_users_id_fk";
ALTER TABLE "change_requests"
  ADD CONSTRAINT "change_requests_record_owner_user_id_entities_id_fk"
  FOREIGN KEY ("record_owner_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "change_requests"
  ADD CONSTRAINT "change_requests_change_author_user_id_entities_id_fk"
  FOREIGN KEY ("change_author_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "change_requests"
  ADD CONSTRAINT "change_requests_decided_by_user_id_entities_id_fk"
  FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "chat_messages" DROP CONSTRAINT IF EXISTS "chat_messages_sender_user_id_users_id_fk";
ALTER TABLE "chat_messages" DROP CONSTRAINT IF EXISTS "chat_messages_recipient_user_id_users_id_fk";
ALTER TABLE "chat_messages"
  ADD CONSTRAINT "chat_messages_sender_user_id_entities_id_fk"
  FOREIGN KEY ("sender_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "chat_messages"
  ADD CONSTRAINT "chat_messages_recipient_user_id_entities_id_fk"
  FOREIGN KEY ("recipient_user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "chat_reads" DROP CONSTRAINT IF EXISTS "chat_reads_user_id_users_id_fk";
ALTER TABLE "chat_reads"
  ADD CONSTRAINT "chat_reads_user_id_entities_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "user_presence" DROP CONSTRAINT IF EXISTS "user_presence_id_users_id_fk";
ALTER TABLE "user_presence" DROP CONSTRAINT IF EXISTS "user_presence_user_id_users_id_fk";
ALTER TABLE "user_presence"
  ADD CONSTRAINT "user_presence_id_entities_id_fk"
  FOREIGN KEY ("id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "user_presence"
  ADD CONSTRAINT "user_presence_user_id_entities_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;
