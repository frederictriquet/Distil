// Global annotations list page server logic (roadmap task 15.12).
//
// `load` lists every annotation across all cards, each joined to its owning
// card for display, so the page can show the note, its original quoted span and
// which card it belongs to, and link to that card's consultation page. The form
// actions — editing a note and deleting an annotation — delegate to the exact
// same shared handlers as the per-card annotation panel (task 15.8), so both
// entry points share one behavior and one set of status semantics (a
// blank/oversized note answers 400, an id matching no annotation answers 404,
// never a silent ok). This route sits behind the access guard in
// hooks.server.ts, so it is only reachable with a valid session.

import type { Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { listAllAnnotationsWithCard } from '$lib/server/annotations';
import * as cardActions from '$lib/server/card-actions';

export const load: PageServerLoad = async () => {
	return { annotations: listAllAnnotationsWithCard(db) };
};

// Only named actions, per the project's SvelteKit action rules (never a
// `default` mixed with named actions; the static contract test asserts the
// shape). Both delegate to the shared card-action handlers so the edit/delete
// semantics match the per-card panel (task 15.8): the note is validated at the
// boundary through the annotations module (blank -> 400) and a missing
// annotation id answers 404, never a silent ok or a 500.
export const actions: Actions = {
	updateAnnotation: async (event) => cardActions.updateAnnotation(event),
	deleteAnnotation: async (event) => cardActions.deleteAnnotation(event)
};
