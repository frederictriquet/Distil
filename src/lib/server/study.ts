// Weighted random draw and study-view logic for Distil (roadmap section 8).
//
// Like `auth.ts` and `kb.ts`, this module is intentionally free of SvelteKit
// imports: every function takes an explicit Drizzle handle so the logic stays
// pure and unit-testable outside a running server. The random source is
// injected (the `rng` option) so the weighted draw is deterministic in tests.
//
// The eligible pool for a draw (task 8.1) is: active cards belonging to a
// knowledge base currently in focus. Each card's draw weight comes from its
// theme's `themePreferences.weight` (defaulting to `DEFAULT_WEIGHT` when the
// card has no theme or no preference row exists yet). Cards seen in the most
// recent draws (`readingHistory`) are excluded so the same card does not repeat
// immediately; if that exclusion would empty the pool, it is relaxed rather
// than returning nothing.

import { and, desc, eq } from 'drizzle-orm';
import { cards, knowledgeBases, readingHistory, themePreferences } from './db/schema';
import type { createDb } from './db';

/** The shared Drizzle database handle type. */
type Db = ReturnType<typeof createDb>;

/** Draw weight applied to a card whose theme has no explicit preference row. */
export const DEFAULT_WEIGHT = 1;

/** How many of the most recent readings are excluded from a fresh draw. */
export const DEFAULT_RECENT_COUNT = 10;

/** Amount a single "more/less of this theme" action shifts a theme's weight. */
export const WEIGHT_STEP = 0.5;

/** Lower clamp for a theme weight: kept strictly above 0 so it never vanishes. */
export const MIN_WEIGHT = 0.1;

/** Upper clamp for a theme weight, to keep the distribution sane. */
export const MAX_WEIGHT = 10;

/** A card eligible for the draw, enriched with its effective theme weight. */
export interface DrawableCard {
	id: number;
	kbId: number;
	slug: string;
	title: string;
	theme: string | null;
	level: string | null;
	sourcePath: string | null;
	content: string | null;
	/** Effective draw weight (theme preference, or DEFAULT_WEIGHT). */
	weight: number;
}

/** Direction of a theme-weight adjustment (task 8.5). */
export type WeightDirection = 'up' | 'down';

/** Options controlling a single {@link drawCard} call. */
export interface DrawOptions {
	/** Random source returning a float in [0, 1); defaults to Math.random. */
	rng?: () => number;
	/** How many recent readings to exclude; defaults to DEFAULT_RECENT_COUNT. */
	recentCount?: number;
}

/** Clamp `value` into the inclusive [min, max] range. */
function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/**
 * All cards eligible for the draw: active cards whose knowledge base is in
 * focus, each carrying its effective theme weight (the matching
 * `themePreferences.weight`, or DEFAULT_WEIGHT when the card has no theme or no
 * preference row exists yet).
 */
export function listEligibleCards(db: Db): DrawableCard[] {
	const rows = db
		.select({
			id: cards.id,
			kbId: cards.kbId,
			slug: cards.slug,
			title: cards.title,
			theme: cards.theme,
			level: cards.level,
			sourcePath: cards.sourcePath,
			content: cards.content,
			weight: themePreferences.weight
		})
		.from(cards)
		.innerJoin(knowledgeBases, eq(cards.kbId, knowledgeBases.id))
		.leftJoin(themePreferences, eq(cards.theme, themePreferences.theme))
		.where(and(eq(cards.active, true), eq(knowledgeBases.focus, true)))
		.all();

	return rows.map((row) => ({
		...row,
		weight: row.weight ?? DEFAULT_WEIGHT
	}));
}

/**
 * The card ids of the `limit` most recent readings, newest first. Used to
 * exclude recently seen cards from a fresh draw. Ties on `readAt` (the stored
 * timestamp only has second resolution) are broken by the autoincrement id so
 * ordering is stable.
 */
