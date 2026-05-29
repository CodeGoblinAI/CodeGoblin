CREATE TABLE `memory_entry` (
	`id` text PRIMARY KEY,
	`scope` text NOT NULL,
	`project_id` text,
	`source_session_id` text,
	`content` text NOT NULL,
	`tags` text,
	`pinned` integer DEFAULT false NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`time_archived` integer
);
--> statement-breakpoint
CREATE INDEX `memory_entry_scope_idx` ON `memory_entry` (`scope`);--> statement-breakpoint
CREATE INDEX `memory_entry_project_idx` ON `memory_entry` (`project_id`);--> statement-breakpoint
CREATE INDEX `memory_entry_archived_idx` ON `memory_entry` (`time_archived`);