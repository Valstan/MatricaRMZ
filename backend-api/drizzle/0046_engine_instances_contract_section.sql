ALTER TABLE "erp_engine_instances" ADD COLUMN IF NOT EXISTS "contract_section_number" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_engine_instances_contract_section_idx" ON "erp_engine_instances" USING btree ("contract_section_number");