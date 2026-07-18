// Annotation logic for Distil (roadmap tasks 15.1–15.2).
//
// This module holds the core behind annotating a card: creating an annotation
// from a selected span of the card body (15.2 create), listing a card's
// annotations (15.2 list), updating an annotation's note (15.2 update) and
// removing one (15.2 delete). Later roadmap tasks add the anchor resolution
// (15.3), the capture popup (15.4), the SvelteKit actions (15.5) and the
// listing pages (15.7, 15.12); none of that lives here.
//
// Like `bookmarks.ts`, it is intentionally free of SvelteKit imports: every
// function takes an explicit Drizzle handle so the logic stays pure and
// unit-testable outside a running server. The SvelteKit glue (the +page.server
// actions) reads the request and calls into here.
//
// The anchor follows the W3C Web Annotation model's TextQuoteSelector: the
// exact quoted text plus a short prefix/suffix context around it are the source
// of truth for re-locating the annotated span, and `startOffset` is only an
// indicative hint. Resolving that anchor against a (possibly re-synced) body is
// task 15.3 and deliberately not done here.
//
// The schema (task 15.1) enforces an ON DELETE CASCADE from a card to its
// annotations that fires only on a genuine card deletion; a soft-delete
// (cards.active = false) keeps them. Inserting an annotation for a card that no
// longer exists trips the foreign-key constraint, which we translate into a
// handled result rather than letting it crash with a 500.

import { asc, desc, eq } from 'drizzle-orm';
import { annotations, cards } from './db/schema';
import type { createDb } from './db';

/** The shared Drizzle database handle type. */
type Db = ReturnType<typeof createDb>;

/** Maximum accepted length of an annotation note, enforced at the boundary. */
export const MAX_NOTE_LENGTH = 10_000;

/** Maximum accepted length of an anchor's quote, enforced at the boundary. */
export const MAX_QUOTE_LENGTH = 10_000;

/** Maximum accepted length of an anchor's prefix/suffix context, enforced at the boundary. */
export const MAX_CONTEXT_LENGTH = 500;

/**
 * A TextQuoteSelector-style anchor (W3C Web Annotation model): the exact quoted
 * (selected) text, a short context before and after it, and an indicative
 * character offset into the rendered body. The quote + context is the source of
 * truth; the offset is only a hint used by later resolution (task 15.3).
 */
export interface AnnotationAnchor {
	/** The exact quoted (selected) text. Must be non-empty. */
	quote: string;
	/** Short context immediately before the quote (may be empty at the body start). */
	prefix: string;
	/** Short context immediately after the quote (may be empty at the body end). */
	suffix: string;
	/** Indicative character offset of the quote into the rendered body (a hint only). */
	startOffset: number;
}

/** A stored annotation, as listed under a card. */
export interface Annotation extends AnnotationAnchor {
	id: number;
	cardId: number;
	note: string;
	createdAt: Date;
	updatedAt: Date;
}

/** The columns selected to build an {@link Annotation}, shared by every query. */
const annotationColumns = {
	id: annotations.id,
	cardId: annotations.cardId,
	note: annotations.note,
	quote: annotations.quote,
	prefix: annotations.prefix,
	suffix: annotations.suffix,
	startOffset: annotations.startOffset,
	createdAt: annotations.createdAt,
	updatedAt: annotations.updatedAt
} as const;

/** Result of validating a raw note from form input. */
export type ParseNoteResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * Validate and normalise a raw annotation note (task 15.2): it must be a
 * non-blank string within {@link MAX_NOTE_LENGTH}; surrounding whitespace is
 * trimmed. Returns the trimmed value on success or a single error message on
 * failure.
 */
export function parseNote(raw: unknown): ParseNoteResult {
	const note = typeof raw === 'string' ? raw.trim() : '';
	if (note.length === 0) {
		return { ok: false, error: 'Annotation note is required.' };
	}
	if (note.length > MAX_NOTE_LENGTH) {
		return { ok: false, error: `Annotation note must be at most ${MAX_NOTE_LENGTH} characters.` };
	}
	return { ok: true, value: note };
}

/** Result of validating a raw anchor from form input. */
export type ParseAnchorResult =
	| { ok: true; value: AnnotationAnchor }
	| { ok: false; error: string };

/**
 * Validate and normalise a raw anchor (task 15.2): the quote must be a non-empty
 * string; prefix/suffix must be strings (empty is allowed, as a selection at the
 * very start/end of the body has no context on one side); the offset must be a
 * non-negative integer. Returns the normalised anchor on success or a single
 * error message on failure.
 */
export function parseAnchor(raw: unknown): ParseAnchorResult {
	if (typeof raw !== 'object' || raw === null) {
		return { ok: false, error: 'Annotation anchor is required.' };
	}
	const { quote, prefix, suffix, startOffset } = raw as Record<string, unknown>;

	if (typeof quote !== 'string' || quote.length === 0) {
		return { ok: false, error: 'Annotation anchor quote is required.' };
	}
	if (quote.length > MAX_QUOTE_LENGTH) {
		return { ok: false, error: `Annotation anchor quote must be at most ${MAX_QUOTE_LENGTH} characters.` };
	}
	if (typeof prefix !== 'string') {
		return { ok: false, error: 'Annotation anchor prefix must be a string.' };
	}
	if (prefix.length > MAX_CONTEXT_LENGTH) {
		return { ok: false, error: `Annotation anchor prefix must be at most ${MAX_CONTEXT_LENGTH} characters.` };
	}
	if (typeof suffix !== 'string') {
		return { ok: false, error: 'Annotation anchor suffix must be a string.' };
	}
	if (suffix.length > MAX_CONTEXT_LENGTH) {
		return { ok: false, error: `Annotation anchor suffix must be at most ${MAX_CONTEXT_LENGTH} characters.` };
	}
	if (typeof startOffset !== 'number' || !Number.isInteger(startOffset) || startOffset < 0) {
		return { ok: false, error: 'Annotation anchor offset must be a non-negative integer.' };
	}

	return { ok: true, value: { quote, prefix, suffix, startOffset } };
}

