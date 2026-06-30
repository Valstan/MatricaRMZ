CREATE TABLE `card_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`card_type` text NOT NULL,
	`card_id` text NOT NULL,
	`kind` text DEFAULT 'recovery' NOT NULL,
	`title` text,
	`payload_json` text,
	`base_updated_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `card_drafts_owner_kind_idx` ON `card_drafts` (`owner_user_id`,`kind`);--> statement-breakpoint
CREATE INDEX `card_drafts_owner_card_idx` ON `card_drafts` (`owner_user_id`,`card_type`,`card_id`);--> statement-breakpoint
CREATE INDEX `card_drafts_sync_status_idx` ON `card_drafts` (`sync_status`);
