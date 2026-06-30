ALTER TABLE "timesheets" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN "allow_others_edit" boolean DEFAULT false NOT NULL;
