// Card consultation by numeric id (roadmap task 10.1).
//
// This is the target of bookmark navigation (task 9.3 links to `/cards/<id>`).
// It loads the identified card and returns the display shape the card page
// renders (metadata + sanitized markdown body). An id that is not a positive
// integer, or that matches no card, yields a 404. Inactive (soft-deleted) cards
// remain viewable so a bookmark to a card that later left its repo still opens.
// This route sits behind the access guard in hooks.server.ts, so it is only
// reachable with a valid session.

import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { getCardById } from '$lib/server/card';

export const load: PageServerLoad = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) {
		error(404, 'Card not found');
	}

	const card = getCardById(db, id);
	if (!card) {
		error(404, 'Card not found');
	}

	return { card };
};
