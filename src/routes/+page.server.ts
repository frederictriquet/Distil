// Study view server logic (roadmap section 8: weighted draw + study view).
//
// `load` draws one card from the eligible pool weighted by theme (8.1) and
// returns the card fields the view renders (8.3). It deliberately does NOT
// record the reading (8.2): `load` runs on every GET of `/` — including
// SvelteKit hover/tap preloads, back/forward navigation, refreshes, and
// programmatic preloads — none of which necessarily present the card to the
// user. Recording here logged "phantom" readings that polluted reading_history
// and skewed the recency exclusion (it could even record a card never shown on
// screen).
//
// Recording is decoupled from drawing and driven by an explicit client signal:
// once the drawn card is actually mounted on screen, the view POSTs it to the
// dedicated /readings endpoint from `afterNavigate` (see src/routes/+page.svelte
// and src/routes/readings/+server.ts). A preload only ever runs this `load` —
// it never mounts the component — so it fires no signal and records nothing.
// This route sits behind the access guard in hooks.server.ts, so it is only
// reachable with a valid session.
//
// The form actions redraw via POST-redirect-GET: they advance (or adjust a
// theme weight) and redirect back to `/`, so the subsequent `load` performs a
// single fresh draw (no double draw). They no longer record anything — that is
// entirely the client "card shown" signal's job — which keeps a single card
// recorded exactly once, when it is genuinely presented. Only named actions are
// used (no `default`), per the project's SvelteKit action rules.

import { fail, redirect, type Actions } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { knowledgeBases } from '$lib/server/db/schema';
import { adjustThemeWeight, drawCard } from '$lib/server/study';
import { getKnowledgeBaseCounts } from '$lib/server/kb';
import { renderCardMarkdown } from '$lib/server/markdown';
import {
	addBookmark,
	createBookmarkCategory,
	isUniqueConstraintError,
	listBookmarkCategories,
	listBookmarkedCategoryIdsForCard,
	parseCategoryName
} from '$lib/server/bookmarks';

export const load: PageServerLoad = async () => {
	const card = drawCard(db);
	// The bookmark panel (task 8.7) lists every category so the user can save the
	// current card into one or more of them; loaded here per the project's rule
	// that page data comes from `load`.
	const categories = listBookmarkCategories(db);
	if (!card) {
		// Nothing to draw: surface KB counts so the view can pick a precise empty
		// state (task 12.2) — no KB configured, none in focus, or a focused
		// perimeter with no active cards — each with a useful action.
		return { card: null, kb: getKnowledgeBaseCounts(db), categories, bookmarkedCategoryIds: [] };
	}
	// Render the markdown body through the canonical module (roadmap section 7):
	// it produces sanitized HTML with highlighted code and internal links
	// rewritten to in-app card routes. Resolving those relative links needs the
	// KB's content sub-directory alongside the card's own source path.
	const kb = db
		.select({ contentSubdir: knowledgeBases.contentSubdir })
		.from(knowledgeBases)
		.where(eq(knowledgeBases.id, card.kbId))
		.get();
	const bodyHtml = renderCardMarkdown(card.content, {
		kbId: card.kbId,
		sourcePath: card.sourcePath,
		contentSubdir: kb?.contentSubdir ?? ''
	});
	return {
		card: {
			id: card.id,
			title: card.title,
			theme: card.theme,
			level: card.level,
			source: card.sourcePath,
			// Sanitized HTML rendered from the card's markdown body (section 7),
			// safe to inject with {@html} in the view.
			bodyHtml
		},
		categories,
		// Categories that already hold this card, so the panel can pre-mark them
		// (task 8.7).
		bookmarkedCategoryIds: listBookmarkedCategoryIdsForCard(db, card.id)
	};
};

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

/** Shared handler for the two weight-adjustment actions (task 8.5). */
function adjust(action: 'more' | 'less', direction: 'up' | 'down') {
	return async ({ request }: { request: Request }) => {
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

export const actions: Actions = {
	// Advancing to the next card is a plain POST-redirect-GET: the redraw happens
	// in `load` on the following GET, and the card just shown was already recorded
	// by the client "card shown" signal, so it is excluded and does not
	// immediately repeat (task 8.4). No recording happens here.
	next: async () => {
		redirect(303, '/');
	},
	more: adjust('more', 'up'),
	less: adjust('less', 'down'),

	// Create a new bookmark category inline from the study panel (task 8.7),
	// reusing the same core logic as the /bookmarks page. Returns the created row
	// so the client can add and pre-select it without a redraw (a redirect here
	// would draw a different card and lose the one being bookmarked). Only named
	// actions are used, with statuses consistent across the app.
	createCategory: async ({ request }) => {
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
	},

	// Save the current card into every selected category (task 8.7). Idempotent
	// and robust: a category the card is already bookmarked in is a no-op (never a
	// 500), so one duplicate does not fail the others. Reuses addBookmark, which
	// already maps the unique/foreign-key constraints to handled results.
	addBookmarks: async ({ request }) => {
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
};
