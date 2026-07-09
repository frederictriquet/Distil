CREATE TABLE `bookmark_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookmark_categories_name_idx` ON `bookmark_categories` (`name`);--> statement-breakpoint
CREATE TABLE `bookmarks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` integer NOT NULL,
	`category_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `bookmark_categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookmarks_card_id_category_id_idx` ON `bookmarks` (`card_id`,`category_id`);--> statement-breakpoint
CREATE INDEX `bookmarks_category_id_idx` ON `bookmarks` (`category_id`);--> statement-breakpoint
CREATE TABLE `cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kb_id` integer NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`theme` text,
	`level` text,
	`source_path` text,
	`content` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`kb_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cards_kb_id_slug_idx` ON `cards` (`kb_id`,`slug`);--> statement-breakpoint
CREATE INDEX `cards_kb_id_idx` ON `cards` (`kb_id`);--> statement-breakpoint
CREATE INDEX `cards_theme_idx` ON `cards` (`theme`);--> statement-breakpoint
CREATE INDEX `cards_active_idx` ON `cards` (`active`);--> statement-breakpoint
CREATE TABLE `knowledge_bases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`repo_url` text NOT NULL,
	`branch` text NOT NULL,
	`content_subdir` text DEFAULT '' NOT NULL,
	`focus` integer DEFAULT false NOT NULL,
	`last_synced_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_bases_repo_url_branch_idx` ON `knowledge_bases` (`repo_url`,`branch`);--> statement-breakpoint
CREATE TABLE `reading_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` integer NOT NULL,
	`read_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reading_history_card_id_idx` ON `reading_history` (`card_id`);--> statement-breakpoint
CREATE INDEX `reading_history_read_at_idx` ON `reading_history` (`read_at`);--> statement-breakpoint
CREATE TABLE `theme_preferences` (
	`theme` text PRIMARY KEY NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`default_weight` real DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
