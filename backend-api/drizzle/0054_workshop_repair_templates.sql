-- Workshop repair template (Stage 2 of workshop-work-order plan).
--
-- Per-workshop template that lists default nomenclatures for the new
-- WorkOrderKind.WorkshopTemplate ('Ремонт по шаблону цеха'). Read on every
-- creation of a Workshop-naryad to autofill freeWorks; written by admin via
-- the Workshop-naryad header [Шаблон] button.
--
-- Single row per workshop (PK = workshop_id). The list itself lives as a JSON
-- column — matches the existing pattern of erp_document_headers.payload_json
-- and avoids a junction table for what is functionally an ordered preset.
--
-- Cascade on workshop delete: if a workshop is soft-deleted via directory_workshops.
-- deleted_at the FK row also goes (CASCADE on hard-delete only; soft-delete
-- leaves both rows). This matches the rest of the workshop-related schema.
--
-- Not synced to clients (server-only REST, like services). updated_at + updated_by
-- are bookkeeping only — no ledger entry on edits.

CREATE TABLE IF NOT EXISTS "workshop_repair_templates" (
  "workshop_id" uuid PRIMARY KEY NOT NULL,
  "lines_json" text NOT NULL DEFAULT '[]',
  "updated_at" bigint NOT NULL,
  "updated_by" text,
  CONSTRAINT "workshop_repair_templates_workshop_id_fk"
    FOREIGN KEY ("workshop_id") REFERENCES "directory_workshops"("id")
    ON DELETE CASCADE
);
