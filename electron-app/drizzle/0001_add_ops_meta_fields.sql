ALTER TABLE `operations` ADD COLUMN `performed_at` integer;
--> statement-breakpoint
ALTER TABLE `operations` ADD COLUMN `performed_by` text;
--> statement-breakpoint
ALTER TABLE `operations` ADD COLUMN `meta_json` text;


