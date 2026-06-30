CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`title` text NOT NULL,
	`body_json` text,
	`importance` text DEFAULT 'normal' NOT NULL,
	`due_at` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notes_owner_sort_idx` ON `notes` (`owner_user_id`,`sort_order`);
--> statement-breakpoint
CREATE INDEX `notes_sync_status_idx` ON `notes` (`sync_status`);
--> statement-breakpoint
CREATE TABLE `note_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL,
	`recipient_user_id` text NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `note_shares_note_recipient_uq` ON `note_shares` (`note_id`,`recipient_user_id`);
--> statement-breakpoint
CREATE INDEX `note_shares_recipient_sort_idx` ON `note_shares` (`recipient_user_id`,`sort_order`);
--> statement-breakpoint
CREATE INDEX `note_shares_sync_status_idx` ON `note_shares` (`sync_status`);
