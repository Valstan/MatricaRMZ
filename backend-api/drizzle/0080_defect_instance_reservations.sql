ALTER TABLE "defect_part_instances"
  ADD COLUMN "reserved_document_id" uuid REFERENCES "erp_document_headers"("id"),
  ADD COLUMN "reserved_at" bigint;

CREATE INDEX "defect_part_instances_reserved_document_idx"
  ON "defect_part_instances" ("reserved_document_id")
  WHERE "reserved_document_id" is not null;
