// Card consultation by knowledge base + slug (roadmap task 10.1).
//
// This is the target of internal card links (task 7.2 rewrites relative `.md`
// links to `/card/<kbId>/<slug>`, where the slug is the content-root-relative
// path of the card without its `.md` suffix and may contain slashes — hence the
// `[...slug]` rest parameter). It loads the identified card and returns the
// display shape the card page renders (metadata + sanitized markdown body). A
// kbId that is not a positive integer, an empty slug, or a pair matching no
// card, yields a 404. Inactive (soft-deleted) cards remain viewable so a link
// to a deactivated card still resolves. This route sits behind the access guard
// in hooks.server.ts, so it is only reachable with a valid session.

import { error, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { getCardByKbSlug } from '$lib/server/card';
import * as cardActions from '$lib/server/card-actions';

export const load: PageServerLoad = async ({ params }) => {
	const kbId = Number(params.kbId);
	const slug = params.slug;
	if (!Number.isInteger(kbId) || kbId <= 0 || slug.length === 0) {
		error(404, 'Card not found');
	}

	const card = getCardByKbSlug(db, kbId, slug);
	if (!card) {
		error(404, 'Card not found');
	}

	// The same action bar the study view shows is available on every card
	// (next / theme weighting / bookmark), so this consultation page loads the
	// bookmark panel data too (task 8.7).
	return { card, ...cardActions.loadBookmarkData(db, card.id) };
};

// Every card exposes the study action bar however it is reached; these keys
// delegate to the shared handlers so the behavior is identical across routes.
// Only named actions are used, per the project's SvelteKit action rules.
export const actions: Actions = {
	next: async () => cardActions.next(),
	more: async (event) => cardActions.more(event),
	less: async (event) => cardActions.less(event),
	createCategory: async (event) => cardActions.createCategory(event),
	addBookmarks: async (event) => cardActions.addBookmarks(event)
};
