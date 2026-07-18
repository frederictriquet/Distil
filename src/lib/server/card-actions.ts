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
import {
	createAnnotation,
	deleteAnnotation as removeAnnotation,
	listAnnotationsForCard,
	parseAnchor,
	parseNote,
	updateAnnotationNote
} from '$lib/server/annotations';
import {
	decorateAnnotatedHtml,
	extractTextFromHtml,
	resolveAnnotationsForText,
	type AnnotatedRange
} from '$lib/server/annotation-anchor';

type Db = typeof db;

/**
 * A card's annotation as the view consumes it (tasks 15.6/15.7): its id, note
 * and original quote, plus whether its anchor no longer resolves against the
 * current body (`detached`). Detached annotations are still listed in the panel
 * (task 15.7) but carry no body highlight (their full UX is task 15.9).
 */
export interface AnnotationView {
	id: number;
	note: string;
	quote: string;
	detached: boolean;
}

/**
 * The annotation data every card view needs (tasks 15.6/15.7), loaded from
 * `load` per the project's rule that page data comes from `load`. Given the
 * card's already-sanitized body HTML, it lists the card's annotations, resolves
 * each anchor against the rendered body's plain text (task 15.3), returns them
 * tagged resolved/detached for the panel, and returns the body HTML with the
 * resolved spans marked for highlighting (task 15.6, decorated server-side so
 * the sanitization guarantee is preserved). Passing no card id (nothing drawn)
 * yields an empty list and the body unchanged, keeping the returned shape stable.
 */
export function loadAnnotationData(
	database: Db,
	bodyHtml: string,
	cardId?: number
): { annotations: AnnotationView[]; bodyHtml: string } {
	if (cardId === undefined) {
		return { annotations: [], bodyHtml };
	}
	const stored = listAnnotationsForCard(database, cardId);
	const resolved = resolveAnnotationsForText(extractTextFromHtml(bodyHtml), stored);

	const ranges: AnnotatedRange[] = [];
	for (const item of resolved) {
		if (item.status === 'resolved') {
			ranges.push({ id: item.annotation.id, start: item.range.start, end: item.range.end });
		}
	}

	return {
		annotations: resolved.map((item) => ({
			id: item.annotation.id,
			note: item.annotation.note,
			quote: item.annotation.quote,
			detached: item.status === 'detached'
		})),
		bodyHtml: decorateAnnotatedHtml(bodyHtml, ranges)
	};
}

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

/**
 * Create an annotation on the current card from a text selection captured in the
 * body (task 15.4 client / 15.5 server). The client posts the card id, the note,
 * and the TextQuoteSelector anchor (quote + prefix/suffix context + indicative
 * start offset) derived from the DOM selection. Every externally supplied value
 * is validated at this boundary through the annotations module: an invalid card
 * id, an empty/oversized note, or a malformed anchor answer 400, and a card that
 * no longer exists answers 404 via the handled foreign-key path (never a 500).
 * Like the bookmark actions it returns the created row without redirecting, so
 * the current card stays on screen and the client can reflect it without a
 * redraw.
 */
export async function annotate({ request }: RequestEvent) {
	const data = await request.formData();

	const cardId = parseId(data.get('cardId'));
	if (cardId === null) {
		return fail(400, { action: 'annotate', error: 'Invalid card id.' });
	}

	const noteResult = parseNote(data.get('note'));
	if (!noteResult.ok) {
		return fail(400, { action: 'annotate', error: noteResult.error });
	}

	// The quote/prefix/suffix are compared verbatim against the rendered body's
	// plain text by the anchor resolver, so they must NOT be trimmed here. The
	// offset arrives as a form string; coerce it to a number so parseAnchor can
	// reject a missing/non-numeric value at the boundary.
	const rawOffset = data.get('startOffset');
	const anchorResult = parseAnchor({
		quote: data.get('quote'),
		prefix: data.get('prefix'),
		suffix: data.get('suffix'),
		startOffset: typeof rawOffset === 'string' ? Number(rawOffset) : Number.NaN
	});
	if (!anchorResult.ok) {
		return fail(400, { action: 'annotate', error: anchorResult.error });
	}

	const result = createAnnotation(db, cardId, noteResult.value, anchorResult.value);
	if (!result.ok) {
		return fail(404, { action: 'annotate', error: 'This card no longer exists.' });
	}
	return { action: 'annotate', success: true, annotation: result.value };
}

/**
 * Update an annotation's note from its consultation panel (task 15.8). The note
 * is validated at the boundary through the annotations module (blank/oversized
 * answer 400), and an id that matches no annotation answers 404 rather than a
 * silent ok or a 500. Like the bookmark actions it returns the updated row
 * without redirecting, so the current card stays on screen and the client can
 * reflect the change without a study-card redraw.
 */
export async function updateAnnotation({ request }: RequestEvent) {
	const data = await request.formData();

	const id = parseId(data.get('annotationId'));
	if (id === null) {
		return fail(400, { action: 'updateAnnotation', error: 'Invalid annotation id.' });
	}

	const noteResult = parseNote(data.get('note'));
	if (!noteResult.ok) {
		return fail(400, { action: 'updateAnnotation', error: noteResult.error });
	}

	const updated = updateAnnotationNote(db, id, noteResult.value);
	if (!updated) {
		return fail(404, { action: 'updateAnnotation', error: 'This annotation no longer exists.' });
	}
	return {
		action: 'updateAnnotation',
		success: true,
		annotation: { id: updated.id, note: updated.note, quote: updated.quote }
	};
}

/**
 * Delete an annotation from its consultation panel (task 15.8). An id that
 * matches no annotation answers 404 rather than a silent ok. Returns the removed
 * id without redirecting so the client can drop it from the panel without a
 * study-card redraw.
 */
export async function deleteAnnotation({ request }: RequestEvent) {
	const data = await request.formData();

	const id = parseId(data.get('annotationId'));
	if (id === null) {
		return fail(400, { action: 'deleteAnnotation', error: 'Invalid annotation id.' });
	}

	if (!removeAnnotation(db, id)) {
		return fail(404, { action: 'deleteAnnotation', error: 'This annotation no longer exists.' });
	}
	return { action: 'deleteAnnotation', success: true, id };
}
