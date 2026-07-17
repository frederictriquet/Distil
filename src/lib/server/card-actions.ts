// Shared card action handlers and load helpers (roadmap sections 8.4/8.5/8.7).
//
// The study view (`/`) and the card consultation pages (`/cards/<id>` and
// `/card/<kbId>/<slug>`) now expose the same action bar on every card, however
// it is reached: advance to the next draw (8.4), adjust a theme's weight
// (8.5), and bookmark the card (8.7). Those handlers used to live inline in the
// study route only; they are factored here so all three routes bind the exact
// same behavior instead of duplicating it. Each route still declares its own
// `actions` object (SvelteKit requires per-route action keys, and the
// action/route contract test asserts the literal shape), but every key just
// delegates to a handler defined once here.
//
// Like the other `$lib/server` modules the load helper takes an explicit
// Drizzle handle. The handlers depend on the singleton `db` because they are
// wired directly as SvelteKit action values.

import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { adjustThemeWeight } from '$lib/server/study';
import {
	addBookmark,
	createBookmarkCategory,
	isUniqueConstraintError,
	listBookmarkCategories,
	listBookmarkedCategoryIdsForCard,
	parseCategoryName,
	type BookmarkCategory
} from '$lib/server/bookmarks';

type Db = typeof db;

/**
 * The bookmark panel data every card view needs (task 8.7): the full category
 * list, and which categories already hold the card so the panel can pre-mark
 * them. Loaded from `load` per the project's rule that page data comes from
 * `load`. Passing no card id (nothing drawn) yields an empty bookmarked set.
 */
export function loadBookmarkData(
	database: Db,
	cardId?: number
): { categories: BookmarkCategory[]; bookmarkedCategoryIds: number[] } {
	return {
		categories: listBookmarkCategories(database),
		bookmarkedCategoryIds: cardId === undefined ? [] : listBookmarkedCategoryIdsForCard(database, cardId)
	};
}

/** Read a form field as a trimmed string, defaulting to '' for missing/file entries. */
function formString(value: FormDataEntryValue | null): string {
	return typeof value === 'string' ? value.trim() : '';
}

/** Parse a required positive-integer id from form data; returns null when invalid. */
function parseId(value: FormDataEntryValue | null): number | null {
	if (typeof value !== 'string') {
		return null;
	}
	const id = Number(value);
	return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Advance to the next card (task 8.4): a plain POST-redirect-GET back to the
 * study view, whose `load` performs a single fresh draw. Works identically from
 * a consultation page — it leaves consultation and draws the next study card.
 */
export async function next(): Promise<never> {
	redirect(303, '/');
}

/** Shared handler for the two weight-adjustment actions (task 8.5). */
function adjust(action: 'more' | 'less', direction: 'up' | 'down') {
	return async ({ request }: RequestEvent): Promise<never | ReturnType<typeof fail>> => {
		const data = await request.formData();
		const theme = formString(data.get('theme'));
		// Validate the externally supplied theme at the boundary rather than
		// accepting any value: a card with no theme has nothing to adjust.
		if (theme.length === 0) {
			return fail(400, { action, error: 'A theme is required to adjust its weight.' });
		}
		adjustThemeWeight(db, theme, direction);
		// Redraw so the next card reflects the changed weight.
		redirect(303, '/');
	};
}

/** "More of this theme" (task 8.5): raise the theme weight, then redraw. */
export const more = adjust('more', 'up');

/** "Less of this theme" (task 8.5): lower the theme weight, then redraw. */
export const less = adjust('less', 'down');

/**
 * Create a new bookmark category inline from the panel (task 8.7), reusing the
 * same core logic as the /bookmarks page. Returns the created row so the client
 * can add and pre-select it without a redraw (a redirect here would draw a
 * different card and lose the one being bookmarked). Statuses are consistent
 * across the app.
 */
export async function createCategory({ request }: RequestEvent) {
	const data = await request.formData();
	const name = formString(data.get('name'));

	const parsed = parseCategoryName(name);
	if (!parsed.ok) {
		return fail(400, { action: 'createCategory', error: parsed.error, name });
	}

	let category;
	try {
		category = createBookmarkCategory(db, parsed.value);
	} catch (error) {
		// The schema's unique name index rejects duplicates; map that expected
		// failure to a form error rather than a 500.
		if (isUniqueConstraintError(error)) {
			return fail(409, {
				action: 'createCategory',
				error: 'A category with this name already exists.',
				name
			});
		}
		throw error;
	}
	return { action: 'createCategory', success: true, category };
}

/**
 * Save the current card into every selected category (task 8.7). Idempotent
 * and robust: a category the card is already bookmarked in is a no-op (never a
 * 500), so one duplicate does not fail the others. Reuses addBookmark, which
 * already maps the unique/foreign-key constraints to handled results.
 */
export async function addBookmarks({ request }: RequestEvent) {
	const data = await request.formData();
	const cardId = parseId(data.get('cardId'));
	if (cardId === null) {
		return fail(400, { action: 'addBookmarks', error: 'Invalid card id.' });
	}

	const rawIds = data.getAll('categoryId');
	const categoryIds: number[] = [];
	for (const raw of rawIds) {
		const id = parseId(raw);
		if (id === null) {
			return fail(400, { action: 'addBookmarks', error: 'Invalid category id.' });
		}
		categoryIds.push(id);
	}
	if (categoryIds.length === 0) {
		return fail(400, { action: 'addBookmarks', error: 'Select at least one category.' });
	}

	// Attempt every category before reporting: a duplicate is a successful
	// no-op, and a missing reference is recorded but does not abort the rest.
	let missingReference = false;
	for (const categoryId of categoryIds) {
		const result = addBookmark(db, cardId, categoryId);
		if (!result.ok && result.reason === 'missing-reference') {
			missingReference = true;
		}
	}
	if (missingReference) {
		return fail(404, {
			action: 'addBookmarks',
			error: 'A card or category no longer exists.'
		});
	}
	return {
		action: 'addBookmarks',
		success: true,
		bookmarkedCategoryIds: listBookmarkedCategoryIdsForCard(db, cardId)
	};
}
