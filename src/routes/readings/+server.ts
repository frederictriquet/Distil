// Reading-record endpoint (roadmap section 8.2).
//
// Recording a reading is decoupled from drawing a card: the study view's `load`
// only draws (see ../+page.server.ts). This endpoint records a reading from the
// explicit, validated "this card was shown" signal the study view sends from
// `afterNavigate` once the drawn card is actually mounted on screen (see
// ../+page.svelte). Because a bare GET/preload of `/` only runs `load` and never
// mounts the component, it fires no signal — so no "phantom" reading is logged
// for preloads that never present a card.
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
	// A malformed JSON body is not a special case: it simply yields no usable
	// `cardId`, so it funnels into the same boundary validation below (a 400)
	// rather than a separate error path. Read the raw body and parse defensively.
	const rawBody = await request.text();
	let payload: unknown;
	try {
		payload = rawBody ? JSON.parse(rawBody) : {};
	} catch {
		payload = {};
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
