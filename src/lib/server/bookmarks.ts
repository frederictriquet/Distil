// Bookmark logic for Distil (roadmap tasks 9.1–9.3).
//
// This module holds the core behind the /bookmarks page: CRUD on bookmark
// categories (9.1), adding/removing a bookmark that links a card to a category
// (9.2), and listing bookmarks grouped by category for the list page (9.3).
//
// Like `kb.ts`, it is intentionally free of SvelteKit imports: every function
// takes an explicit Drizzle handle so the logic stays pure and unit-testable
// outside a running server. The SvelteKit glue (+page.server.ts) reads the
// request and calls into here.
//
// The schema (task 2.1) enforces the invariants we translate here into handled
// results: a unique category name, a unique (cardId, categoryId) pair, and an
// ON DELETE CASCADE from a category to its bookmarks. Duplicate insertions
// therefore surface as SQLite unique-constraint errors that callers map to a
// 4xx rather than letting them crash with a 500.

import { and, asc, eq } from 'drizzle-orm';
import { bookmarkCategories, bookmarks, cards } from './db/schema';
import type { createDb } from './db';

/** The shared Drizzle database handle type. */
type Db = ReturnType<typeof createDb>;

/** A bookmark category, as listed on the bookmarks page. */
export interface BookmarkCategory {
	id: number;
	name: string;
}

/** A single bookmarked card within a category, for the list page. */
export interface BookmarkEntry {
	bookmarkId: number;
	cardId: number;
	cardTitle: string;
	cardSlug: string;
	cardActive: boolean;
}

/** A category together with the bookmarks it holds (empty categories included). */
export interface BookmarkCategoryWithBookmarks extends BookmarkCategory {
	bookmarks: BookmarkEntry[];
}

/** Result of validating a raw category name from form input. */
export type ParseCategoryNameResult =
	| { ok: true; value: string }
	| { ok: false; error: string };

/**
 * Validate and normalise a raw category name (task 9.1): it must be a non-blank
 * string; surrounding whitespace is trimmed. Returns the trimmed value on
 * success or a single error message on failure.
 */
export function parseCategoryName(raw: unknown): ParseCategoryNameResult {
	const name = typeof raw === 'string' ? raw.trim() : '';
	if (name.length === 0) {
		return { ok: false, error: 'Category name is required.' };
	}
	return { ok: true, value: name };
}

/**
 * True when `error` carries the given SQLite constraint `code` somewhere in its
 * `cause` chain. Drizzle can surface the driver error either directly or wrapped
 * (e.g. a `DrizzleQueryError` exposing the original via `cause`), so we walk the
 * chain rather than only inspecting the top-level error.
 */
function hasSqliteErrorCode(error: unknown, code: string): boolean {
	for (let current: unknown = error; current !== null && current !== undefined; ) {
		if (
			typeof current === 'object' &&
			'code' in current &&
			(current as { code?: unknown }).code === code
		) {
			return true;
		}
		current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
	}
	return false;
}

/**
 * True when `error` is a SQLite unique-constraint violation. Both the duplicate
 * category name and the duplicate (cardId, categoryId) bookmark are enforced by
 * unique indexes, so callers use this to map either to a 4xx instead of a 500.
 */
export function isUniqueConstraintError(error: unknown): boolean {
	return hasSqliteErrorCode(error, 'SQLITE_CONSTRAINT_UNIQUE');
}

/**
 * True when `error` is a SQLite foreign-key constraint violation. `foreign_keys`
 * is ON (see db/index.ts), so bookmarking a card or category that no longer
 * exists (e.g. a stale study tab whose card was cascade-removed, or a category
 * deleted in another tab) raises this; callers map it to a 404 instead of a 500.
 */
export function isForeignKeyConstraintError(error: unknown): boolean {
	return hasSqliteErrorCode(error, 'SQLITE_CONSTRAINT_FOREIGNKEY');
}

/** List all bookmark categories, ordered by name then id for a stable display. */
export function listBookmarkCategories(db: Db): BookmarkCategory[] {
	return db
		.select({ id: bookmarkCategories.id, name: bookmarkCategories.name })
		.from(bookmarkCategories)
		.orderBy(asc(bookmarkCategories.name), asc(bookmarkCategories.id))
		.all();
}

/**
 * Insert a new bookmark category from a validated name and return the created
 * row. The schema enforces a unique name, so inserting a duplicate throws a
 * SQLite `SQLITE_CONSTRAINT_UNIQUE` error; callers guard with
 * {@link isUniqueConstraintError} to surface it as a 4xx form error.
 */
