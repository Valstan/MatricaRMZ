-- Табель (timesheet) can now be scoped to a подразделение (department entity), not only a
-- цех (directory_workshops) — so org units like ОПП/бухгалтерия become timesheet-able.
-- Additive + backward compatible: existing rows keep workshop_id; every row sets EXACTLY ONE
-- of workshop_id / department_id (CHECK enforces XOR). department_id references the EAV
-- `entities` table (a department is an entity of type 'department').
--
-- Safe on prod: all existing timesheets have workshop_id set and department_id NULL, so the
-- XOR check holds for every current row and the new department index is empty until the first
-- department-scoped timesheet is created.
ALTER TABLE "timesheets" ALTER COLUMN "workshop_id" DROP NOT NULL;
ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "department_id" uuid REFERENCES "entities"("id");
ALTER TABLE "timesheets" DROP CONSTRAINT IF EXISTS "timesheets_scope_xor_chk";
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_scope_xor_chk"
  CHECK (("workshop_id" IS NOT NULL) <> ("department_id" IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS "timesheets_department_period_uq"
  ON "timesheets" ("department_id", "year", "month")
  WHERE "deleted_at" IS NULL AND "department_id" IS NOT NULL;
