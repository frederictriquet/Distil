// Annotation anchor resolution for Distil (roadmap task 15.3).
//
// An annotation stores a W3C-Web-Annotation TextQuoteSelector anchor (see
// `annotations.ts`): the exact `quote`, a short `prefix`/`suffix` of surrounding
// context, and an indicative `startOffset`. When a card is displayed we must
// re-locate that annotated span in the (possibly re-synced) body. This module is
// that re-location, kept pure and unit-testable: explicit string inputs, no
// SvelteKit imports and no database access.
//
// Text representation -- deliberate choice:
//   The resolver operates on the PLAIN TEXT of the rendered card body, i.e. the
//   character sequence a browser would expose as the rendered HTML's
//   `textContent` (tags removed, HTML entities decoded, no synthetic whitespace
//   inserted between elements). It does NOT operate on the raw Markdown.
//   Rationale: the highlight step (task 15.6) will paint the annotated range by
//   walking the rendered DOM's text nodes and accumulating character offsets;
//   those offsets live in exactly this plain-text coordinate space, so a range
//   produced here maps directly back onto the rendered HTML. Resolving against
//   the raw Markdown would yield offsets in a different space (`**bold**`,
//   `[text](url)`, fenced code fences, …) that 15.6 could not reuse.
//   `extractTextFromHtml` below is the single, documented place that turns the
//   rendered HTML into that plain text; every other function here is
//   HTML-agnostic and works on a plain string.

import type { Annotation, AnnotationAnchor } from './annotations';

/** A resolved character range within the plain text: `[start, end)`. */
export interface AnchorRange {
	/** Index of the first character of the quote (inclusive). */
	start: number;
	/** Index just past the last character of the quote (exclusive). */
	end: number;
}

/**
 * Outcome of resolving an anchor against a body's plain text. A `resolved`
 * anchor carries the character range of the quote; a `detached` anchor carries
 * the original quote so a later UI (task 15.9) can still surface the note even
 * though its span no longer exists. Detachment is an expected, first-class
 * result -- resolution never throws for it.
 */
export type AnchorResolution =
	| { status: 'resolved'; range: AnchorRange }
	| { status: 'detached'; quote: string };

/** An annotation tagged with its resolution against the current body text. */
export type ResolvedAnnotation =
	| { annotation: Annotation; status: 'resolved'; range: AnchorRange }
	| { annotation: Annotation; status: 'detached' };

/** Named HTML entities the extractor decodes (the ones DOMPurify output emits). */
const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' '
};

/** Decode a single HTML entity body (the text between `&` and `;`). */
function decodeEntity(body: string): string {
	if (body.startsWith('#')) {
		const isHex = body[1] === 'x' || body[1] === 'X';
		const codePoint = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
		if (Number.isNaN(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
			return `&${body};`;
		}
		return String.fromCodePoint(codePoint);
	}
	const named = NAMED_ENTITIES[body];
	return named === undefined ? `&${body};` : named;
}

/**
 * Extract the plain text of rendered card HTML: the character sequence a browser
 * exposes as `textContent`. Tags are dropped without inserting any synthetic
 * whitespace (matching `textContent`, which does not add newlines between block
 * elements) and the named/numeric HTML entities DOMPurify's output can contain
 * are decoded. This is the single HTML-aware helper; the resolver itself works
 * on the plain string it returns, in whose coordinate space task 15.6 paints the
 * highlight.
 */
export function extractTextFromHtml(html: string): string {
	const withoutTags = html.replace(/<[^>]*>/g, '');
	return withoutTags.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_match, body: string) =>
		decodeEntity(body)
	);
}

/** True when `text` contains `slice` ending exactly at index `end` (exclusive). */
function endsAt(text: string, slice: string, end: number): boolean {
	const start = end - slice.length;
	return start >= 0 && text.startsWith(slice, start);
}

/** All start indices at which `needle` occurs in `haystack` (empty needle -> none). */
function allOccurrences(haystack: string, needle: string): number[] {
	const indices: number[] = [];
	if (needle.length === 0) {
		return indices;
	}
	for (let from = haystack.indexOf(needle); from !== -1; from = haystack.indexOf(needle, from + 1)) {
		indices.push(from);
	}
	return indices;
}

/**
 * Among candidate quote-start indices, pick the one nearest to `startOffset`
 * (the offset is only a hint). Ties resolve to the earlier occurrence so the
 * result is deterministic.
 */
function nearestToOffset(indices: number[], startOffset: number): number {
	let best = indices[0];
	let bestDistance = Math.abs(best - startOffset);
	for (let i = 1; i < indices.length; i += 1) {
		const distance = Math.abs(indices[i] - startOffset);
		if (distance < bestDistance) {
			best = indices[i];
			bestDistance = distance;
		}
	}
	return best;
}

/**
 * Re-locate an anchor within a body's plain `text` (task 15.3). Strategy, in
 * priority order:
 *   1. Prefer an occurrence of `quote` whose immediately-preceding text is
 *      `prefix` and immediately-following text is `suffix` -- the context match
 *      is the source of truth against a re-synced body. When several occurrences
 *      match the context, the one nearest `startOffset` wins.
 *   2. If context does not disambiguate but `quote` occurs exactly once, accept
 *      that occurrence.
 *   3. If `quote` occurs several times without a context match, pick the
 *      occurrence nearest `startOffset`.
 *   4. If `quote` cannot be found at all, the anchor is `detached`.
 * Never throws: a missing quote is the expected `detached` outcome, not an error.
 */
export function resolveAnchor(text: string, anchor: AnnotationAnchor): AnchorResolution {
	const { quote, prefix, suffix, startOffset } = anchor;
	const occurrences = allOccurrences(text, quote);
	if (occurrences.length === 0) {
		return { status: 'detached', quote };
	}

	// Step 1: context match. Only meaningful when there is context to match on;
	// with both sides empty (a selection spanning the whole body) it disambiguates
	// nothing, so we fall through to the offset/uniqueness rules.
	const hasContext = prefix.length > 0 || suffix.length > 0;
	if (hasContext) {
		const contextMatches = occurrences.filter(
			(index) => endsAt(text, prefix, index) && text.startsWith(suffix, index + quote.length)
		);
		if (contextMatches.length > 0) {
			const index = nearestToOffset(contextMatches, startOffset);
			return { status: 'resolved', range: { start: index, end: index + quote.length } };
		}
	}

	// Step 2 & 3: no context match -- a unique quote is accepted, an ambiguous one
	// falls back to the occurrence nearest the (hint-only) offset.
	const index =
		occurrences.length === 1 ? occurrences[0] : nearestToOffset(occurrences, startOffset);
	return { status: 'resolved', range: { start: index, end: index + quote.length } };
}

/**
 * Tag each of a card's annotations as `resolved` (with its range in `text`) or
 * `detached`, in input order (task 15.3). Pure: this is the shape a later
 * load/display task (15.7/15.9) consumes -- data in, data out, no DOM or DB.
 * `text` is the plain text of the rendered body (see `extractTextFromHtml`).
 */
export function resolveAnnotationsForText(
	text: string,
	annotations: Annotation[]
): ResolvedAnnotation[] {
	return annotations.map((annotation) => {
		const resolution = resolveAnchor(text, annotation);
		return resolution.status === 'resolved'
			? { annotation, status: 'resolved', range: resolution.range }
			: { annotation, status: 'detached' };
	});
}