export function createBookmarkCategory(db: Db, name: string): BookmarkCategory {
	return db.insert(bookmarkCategories).values({ name }).returning({
		id: bookmarkCategories.id,
		name: bookmarkCategories.name
	}).get();
}

/**
 * Rename a bookmark category. Returns the updated row, or `undefined` when no
 * category with that id exists (so the caller can report a 404 rather than a
 * silent ok). Renaming to a name already used by another category throws a
 * unique-constraint error, mapped to a 4xx by the caller.
 */
export function renameBookmarkCategory(db: Db, id: number, name: string): BookmarkCategory | undefined {
	return db
		.update(bookmarkCategories)
		.set({ name })
		.where(eq(bookmarkCategories.id, id))
		.returning({ id: bookmarkCategories.id, name: bookmarkCategories.name })
		.get();
}

/**
 * Delete a bookmark category. Its bookmarks are removed through the schema's
 * ON DELETE CASCADE. Returns whether a row was actually removed, so callers can
 * report a missing id as a 404.
 */
export function deleteBookmarkCategory(db: Db, id: number): boolean {
	return db.delete(bookmarkCategories).where(eq(bookmarkCategories.id, id)).run().changes > 0;
}

/**
 * Outcome of adding a bookmark: created, already present (`duplicate`), or
 * referencing a card/category that no longer exists (`missing-reference`).
 */
export type AddBookmarkResult =
	| { ok: true; created: true }
	| { ok: false; reason: 'duplicate' | 'missing-reference' };

/**
 * Bookmark a card into a category (task 9.2). Idempotent: the schema enforces a
 * unique (cardId, categoryId) pair, so a second call for the same pair is caught
 * and reported as `{ ok: false, reason: 'duplicate' }` instead of throwing a 500.
 * A card or category that no longer exists trips the foreign-key constraint and
 * is reported as `{ ok: false, reason: 'missing-reference' }` (mapped to a 404).
 * On a fresh insert it returns `{ ok: true, created: true }`.
 */
export function addBookmark(db: Db, cardId: number, categoryId: number): AddBookmarkResult {
	try {
		db.insert(bookmarks).values({ cardId, categoryId }).run();
		return { ok: true, created: true };
	} catch (error) {
		if (isUniqueConstraintError(error)) {
			return { ok: false, reason: 'duplicate' };
		}
		if (isForeignKeyConstraintError(error)) {
			return { ok: false, reason: 'missing-reference' };
		}
		throw error;
	}
}

/**
 * Remove the bookmark linking `cardId` to `categoryId` (task 9.2, toggle
 * semantics; also the per-entry removal on the list page, task 9.3). Returns
 * whether a bookmark was actually removed, so callers can report a missing pair
 * as a 404.
 */
export function removeBookmark(db: Db, cardId: number, categoryId: number): boolean {
	return db
		.delete(bookmarks)
		.where(and(eq(bookmarks.cardId, cardId), eq(bookmarks.categoryId, categoryId)))
		.run().changes > 0;
}

/**
 * List every category with the bookmarks it holds (task 9.3), joined to the
 * bookmarked card for its title/identity. Categories with no bookmarks are kept
 * (so the page can show them) with an empty `bookmarks` array. Categories are
 * ordered by name, and bookmarks within a category by card title.
 */
export function listBookmarksByCategory(db: Db): BookmarkCategoryWithBookmarks[] {
	const rows = db
		.select({
			categoryId: bookmarkCategories.id,
			categoryName: bookmarkCategories.name,
			bookmarkId: bookmarks.id,
			cardId: cards.id,
			cardTitle: cards.title,
			cardSlug: cards.slug,
			cardActive: cards.active
		})
		.from(bookmarkCategories)
		.leftJoin(bookmarks, eq(bookmarks.categoryId, bookmarkCategories.id))
		.leftJoin(cards, eq(cards.id, bookmarks.cardId))
		.orderBy(asc(bookmarkCategories.name), asc(bookmarkCategories.id), asc(cards.title))
		.all();

	const categories: BookmarkCategoryWithBookmarks[] = [];
	let current: BookmarkCategoryWithBookmarks | undefined;
	for (const row of rows) {
		if (!current || current.id !== row.categoryId) {
			current = { id: row.categoryId, name: row.categoryName, bookmarks: [] };
			categories.push(current);
		}
		// A left join with no matching bookmark yields a null bookmarkId row.
		if (row.bookmarkId !== null && row.cardId !== null) {
			current.bookmarks.push({
				bookmarkId: row.bookmarkId,
				cardId: row.cardId,
				cardTitle: row.cardTitle ?? '',
				cardSlug: row.cardSlug ?? '',
				cardActive: row.cardActive ?? true
			});
		}
	}
	return categories;
}
