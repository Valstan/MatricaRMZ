-- Universal work-order templates (Stage 1 of work-order-template-system plan).
--
-- Generalises the v1.26.0 WorkOrderKind.WorkshopTemplate idea ("autofill from a
-- saved snapshot") to all four base WorkOrderKind values: regular / repair /
-- assembly / manufacturing. The Workshop-specific table `workshop_repair_templates`
-- remains as read-only legacy; data is migrated to this table in PR 6 via
-- scripts/migrateWorkshopTemplatesToWorkOrderTemplates.ts.
--
-- Schema layout matches the existing convention of storing serialized JSON as
-- `text` (see workshop_repair_templates.lines_json, erp_document_headers.payload_json).
-- Postgres `jsonb` is used only in a single legacy seed migration; keeping `text`
-- here avoids introducing a second serialization style for an otherwise identical
-- access pattern (JSON.parse on read, JSON.stringify on write).
--
-- payload_overrides : partial WorkOrderPayload snapshot applied via Object.assign at
--                     [Apply template] time.
-- hidden_fields     : array of payload field keys visually hidden in the card.
--                     Visual-only — stored values in operations.payload_json stay null.
-- lines             : array of template lines copied into payload.freeWorks at apply.
--
-- Not synced to clients (server-only REST, same as workshop_repair_templates).

CREATE TABLE IF NOT EXISTS "work_order_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "work_order_kind" text NOT NULL,
  "name" text NOT NULL,
  "payload_overrides" text NOT NULL DEFAULT '{}',
  "hidden_fields" text NOT NULL DEFAULT '[]',
  "lines" text NOT NULL DEFAULT '[]',
  "updated_at" bigint NOT NULL,
  "updated_by" text,
  CONSTRAINT "work_order_templates_kind_ck"
    CHECK ("work_order_kind" IN ('regular','repair','assembly','manufacturing')),
  CONSTRAINT "work_order_templates_name_len_ck"
    CHECK (length("name") BETWEEN 1 AND 100)
);

CREATE INDEX IF NOT EXISTS "work_order_templates_kind_idx"
  ON "work_order_templates" ("work_order_kind");

CREATE UNIQUE INDEX IF NOT EXISTS "work_order_templates_kind_name_uq"
  ON "work_order_templates" ("work_order_kind", "name");
