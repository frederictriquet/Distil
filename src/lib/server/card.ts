// Single-card lookup for the card consultation page (roadmap section 10).
//
// Both entry points into a specific card resolve through here: internal links
// between cards address a card by its knowledge base and slug (section 7.2 emits
// `/card/<kbId>/<slug>`), while bookmark navigation addresses it by its numeric
// primary key (section 9.3 links to `/cards/<id>`). Each lookup returns the same
// display shape — the metadata the study view shows (title, theme, level,
// source) plus the card body rendered to sanitized HTML through the canonical
// markdown module (section 7). A missing card yields `null` so the route can
// answer 404.
//
// Like the other `$lib/server` modules it takes an explicit Drizzle handle and
// is free of SvelteKit imports, so it stays unit-testable outside a running
// server.

import { and, eq } from 'drizzle-orm';
import { cards, knowledgeBases } from './db/schema';
import { renderCardMarkdown } from './markdown';
import type { createDb } from './db';

/** The shared Drizzle database handle type. */
type Db = ReturnType<typeof createDb>;

/** A single card prepared for display on the consultation page. */
export interface CardView {
	id: number;
	title: string;
	theme: string | null;
	level: string | null;
	/** Repo-relative source path of the card's markdown file (may be null). */
	source: string | null;
	/** Whether the card is still active; inactive cards remain viewable. */
	active: boolean;
	/** Sanitized HTML rendered from the card's markdown body (section 7). */
	bodyHtml: string;
}

/** The card columns a lookup needs to build a {@link CardView}. */
type CardRow = {
	id: number;
	kbId: number;
	title: string;
	theme: string | null;
	level: string | null;
	sourcePath: string | null;
	content: string | null;
	active: boolean;
};

/**
 * Turn a raw card row into its display view, rendering the markdown body to
 * sanitized HTML with internal links rewritten (section 7). Resolving those
 * relative links needs the owning KB's content sub-directory alongside the
 * card's own source path, so the KB row is looked up here.
 */
function toCardView(db: Db, row: CardRow): CardView {
	const kb = db
		.select({ contentSubdir: knowledgeBases.contentSubdir })
		.from(knowledgeBases)
		.where(eq(knowledgeBases.id, row.kbId))
		.get();
	const bodyHtml = renderCardMarkdown(row.content, {
		kbId: row.kbId,
		sourcePath: row.sourcePath,
		contentSubdir: kb?.contentSubdir ?? ''
	});
	return {
		id: row.id,
		title: row.title,
		theme: row.theme,
		level: row.level,
		source: row.sourcePath,
		active: row.active,
		bodyHtml
	};
}

/** Columns selected for every card lookup. */
const cardColumns = {
	id: cards.id,
	kbId: cards.kbId,
	title: cards.title,
	theme: cards.theme,
	level: cards.level,
	sourcePath: cards.sourcePath,
	content: cards.content,
	active: cards.active
} as const;

/**
 * Look up a card by its numeric primary key — the identifier bookmark
 * navigation uses (section 9.3). Returns `null` when no such card exists.
 * Inactive (soft-deleted) cards are still returned so a bookmark to a card that
 * has since disappeared from its repo stays viewable.
 */
export function getCardById(db: Db, id: number): CardView | null {
	const row = db.select(cardColumns).from(cards).where(eq(cards.id, id)).get();
	return row ? toCardView(db, row) : null;
}

/**
 * Look up a card by its knowledge base and slug — the identifier internal card
 * links use (section 7.2). Returns `null` when no such card exists. Inactive
 * cards are still returned so an internal link to a deactivated card resolves.
 */
export function getCardByKbSlug(db: Db, kbId: number, slug: string): CardView | null {
	const row = db
		.select(cardColumns)
		.from(cards)
		.where(and(eq(cards.kbId, kbId), eq(cards.slug, slug)))
		.get();
	return row ? toCardView(db, row) : null;
}
