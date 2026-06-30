-- Multiple repair templates per workshop (v1.27.0).
--
-- v1.26.0 introduced 1:1 (workshop_id PRIMARY KEY) — each цех had a single
-- template. v1.27.0 turns it into 1:N — each цех owns multiple named templates,
-- selected at [Применить шаблон] time. Name is unique within the workshop.
--
-- Backfill: existing rows (one per workshop) get a generated id and name='Базовый'.

ALTER TABLE "workshop_repair_templates" DROP CONSTRAINT IF EXISTS "workshop_repair_templates_pkey";

ALTER TABLE "workshop_repair_templates" ADD COLUMN IF NOT EXISTS "id" uuid;
ALTER TABLE "workshop_repair_templates" ADD COLUMN IF NOT EXISTS "name" text;

UPDATE "workshop_repair_templates" SET "id" = gen_random_uuid() WHERE "id" IS NULL;
UPDATE "workshop_repair_templates" SET "name" = 'Базовый' WHERE "name" IS NULL OR "name" = '';

ALTER TABLE "workshop_repair_templates" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "workshop_repair_templates" ALTER COLUMN "name" SET NOT NULL;

ALTER TABLE "workshop_repair_templates" ADD PRIMARY KEY ("id");

CREATE INDEX IF NOT EXISTS "workshop_repair_templates_workshop_idx"
  ON "workshop_repair_templates" ("workshop_id");

CREATE UNIQUE INDEX IF NOT EXISTS "workshop_repair_templates_workshop_name_uq"
  ON "workshop_repair_templates" ("workshop_id", "name");
