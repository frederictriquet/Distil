// Study view server logic (roadmap section 8: weighted draw + study view).
//
// `load` draws one card from the eligible pool weighted by theme (8.1) and
// records the reading (8.2) so the recency exclusion works and history is
// preserved; it returns the card fields the view renders (8.3). The form
// actions draw the next card (8.4) and adjust the current card's theme weight
// up/down (8.5). This route sits behind the access guard in hooks.server.ts, so
// it is only reachable with a valid session.
//
// Actions redraw via POST-redirect-GET: they mutate (or simply advance) and
// then redirect back to `/`, so the subsequent `load` performs a single fresh
// draw + reading (no double draw) that reflects any weight change and excludes
// the card just shown. Only named actions are used (no `default`), per the
// project's SvelteKit action rules.

import { fail, redirect, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { adjustThemeWeight, drawCard, recordReading } from '$lib/server/study';

export const load: PageServerLoad = async () => {
	const card = drawCard(db);
	if (!card) {
		return { card: null };
	}
	recordReading(db, card.id);
	return {
		card: {
			id: card.id,
			title: card.title,
			theme: card.theme,
			level: card.level,
			source: card.sourcePath,
			// Raw markdown body. Roadmap 7 (markdown -> sanitized HTML) is not built
			// yet, so the view renders this as escaped plain text (never as HTML).
			body: card.content
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
