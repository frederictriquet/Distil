// Card consultation by numeric id (roadmap task 10.1).
//
// This is the target of bookmark navigation (task 9.3 links to `/cards/<id>`).
// It loads the identified card and returns the display shape the card page
// renders (metadata + sanitized markdown body). An id that is not a positive
// integer, or that matches no card, yields a 404. Inactive (soft-deleted) cards
// remain viewable so a bookmark to a card that later left its repo still opens.
// This route sits behind the access guard in hooks.server.ts, so it is only
// reachable with a valid session.

import { error, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { getCardById } from '$lib/server/card';
import * as cardActions from '$lib/server/card-actions';

export const load: PageServerLoad = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) {
		error(404, 'Card not found');
	}

	const card = getCardById(db, id);
	if (!card) {
		error(404, 'Card not found');
	}

	// Annotation data for this card (tasks 15.6/15.7): the resolved/detached list
	// for the panel plus the body HTML with resolved spans marked for highlight,
	// decorated server-side so the sanitization guarantee (section 7) is kept.
	const annotationData = cardActions.loadAnnotationData(db, card.bodyHtml, card.id);
	// The same action bar the study view shows is available on every card
	// (next / theme weighting / bookmark), so this consultation page loads the
	// bookmark panel data too (task 8.7).
	return {
		card: { ...card, bodyHtml: annotationData.bodyHtml },
		annotations: annotationData.annotations,
		...cardActions.loadBookmarkData(db, card.id)
	};
};

// Every card exposes the study action bar however it is reached; these keys
// delegate to the shared handlers so the behavior is identical across routes.
// Only named actions are used, per the project's SvelteKit action rules.
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
