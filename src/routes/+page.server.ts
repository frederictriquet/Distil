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

import { type Actions } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { knowledgeBases } from '$lib/server/db/schema';
import { drawCard } from '$lib/server/study';
import { getKnowledgeBaseCounts } from '$lib/server/kb';
import { renderCardMarkdown } from '$lib/server/markdown';
import * as cardActions from '$lib/server/card-actions';

export const load: PageServerLoad = async () => {
	const card = drawCard(db);
	if (!card) {
		// Nothing to draw: surface KB counts so the view can pick a precise empty
		// state (task 12.2) — no KB configured, none in focus, or a focused
		// perimeter with no active cards — each with a useful action. The bookmark
		// panel data (task 8.7) is still loaded so the shape stays stable.
		return {
			card: null,
			kb: getKnowledgeBaseCounts(db),
			annotations: [],
			...cardActions.loadBookmarkData(db)
		};
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
	// Annotation data for this card (tasks 15.6/15.7): the resolved/detached list
	// for the panel plus the body HTML with resolved spans marked for highlight,
	// decorated server-side so the sanitization guarantee (section 7) is kept.
	const annotationData = cardActions.loadAnnotationData(db, bodyHtml, card.id);
	return {
		card: {
			id: card.id,
			title: card.title,
			theme: card.theme,
			level: card.level,
			source: card.sourcePath,
			// Sanitized HTML rendered from the card's markdown body (section 7),
			// with annotated spans marked (task 15.6), safe to inject with {@html}.
			bodyHtml: annotationData.bodyHtml
		},
		annotations: annotationData.annotations,
		// The bookmark panel data (task 8.7): the full category list plus the
		// categories already holding this card, so the panel can pre-mark them.
		...cardActions.loadBookmarkData(db, card.id)
	};
};

// The study action bar (next / theme weighting / bookmark) is shared by every
// card view; these keys delegate to the handlers defined once in
// $lib/server/card-actions. Only named actions are used, per the project's
// SvelteKit action rules.
export const actions: Actions = {
	next: async () => cardActions.next(),
	more: async (event) => cardActions.more(event),
	less: async (event) => cardActions.less(event),
	createCategory: async (event) => cardActions.createCategory(event),
	addBookmarks: async (event) => cardActions.addBookmarks(event),
	annotate: async (event) => cardActions.annotate(event),
	updateAnnotation: async (event) => cardActions.updateAnnotation(event),
	deleteAnnotation: async (event) => cardActions.deleteAnnotation(event)
};