/**
 * True when `error` carries the given SQLite constraint `code` somewhere in its
 * `cause` chain. Drizzle can surface the driver error either directly or wrapped
 * (e.g. a `DrizzleQueryError` exposing the original via `cause`), so we walk the
 * chain rather than only inspecting the top-level error. Mirrors the helper in
 * `bookmarks.ts` (kept private there, so re-implemented here rather than shared).
 */
function hasSqliteErrorCode(error: unknown, code: string): boolean {
	for (let current: unknown = error; current !== null && current !== undefined; ) {
		if (
			typeof current === 'object' &&
			'code' in current &&
			(current as { code?: unknown }).code === code
		) {
			return true;
		}
		current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
	}
	return false;
}

/**
 * True when `error` is a SQLite foreign-key constraint violation. `foreign_keys`
 * is ON (see db/index.ts), so annotating a card that no longer exists (e.g. a
 * stale study tab whose card was cascade-removed) raises this; callers map it to
 * a 404 instead of a 500. Mirrors `bookmarks.ts`'s `isForeignKeyConstraintError`.
 */
export function isForeignKeyConstraintError(error: unknown): boolean {
	return hasSqliteErrorCode(error, 'SQLITE_CONSTRAINT_FOREIGNKEY');
}

/**
 * Outcome of creating an annotation: created (with the row) or referencing a
 * card that no longer exists (`missing-card`).
 */
export type CreateAnnotationResult =
	| { ok: true; value: Annotation }
	| { ok: false; reason: 'missing-card' };

/**
 * Create an annotation for a card from a validated note and anchor (task 15.2)
 * and return the created row. A card that no longer exists trips the foreign-key
 * constraint and is reported as `{ ok: false, reason: 'missing-card' }` (mapped
 * to a 404 by the caller) instead of crashing with a 500.
 */
export function createAnnotation(
	db: Db,
	cardId: number,
	note: string,
	anchor: AnnotationAnchor
): CreateAnnotationResult {
	try {
		const value = db
			.insert(annotations)
			.values({
				cardId,
				note,
				quote: anchor.quote,
				prefix: anchor.prefix,
				suffix: anchor.suffix,
				startOffset: anchor.startOffset
			})
			.returning(annotationColumns)
			.get();
		return { ok: true, value };
	} catch (error) {
		if (isForeignKeyConstraintError(error)) {
			return { ok: false, reason: 'missing-card' };
		}
		throw error;
	}
}

/**
 * A stored annotation together with the card it belongs to, for the global
 * annotations list page (task 15.12): the note and original quote plus the
 * owning card's identity (id/title/slug and whether it is still active) so the
 * page can show which card each annotation came from and link to it.
 */
export interface AnnotationWithCard {
	id: number;
	cardId: number;
	note: string;
	quote: string;
	cardTitle: string;
	cardSlug: string;
	cardActive: boolean;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * List every annotation across all cards (task 15.12), inner-joined to its
 * owning card for the card's title/slug/active flag. The annotation's card
 * reference is NOT NULL and cascades on a hard card deletion, so every stored
 * annotation always has a matching card row (an inner join drops nothing). The
 * list is ordered most-recent-first (creation time then id, descending) for a
 * stable display. Mirrors `bookmarks.ts`'s `listBookmarksByCategory` style:
 * an explicit Drizzle handle, no SvelteKit imports, unit-testable.
 */
export function listAllAnnotationsWithCard(db: Db): AnnotationWithCard[] {
	return db
		.select({
			id: annotations.id,
			cardId: annotations.cardId,
			note: annotations.note,
			quote: annotations.quote,
			cardTitle: cards.title,
			cardSlug: cards.slug,
			cardActive: cards.active,
			createdAt: annotations.createdAt,
			updatedAt: annotations.updatedAt
		})
		.from(annotations)
		.innerJoin(cards, eq(cards.id, annotations.cardId))
		.orderBy(desc(annotations.createdAt), desc(annotations.id))
		.all();
}

/**
 * List a card's annotations (task 15.2), ordered by creation time then id for a
 * stable display. Returns an empty array for a card with no annotations (and for
 * an unknown card id).
 */
export function listAnnotationsForCard(db: Db, cardId: number): Annotation[] {
	return db
		.select(annotationColumns)
		.from(annotations)
		.where(eq(annotations.cardId, cardId))
		.orderBy(asc(annotations.createdAt), asc(annotations.id))
		.all();
}

/**
 * Update an annotation's note by id (task 15.2). Returns the updated row, or
 * `undefined` when no annotation with that id exists (so the caller can report a
 * 404 rather than a silent ok, never a 500). The note must already be validated
 * (see {@link parseNote}).
 */
export function updateAnnotationNote(db: Db, id: number, note: string): Annotation | undefined {
	return db
		.update(annotations)
		.set({ note })
		.where(eq(annotations.id, id))
		.returning(annotationColumns)
		.get();
}

/**
 * Delete an annotation by id (task 15.2). Returns whether a row was actually
 * removed, so callers can report a missing id as a 404.
 */
export function deleteAnnotation(db: Db, id: number): boolean {
	return db.delete(annotations).where(eq(annotations.id, id)).run().changes > 0;
}
