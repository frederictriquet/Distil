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

import DOMPurify from 'isomorphic-dompurify';

import type { Annotation, AnnotationAnchor } from './annotations';
import { SANITIZE_OPTIONS } from './markdown';

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

/**
 * Extract the plain text of rendered card HTML: the exact character sequence a
 * browser exposes as the body's `textContent`. This is the single HTML-aware
 * helper; the resolver itself works on the plain string it returns, in whose
 * coordinate space task 15.6 paints the highlight (walking the rendered DOM's
 * text nodes and accumulating offsets yields the very same sequence).
 *
 * A real HTML parser is used, not a tag-stripping regex. A regex such as
 * `/<[^>]*>/g` corrupts the text whenever an attribute value contains a literal
 * `>` (e.g. a Markdown link title `[t](f.md "a > b")`, or the broken-link span
 * whose `title` interpolates an unresolved href): DOMPurify serialises such a
 * `>` verbatim inside the quoted value, so the regex ends the "tag" early and
 * leaks attribute characters into the output, shifting every downstream offset.
 * We reuse `isomorphic-dompurify` (already the renderer's sanitiser, so no new
 * dependency) with `RETURN_DOM` to obtain a parsed DOM node and read its
 * `textContent`: tags are dropped with no synthetic whitespace and every named
 * and numeric HTML entity is decoded exactly as the browser would.
 */
export function extractTextFromHtml(html: string): string {
	const node = DOMPurify.sanitize(html, { ...SANITIZE_OPTIONS, RETURN_DOM: true }) as unknown as {
		textContent: string | null;
	};
	return node.textContent ?? '';
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

/** A resolved character range tagged with the annotation id it belongs to. */
export interface AnnotatedRange extends AnchorRange {
	/** Id of the annotation whose quote this range covers. */
	id: number;
}

/**
 * Wrap each resolved annotation range in the already-sanitized body `html` with
 * a `<mark class="annotation-highlight" data-annotation-id="…">` element, so the
 * highlight ships pre-rendered on the server (task 15.6) and the client only has
 * to style and click it. The ranges are in the plain-text coordinate space of
 * `extractTextFromHtml` -- the very sequence the browser exposes as the body's
 * `textContent` (see this module's header) -- so they are mapped back onto the
 * DOM by walking the parsed body's text nodes and accumulating their lengths.
 *
 * Sanitization is preserved by construction: we parse the input through the same
 * DOMPurify pass used elsewhere (so nothing unsanitized can slip in), then only
 * ever *split existing text nodes* and wrap fragments of them in freshly created
 * `<mark>` elements whose text is set via `textContent` (never parsed as HTML).
 * No attribute or element from the input is rewritten, so the internal-link
 * rewriting done upstream (task 7.2) is left untouched -- a highlight that falls
 * inside a link simply nests a `<mark>` within the surviving `<a>`.
 *
 * A range spanning an element boundary (its `start` and `end` land in different
 * text nodes) is painted per node, yielding one `<mark>` per node that all carry
 * the same `data-annotation-id`. Overlapping ranges are handled by cutting each
 * text node at every range boundary and tagging a segment with every annotation
 * id that covers it (space-separated), so no highlight is lost. Detached
 * annotations have no range and are simply never passed here.
 */
export function decorateAnnotatedHtml(html: string, ranges: AnnotatedRange[]): string {
	if (ranges.length === 0) {
		return html;
	}
	const body = DOMPurify.sanitize(html, { ...SANITIZE_OPTIONS, RETURN_DOM: true }) as unknown as {
		innerHTML: string;
		ownerDocument: Document;
		childNodes: NodeListOf<ChildNode>;
	};
	const doc = body.ownerDocument;

	// Collect every text node with its absolute start offset in the plain text
	// BEFORE mutating, so offsets stay valid while nodes are replaced afterwards.
	const textNodes: { node: Text; start: number }[] = [];
	let offset = 0;
	const walk = (node: Node): void => {
		for (const child of Array.from(node.childNodes)) {
			if (child.nodeType === 3) {
				const text = child as Text;
				textNodes.push({ node: text, start: offset });
				offset += text.data.length;
			} else if (child.nodeType === 1) {
				walk(child);
			}
		}
	};
	walk(body as unknown as Node);

	for (const { node, start } of textNodes) {
		const text = node.data;
		const nodeEnd = start + text.length;

		// The cut points within this node: 0, its length, and every range
		// boundary that falls strictly inside it.
		const points = new Set<number>([0, text.length]);
		for (const range of ranges) {
			if (range.end <= start || range.start >= nodeEnd) {
				continue;
			}
			points.add(Math.max(0, range.start - start));
			points.add(Math.min(text.length, range.end - start));
		}
		const cuts = [...points].sort((a, b) => a - b);

		const fragment = doc.createDocumentFragment();
		let marked = false;
		for (let i = 0; i < cuts.length - 1; i += 1) {
			const segStart = cuts[i];
			const segEnd = cuts[i + 1];
			if (segStart === segEnd) {
				continue;
			}
			const segText = text.slice(segStart, segEnd);
			const absStart = start + segStart;
			const absEnd = start + segEnd;
			const covering = ranges.filter((range) => range.start <= absStart && range.end >= absEnd);
			if (covering.length > 0) {
				const mark = doc.createElement('mark');
				mark.className = 'annotation-highlight';
				mark.setAttribute('data-annotation-id', covering.map((range) => range.id).join(' '));
				mark.textContent = segText;
				fragment.appendChild(mark);
				marked = true;
			} else {
				fragment.appendChild(doc.createTextNode(segText));
			}
		}
		if (marked && node.parentNode) {
			node.parentNode.replaceChild(fragment, node);
		}
	}

	return body.innerHTML;
}
