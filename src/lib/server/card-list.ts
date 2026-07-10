// Card listing, keyword search and filtering for the cards index page
// (roadmap section 11).
//
// The perimeter is exactly the study view's eligible pool (section 8.1): active
// cards belonging to a knowledge base currently in focus
// (`cards.active = true AND knowledge_bases.focus = true`). Everything this
// module exposes — the list, the keyword search (11.2) and the KB/theme/level
// filters (11.3) — stays inside that perimeter, so the index never surfaces a
// card the study view would not draw.
//
// Like the other `$lib/server` modules it takes an explicit Drizzle handle and
// is free of SvelteKit imports, so it stays unit-testable outside a running
// server.

import { and, asc, eq, or, sql, type SQL } from 'drizzle-orm';
import { cards, knowledgeBases } from './db/schema';
import type { createDb } from './db';

/** The shared Drizzle database handle type. */
type Db = ReturnType<typeof createDb>;

/** A single card as shown in the index list. */
export interface CardListItem {
	id: number;
	kbId: number;
	slug: string;
	title: string;
	theme: string | null;
	level: string | null;
	/** Repo-relative source path of the card's markdown file (may be null). */
	source: string | null;
}

/** Parsed, already-validated filters applied on top of the perimeter. */
export interface CardListFilters {
	/** Free-text keyword query matched against title, theme and content. */
	q?: string;
	/** Restrict to a single knowledge base by its numeric id. */
	kbId?: number;
	/** Restrict to a single theme (exact match). */
	theme?: string;
	/** Restrict to a single level (exact match). */
	level?: string;
}

/** The filter values available within the perimeter, to populate the UI selects. */
export interface CardListFacets {
	/** Focused KBs that own at least one active card, by name. */
	knowledgeBases: { id: number; name: string }[];
	/** Distinct non-empty themes present in the perimeter, sorted. */
	themes: string[];
	/** Distinct non-empty levels present in the perimeter, sorted. */
	levels: string[];
}

/** SQL condition selecting the perimeter: active cards of focused KBs. */
const IN_SCOPE: SQL = and(eq(cards.active, true), eq(knowledgeBases.focus, true))!;

/**
 * Build a case-insensitive "contains" condition matching `term` against the
 * card title, theme or content. LIKE wildcards in the user input (`%`, `_`) and
 * the escape character itself are escaped so a query such as `50%` is treated as
 * a literal, not a wildcard.
 */
function matchesTerm(term: string): SQL {
	const pattern = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
	return or(
		sql`${cards.title} LIKE ${pattern} ESCAPE '\\'`,
		sql`${cards.theme} LIKE ${pattern} ESCAPE '\\'`,
		sql`${cards.content} LIKE ${pattern} ESCAPE '\\'`
	)!;
}

/**
 * List the cards in the perimeter, narrowed by the given filters (11.1–11.3).
 *
 * The keyword query is split on whitespace into terms; a card matches only when
 * every term is found in its title, theme or content (AND across terms, OR
 * across the three fields), so adding words narrows the result. The KB, theme
 * and level filters are exact matches and combine with the search and with each
 * other. Results are ordered by title for a stable, browsable list.
 */
export function listCards(db: Db, filters: CardListFilters = {}): CardListItem[] {
	const conditions: SQL[] = [IN_SCOPE];

	if (filters.kbId !== undefined) {
		conditions.push(eq(cards.kbId, filters.kbId));
	}
	if (filters.theme !== undefined) {
		conditions.push(eq(cards.theme, filters.theme));
	}
	if (filters.level !== undefined) {
		conditions.push(eq(cards.level, filters.level));
	}
	if (filters.q) {
		for (const term of filters.q.split(/\s+/).filter(Boolean)) {
			conditions.push(matchesTerm(term));
		}
	}

	return db
		.select({
			id: cards.id,
			kbId: cards.kbId,
			slug: cards.slug,
			title: cards.title,
			theme: cards.theme,
			level: cards.level,
			source: cards.sourcePath
		})
		.from(cards)
		.innerJoin(knowledgeBases, eq(cards.kbId, knowledgeBases.id))
		.where(and(...conditions))
		.orderBy(asc(cards.title), asc(cards.id))
		.all();
}

/**
 * The filter values available within the perimeter (11.3): the focused KBs that
 * own at least one active card, and the distinct non-empty themes and levels of
 * those cards. Computed over the whole perimeter (ignoring the current filters)
 * so a chosen filter never removes the other options a user might switch to.
 */
export function listCardFacets(db: Db): CardListFacets {
	const kbRows = db
		.selectDistinct({ id: knowledgeBases.id, name: knowledgeBases.name })
		.from(cards)
		.innerJoin(knowledgeBases, eq(cards.kbId, knowledgeBases.id))
		.where(IN_SCOPE)
		.orderBy(asc(knowledgeBases.name), asc(knowledgeBases.id))
		.all();

	const themeRows = db
		.selectDistinct({ value: cards.theme })
		.from(cards)
		.innerJoin(knowledgeBases, eq(cards.kbId, knowledgeBases.id))
		.where(IN_SCOPE)
		.all();

	const levelRows = db
		.selectDistinct({ value: cards.level })
		.from(cards)
		.innerJoin(knowledgeBases, eq(cards.kbId, knowledgeBases.id))
		.where(IN_SCOPE)
		.all();

	const distinctSorted = (rows: { value: string | null }[]): string[] =>
		rows
			.map((row) => row.value)
			.filter((value): value is string => value !== null && value.trim().length > 0)
			.sort((a, b) => a.localeCompare(b));

	return {
		knowledgeBases: kbRows,
		themes: distinctSorted(themeRows),
		levels: distinctSorted(levelRows)
	};
}
