CREATE TABLE "attribute_defs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_type_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"data_type" text NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"meta_json" text,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL,
	"deleted_at" integer,
	"sync_status" text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attribute_values" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_id" uuid NOT NULL,
	"attribute_def_id" uuid NOT NULL,
	"value_json" text,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL,
	"deleted_at" integer,
	"sync_status" text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_id" uuid,
	"table_name" text,
	"payload_json" text,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL,
	"deleted_at" integer,
	"sync_status" text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_log" (
	"server_seq" bigserial PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"op" text NOT NULL,
	"payload_json" text NOT NULL,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type_id" uuid NOT NULL,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL,
	"deleted_at" integer,
	"sync_status" text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL,
	"deleted_at" integer,
	"sync_status" text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"engine_entity_id" uuid NOT NULL,
	"operation_type" text NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL,
	"deleted_at" integer,
	"sync_status" text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"client_id" text PRIMARY KEY NOT NULL,
	"last_pulled_server_seq" integer DEFAULT 0 NOT NULL,
	"last_pushed_at" integer,
	"last_pulled_at" integer
);
--> statement-breakpoint
ALTER TABLE "attribute_defs" ADD CONSTRAINT "attribute_defs_entity_type_id_entity_types_id_fk" FOREIGN KEY ("entity_type_id") REFERENCES "public"."entity_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_values" ADD CONSTRAINT "attribute_values_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_values" ADD CONSTRAINT "attribute_values_attribute_def_id_attribute_defs_id_fk" FOREIGN KEY ("attribute_def_id") REFERENCES "public"."attribute_defs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_type_id_entity_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."entity_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_engine_entity_id_entities_id_fk" FOREIGN KEY ("engine_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_defs_type_code_uq" ON "attribute_defs" USING btree ("entity_type_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_values_entity_attr_uq" ON "attribute_values" USING btree ("entity_id","attribute_def_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_types_code_uq" ON "entity_types" USING btree ("code");