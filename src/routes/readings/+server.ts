// Reading-record endpoint (roadmap section 8.2).
//
// Recording a reading is decoupled from drawing a card: the study view's `load`
// only draws (see ../+page.server.ts), and the client POSTs here once a card is
// actually mounted/displayed (see ../+page.svelte). Because a SvelteKit preload
// runs `load` without ever mounting the component, no "phantom" reading is
// recorded for preloads, back/forward, or refreshes that never present a card.
//
// A dedicated endpoint is used rather than a form action on `/` for two reasons:
// a successful form action re-runs the page's `load`, which would draw a fresh
// card and swap the one on screen (and could re-trigger the record); and, like
// /logout, an endpoint sidesteps the page's named actions entirely. This route
// sits behind the access guard in hooks.server.ts, so it needs a valid session.

import { error, type RequestHandler } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { cards } from '$lib/server/db/schema';
import { recordReading } from '$lib/server/study';

export const POST: RequestHandler = async ({ request }) => {
	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		error(400, 'Expected a JSON body of the form { "cardId": <positive integer> }.');
	}

	// Validate the externally supplied id at the boundary rather than trusting the
	// client: only a positive integer is a plausible card id.
	const cardId = (payload as { cardId?: unknown })?.cardId;
	if (typeof cardId !== 'number' || !Number.isInteger(cardId) || cardId <= 0) {
		error(400, 'cardId must be a positive integer.');
	}

	// Only record readings for cards that actually exist. A client could POST any
	// id, and the reading_history foreign key would otherwise throw; a missing id
	// is a handled 404, consistent with the app's mutating-request semantics.
	const existing = db.select({ id: cards.id }).from(cards).where(eq(cards.id, cardId)).get();
	if (!existing) {
		error(404, 'No such card.');
	}

	recordReading(db, cardId);
	return new Response(null, { status: 204 });
};
