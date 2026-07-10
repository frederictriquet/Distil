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

import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { getCardByKbSlug } from '$lib/server/card';

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

	return { card };
};
