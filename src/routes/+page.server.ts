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
// Recording is instead tied to a genuine, intentional interaction: advancing
// away from a card. The study view stamps the drawn card's id into a hidden
// `cardId` field on each POST-redirect-GET form, and the `next`/`more`/`less`
// actions record that card as read (task 8.2) *before* redrawing. Because this
// happens server-side on the form POST, it works with client JS disabled and is
// strictly ordered before the next draw's recency query — no fire-and-forget
// client request that could race the redraw. A preload, back/forward or refresh
// is only ever a GET, which still never records. (The dedicated
// src/routes/readings/+server.ts endpoint offers the same recording as an
// explicit programmatic "card shown" signal and is validated identically.) This
// route sits behind the access guard in hooks.server.ts, so it is only
// reachable with a valid session.
//
// Actions redraw via POST-redirect-GET: they record the card just shown, then
// redirect back to `/`, so the subsequent `load` performs a single fresh draw
// (no double draw) that reflects any weight change and excludes the card just
// recorded. Only named actions are used (no `default`), per the project's
// SvelteKit action rules.

import { fail, redirect, type Actions } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { cards, knowledgeBases } from '$lib/server/db/schema';
import { adjustThemeWeight, drawCard, recordReading } from '$lib/server/study';
import { renderCardMarkdown } from '$lib/server/markdown';

export const load: PageServerLoad = async () => {
	const card = drawCard(db);
	if (!card) {
		return { card: null };
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
		}
	};
};

/** Read a form field as a trimmed string, defaulting to '' for missing/file entries. */
function formString(value: FormDataEntryValue | null): string {
	return typeof value === 'string' ? value.trim() : '';
}

/**
 * Record the card the user is advancing away from as genuinely read (task 8.2),
 * from the hidden `cardId` the study view stamps into each POST-redirect-GET
 * form. This runs server-side, before the redraw, so it works without client JS
 * and is strictly ordered before the next draw's recency query (no race with a
 * client request). A missing or malformed id, or one that names no existing
 * card, is simply not recorded: advancing must still succeed (this is not a
 * boundary the user drives directly), and only a real card can be inserted
 * without violating the reading_history foreign key.
 */
function recordShownCard(data: FormData): void {
	const raw = data.get('cardId');
	const cardId = typeof raw === 'string' ? Number(raw) : NaN;
	if (!Number.isInteger(cardId) || cardId <= 0) {
		return;
	}
	const existing = db.select({ id: cards.id }).from(cards).where(eq(cards.id, cardId)).get();
	if (existing) {
		recordReading(db, cardId);
	}
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
		// "More/less" also advances to a fresh card, so record the one just shown
		// before redrawing so it is excluded from the redraw, exactly like "next".
		recordShownCard(data);
		// Redraw so the next card reflects the changed weight.
		redirect(303, '/');
	};
}

export const actions: Actions = {
	// Advancing to the next card is a POST-redirect-GET. Record the card just
	// shown here, before redirecting, so the following GET's draw excludes it and
	// it does not immediately repeat (task 8.4). Recording on the POST keeps it
	// working without JS and ordered ahead of the redraw's recency query.
	next: async ({ request }) => {
		recordShownCard(await request.formData());
		redirect(303, '/');
	},
	more: adjust('more', 'up'),
	less: adjust('less', 'down')
};
