// Study view server logic (roadmap section 8: weighted draw + study view).
//
// `load` draws one card from the eligible pool weighted by theme (8.1) and
// returns the card fields the view renders (8.3). It deliberately does NOT
// record the reading (8.2): `load` runs on every GET of `/` — including
// SvelteKit hover/tap preloads, back/forward navigation, refreshes, and
// programmatic preloads — none of which necessarily present the card to the
// user. Recording here logged "phantom" readings that polluted reading_history
// and skewed the recency exclusion (it could even record a card never shown on
// screen). Recording is instead driven by an explicit client signal once the
// card is actually mounted/displayed (see +page.svelte and
// src/routes/readings/+server.ts), so a preload — which never mounts the
// component — records nothing. This route sits behind the access guard in
// hooks.server.ts, so it is only reachable with a valid session.
//
// Actions redraw via POST-redirect-GET: they mutate (or simply advance) and
// then redirect back to `/`, so the subsequent `load` performs a single fresh
// draw (no double draw) that reflects any weight change and excludes the card
// just shown. Only named actions are used (no `default`), per the project's
// SvelteKit action rules.

import { fail, redirect, type Actions } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { knowledgeBases } from '$lib/server/db/schema';
import { adjustThemeWeight, drawCard } from '$lib/server/study';
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
	// Advancing to the next card is a plain POST-redirect-GET: the redraw and its
	// reading happen in `load` on the following GET, which excludes the card just
	// shown so it does not immediately repeat (task 8.4).
	next: async () => {
		redirect(303, '/');
	},
	more: adjust('more', 'up'),
	less: adjust('less', 'down')
};
