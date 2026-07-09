// Drizzle (SQLite) schema for Distil.
//
// Entities:
//   - knowledgeBases  : the git-backed knowledge bases (KB) the app ingests.
//   - cards           : individual study cards ("fiches"), belonging to a KB.
//   - themePreferences: per-theme weighting used by the weighted random draw.
//   - bookmarkCategories / bookmarks : user bookmarks grouped by category.
//   - readingHistory  : one row per card view, used to avoid recently seen cards.
//
// Design notes:
//   - Cards are soft-deleted through the `active` flag: reconciliation
//     (ROADMAP 5.5) disables cards that disappeared from the repo instead of
//     removing them, so bookmarks and reading history that reference them are
//     never destroyed when a card is merely deactivated.
//   - Foreign keys use ON DELETE CASCADE only for genuine hard deletes
//     (removing a KB purges its cards; removing a category purges its
//     bookmarks). Toggling `active` never triggers those cascades.
import { sql } from 'drizzle-orm';
import { integer, real, sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

/** Git-backed knowledge bases that Distil clones and ingests cards from. */
export const knowledgeBases = sqliteTable(
	'knowledge_bases',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		/** Human-readable name shown in the KB management page. */
		name: text('name').notNull(),
		/** URL of the git repository backing this KB. */
		repoUrl: text('repo_url').notNull(),
		/** Git branch to track. */
		branch: text('branch').notNull(),
		/** Sub-directory inside the repo that holds the content markdown files. */
		contentSubdir: text('content_subdir').notNull().default(''),
		/** Whether the KB is part of the current study focus (enabled/disabled). */
		focus: integer('focus', { mode: 'boolean' }).notNull().default(false),
		/** Timestamp of the last successful synchronisation, null if never synced. */
		lastSyncedAt: integer('last_synced_at', { mode: 'timestamp' }),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer('updated_at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(unixepoch())`)
			.$onUpdate(() => new Date())
	},
	(table) => [uniqueIndex('knowledge_bases_repo_url_branch_idx').on(table.repoUrl, table.branch)]
);

/** A study card ("fiche") ingested from a knowledge base. */
export const cards = sqliteTable(
	'cards',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		/** Owning knowledge base; cards are removed when their KB is deleted. */
		kbId: integer('kb_id')
			.notNull()
			.references(() => knowledgeBases.id, { onDelete: 'cascade' }),
		/** Stable slug/identifier of the card within its KB. */
		slug: text('slug').notNull(),
		title: text('title').notNull(),
		/** Theme used for the weighted draw; links to themePreferences.theme. */
		theme: text('theme'),
		/** Difficulty level, as declared in the card frontmatter. */
		level: text('level'),
		/** Source path of the markdown file inside the repo. */
		sourcePath: text('source_path'),
		/** Raw markdown body of the card. */
		content: text('content'),
		/** Soft-delete flag: inactive cards are kept so user data survives. */
		active: integer('active', { mode: 'boolean' }).notNull().default(true),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer('updated_at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(unixepoch())`)
			.$onUpdate(() => new Date())
	},
	(table) => [
		uniqueIndex('cards_kb_id_slug_idx').on(table.kbId, table.slug),
		index('cards_kb_id_idx').on(table.kbId),
		index('cards_theme_idx').on(table.theme),
		index('cards_active_idx').on(table.active)
	]
);

/** Per-theme preferences driving the weighted random draw (ROADMAP 7.x). */
export const themePreferences = sqliteTable('theme_preferences', {
	/** Theme name; one preference row per distinct theme. */
	theme: text('theme').primaryKey(),
	/** Current weight applied to this theme in the weighted draw. */
	weight: real('weight').notNull().default(1),
	/** Default weight, used to reset the theme back to its baseline. */
	defaultWeight: real('default_weight').notNull().default(1),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.default(sql`(unixepoch())`),
	updatedAt: integer('updated_at', { mode: 'timestamp' })
		.notNull()
		.default(sql`(unixepoch())`)
		.$onUpdate(() => new Date())
});

/** User-defined categories used to group bookmarks. */
export const bookmarkCategories = sqliteTable(
	'bookmark_categories',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		name: text('name').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(unixepoch())`)
	},
	(table) => [uniqueIndex('bookmark_categories_name_idx').on(table.name)]
);

/** A bookmark linking a card to a category. */
export const bookmarks = sqliteTable(
	'bookmarks',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		/** Bookmarked card; cascades only on a genuine card deletion. */
		cardId: integer('card_id')
			.notNull()
			.references(() => cards.id, { onDelete: 'cascade' }),
		/** Owning category; deleting a category removes its bookmarks. */
		categoryId: integer('category_id')
			.notNull()
			.references(() => bookmarkCategories.id, { onDelete: 'cascade' }),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(unixepoch())`)
	},
	(table) => [
		uniqueIndex('bookmarks_card_id_category_id_idx').on(table.cardId, table.categoryId),
		index('bookmarks_category_id_idx').on(table.categoryId)
	]
);

/** One row per card view, used to exclude recently seen cards from the draw. */
export const readingHistory = sqliteTable(
	'reading_history',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		/** Card that was read; cascades only on a genuine card deletion. */
		cardId: integer('card_id')
			.notNull()
			.references(() => cards.id, { onDelete: 'cascade' }),
		readAt: integer('read_at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(unixepoch())`)
	},
	(table) => [index('reading_history_card_id_idx').on(table.cardId), index('reading_history_read_at_idx').on(table.readAt)]
);