export function getRecentCardIds(db: Db, limit: number = DEFAULT_RECENT_COUNT): Set<number> {
	if (limit <= 0) {
		return new Set();
	}
	const rows = db
		.select({ cardId: readingHistory.cardId })
		.from(readingHistory)
		.orderBy(desc(readingHistory.readAt), desc(readingHistory.id))
		.limit(limit)
		.all();
	return new Set(rows.map((row) => row.cardId));
}

/**
 * Pick one item at random, weighted by each item's `weight`. Pure and
 * deterministic given `rng` (a float source in [0, 1)), so callers/tests can
 * inject a fixed sequence. Non-positive weights are treated as 0; if every
 * weight is 0 the pick falls back to a uniform choice so a card is still
 * returned. Returns `undefined` only for an empty list.
 */
export function weightedPick<T extends { weight: number }>(
	items: T[],
	rng: () => number
): T | undefined {
	if (items.length === 0) {
		return undefined;
	}
	const total = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
	if (total <= 0) {
		// All weights are zero/negative: fall back to a uniform pick so the draw
		// never silently returns nothing for an otherwise eligible pool.
		const index = Math.min(items.length - 1, Math.floor(rng() * items.length));
		return items[index];
	}
	let threshold = rng() * total;
	for (const item of items) {
		threshold -= Math.max(0, item.weight);
		if (threshold < 0) {
			return item;
		}
	}
	// Floating-point drift can leave `threshold` marginally >= 0 after the loop;
	// the last item is the correct fallback.
	return items[items.length - 1];
}

/**
 * Draw one card from the eligible pool (task 8.1), weighted by theme.
 *
 * Cards seen in the most recent `recentCount` readings are excluded so a draw
 * does not immediately repeat a card. If that exclusion empties the pool (every
 * eligible card was recently seen), the recency filter is relaxed and the draw
 * runs over the full eligible pool rather than returning nothing. Returns
 * `undefined` when there are no eligible cards at all (no focused KB, or no
 * active cards).
 */
export function drawCard(db: Db, options: DrawOptions = {}): DrawableCard | undefined {
	const rng = options.rng ?? Math.random;
	const recentCount = options.recentCount ?? DEFAULT_RECENT_COUNT;

	const eligible = listEligibleCards(db);
	if (eligible.length === 0) {
		return undefined;
	}

	const recent = getRecentCardIds(db, recentCount);
	let pool = eligible.filter((card) => !recent.has(card.id));
	if (pool.length === 0) {
		// Everything eligible was seen recently: relax the recency exclusion
		// rather than returning nothing.
		pool = eligible;
	}

	return weightedPick(pool, rng);
}

/**
 * Record that a card was shown in the study view (task 8.2) by inserting a row
 * in `readingHistory`. This is what makes the recency exclusion in
 * {@link drawCard} work and preserves the reading history.
 */
export function recordReading(db: Db, cardId: number): void {
	db.insert(readingHistory).values({ cardId }).run();
}

/**
 * Adjust a theme's draw weight up or down by {@link WEIGHT_STEP} (task 8.5),
 * clamped to [MIN_WEIGHT, MAX_WEIGHT] so it never drops to 0 or below. Upserts
 * the preference row when the theme has none yet (roadmap 6.6 will normally
 * seed these, but the study view must work before ingestion is complete).
 * Returns the new weight.
 */
export function adjustThemeWeight(db: Db, theme: string, direction: WeightDirection): number {
	const current = db
		.select({ weight: themePreferences.weight })
		.from(themePreferences)
		.where(eq(themePreferences.theme, theme))
		.get();

	const base = current ? current.weight : DEFAULT_WEIGHT;
	const delta = direction === 'up' ? WEIGHT_STEP : -WEIGHT_STEP;
	const next = clamp(base + delta, MIN_WEIGHT, MAX_WEIGHT);

	if (current) {
		db.update(themePreferences).set({ weight: next }).where(eq(themePreferences.theme, theme)).run();
	} else {
		db.insert(themePreferences).values({ theme, weight: next }).run();
	}

	return next;
}
