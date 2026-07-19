CREATE TABLE `ai_chat_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`username` text NOT NULL,
	`question_text` text NOT NULL,
	`question_file_json` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`answer_text` text,
	`answer_files_json` text,
	`answered_at` integer,
	`escalation_note` text,
	`verdict_text` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_server_seq` integer,
	`deleted_at` integer,
	`sync_status` text DEFAULT 'synced' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_chat_requests_user_created_idx` ON `ai_chat_requests` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_chat_requests_status_idx` ON `ai_chat_requests` (`status`);--> statement-breakpoint
CREATE INDEX `ai_chat_requests_sync_status_idx` ON `ai_chat_requests` (`sync_status`);
