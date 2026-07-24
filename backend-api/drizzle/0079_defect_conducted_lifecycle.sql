CREATE TABLE "defect_conducted_versions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "engine_id" uuid NOT NULL REFERENCES "entities"("id"),
  "version" integer NOT NULL,
  "operation_id" uuid NOT NULL,
  "draft_revision" text NOT NULL,
  "snapshot_hash" text NOT NULL,
  "snapshot_json" text NOT NULL,
  "document_header_id" uuid REFERENCES "erp_document_headers"("id"),
  "status" text DEFAULT 'active' NOT NULL,
  "replaces_version_id" uuid,
  "conducted_by" uuid NOT NULL,
  "conducted_at" bigint NOT NULL,
  "reversed_at" bigint
);
CREATE UNIQUE INDEX "defect_conducted_versions_operation_uq" ON "defect_conducted_versions" ("operation_id");
CREATE UNIQUE INDEX "defect_conducted_versions_engine_version_uq" ON "defect_conducted_versions" ("engine_id", "version");
CREATE UNIQUE INDEX "defect_conducted_versions_active_engine_uq" ON "defect_conducted_versions" ("engine_id") WHERE "status" = 'active';

CREATE TABLE "defect_part_instances" (
  "id" uuid PRIMARY KEY NOT NULL,
  "nomenclature_id" uuid NOT NULL REFERENCES "erp_nomenclature"("id"),
  "serial_normalized" text NOT NULL,
  "serial_display" text NOT NULL,
  "source_engine_id" uuid NOT NULL REFERENCES "entities"("id"),
  "current_location_id" uuid REFERENCES "warehouse_locations"("id"),
  "current_status" text NOT NULL,
  "current_version_id" uuid NOT NULL REFERENCES "defect_conducted_versions"("id"),
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL
);
CREATE UNIQUE INDEX "defect_part_instances_nom_serial_uq" ON "defect_part_instances" ("nomenclature_id", "serial_normalized");
CREATE INDEX "defect_part_instances_engine_idx" ON "defect_part_instances" ("source_engine_id");
CREATE INDEX "defect_part_instances_location_idx" ON "defect_part_instances" ("current_location_id");

CREATE TABLE "defect_part_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "engine_id" uuid NOT NULL REFERENCES "entities"("id"),
  "conducted_version_id" uuid NOT NULL REFERENCES "defect_conducted_versions"("id"),
  "source_line_id" text NOT NULL,
  "nomenclature_id" uuid NOT NULL REFERENCES "erp_nomenclature"("id"),
  "instance_id" uuid REFERENCES "defect_part_instances"("id"),
  "event_type" text NOT NULL,
  "qty" integer NOT NULL,
  "payload_json" text,
  "occurred_at" bigint NOT NULL,
  "occurred_by" uuid NOT NULL
);
CREATE INDEX "defect_part_events_engine_time_idx" ON "defect_part_events" ("engine_id", "occurred_at");
CREATE INDEX "defect_part_events_version_idx" ON "defect_part_events" ("conducted_version_id");
CREATE INDEX "defect_part_events_instance_idx" ON "defect_part_events" ("instance_id") WHERE "instance_id" is not null;
