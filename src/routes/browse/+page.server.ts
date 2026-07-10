// Cards index at /browse: list, search and filter (roadmap section 11).
//
// It lives at /browse rather than /cards so it does not shadow the existing
// single-card route /cards/<id> (see the note in +page.svelte).
//
// All state lives in the URL query string (11.4): `q` (keyword search), `kb`,
// `theme` and `level` (filters). Because the state is URL-borne, opening a card
// and using the browser back button — or sharing the link — returns to the same
// search and filtering without re-entering it. `load` validates each parameter
// at the server boundary against the facets available in the perimeter (active
// cards of focused KBs): a malformed or out-of-range value is dropped rather
// than trusted, so a filter select never carries a phantom selection and a
// crafted URL cannot smuggle an arbitrary value into the query.
//
// This route sits behind the access guard in hooks.server.ts, so it is only
// reachable with a valid session.

import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { listCardFacets, listCards, type CardListFilters } from '$lib/server/card-list';

/** Upper bound on the accepted keyword query length, to reject abusive input. */
const MAX_QUERY_LENGTH = 200;

export const load: PageServerLoad = async ({ url }) => {
	const facets = listCardFacets(db);
	const params = url.searchParams;

	// Keyword query: a trimmed, length-capped string. Empty means "no search".
	const rawQuery = (params.get('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH);
	const q = rawQuery.length > 0 ? rawQuery : undefined;

	// KB filter: must parse to a positive integer that is actually one of the
	// focused KBs in scope; anything else is dropped.
	const rawKb = params.get('kb');
	const kbCandidate = rawKb === null ? Number.NaN : Number(rawKb);
	const kbId =
		Number.isInteger(kbCandidate) && facets.knowledgeBases.some((kb) => kb.id === kbCandidate)
			? kbCandidate
			: undefined;

	// Theme / level filters: only accepted when they name a value present in the
	// perimeter, so the applied filter always matches an offered option.
	const rawTheme = params.get('theme');
	const theme = rawTheme !== null && facets.themes.includes(rawTheme) ? rawTheme : undefined;

	const rawLevel = params.get('level');
	const level = rawLevel !== null && facets.levels.includes(rawLevel) ? rawLevel : undefined;

	const filters: CardListFilters = { q, kbId, theme, level };
	const cards = listCards(db, filters);

	return {
		cards,
		facets,
		// Echo back only the validated values so the form reflects the effective
		// state (matching the sanitised URL), not the raw request.
		filters: {
			q: q ?? '',
			kbId: kbId ?? null,
			theme: theme ?? '',
			level: level ?? ''
		}
	};
};
