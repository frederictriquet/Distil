// tests/annotation-anchor.test.cjs
//
// Verifies task 15.3 of docs/ROADMAP.md ("15. Annotations sur les fiches"):
// re-locating an annotation's TextQuoteSelector anchor within a card body's
// rendered plain text, against the pure resolver in
// src/lib/server/annotation-anchor.ts. Covered:
//   - exact resolution of a quote that occurs once;
//   - disambiguation of a repeated quote by its prefix/suffix context (the
//     source of truth);
//   - offset-nearest fallback when there is no context and the quote is
//     ambiguous;
//   - a detached result when the quote no longer exists (an expected outcome,
//     never a throw);
//   - empty prefix (selection at the body start) and empty suffix (selection at
//     the body end);
//   - extractTextFromHtml turning rendered HTML into the plain-text coordinate
//     space the resolver works in;
//   - the per-card helper resolveAnnotationsForText tagging a mix of resolved
//     and detached annotations, in input order;
//   - decorateAnnotatedHtml (task 15.6) wrapping resolved ranges in a
//     <mark class="annotation-highlight" data-annotation-id> without breaking the
//     surrounding markup or the internal-link rewriting, handling overlaps, a
//     no-op empty range list, re-sanitizing its input, and preserving the
//     target/rel attributes markdown.ts adds to external links.
//
// This is a pure, DB-free, SvelteKit-free module, so it is exercised directly
// rather than through a running server. It is still loaded through `tsx` (as
// tests/content-rendering-markdown.test.cjs does for markdown.ts) via a small
// harness run in a child process, because this repo's TypeScript sources are
// not otherwise loadable by plain `node --test`. The harness is written to a
// fresh mkdtempSync directory so this suite is safe to run concurrently with
// the rest of `node --test tests/`.
//
// Run with: npm test
//   (single file: node --test tests/annotation-anchor.test.cjs)
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TSX_CLI = require.resolve('tsx/cli');

// Harness: import the real src/lib/server/annotation-anchor.ts module and run
// each queued call (by function name + args), returning the results as a JSON
// array so a single child process covers the whole suite.
const HARNESS_SOURCE = `
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [, , rootDir, callsJson] = process.argv;
const calls = JSON.parse(callsJson);

const mod = await import(
	pathToFileURL(path.join(rootDir, 'src', 'lib', 'server', 'annotation-anchor.ts')).href
);

const results = calls.map((c) => {
	switch (c.fn) {
		case 'resolveAnchor':
			return mod.resolveAnchor(c.text, c.anchor);
		case 'resolveAnnotationsForText':
			return mod.resolveAnnotationsForText(c.text, c.annotations);
		case 'extractTextFromHtml':
			return mod.extractTextFromHtml(c.html);
		case 'decorateAnnotatedHtml':
			return mod.decorateAnnotatedHtml(c.html, c.ranges);
		default:
			throw new Error('unknown harness fn: ' + c.fn);
	}
});
process.stdout.write(JSON.stringify(results));
`;

/** Build an anchor with sensible defaults so each case only states what matters. */
function anchor(quote, { prefix = '', suffix = '', startOffset = 0 } = {}) {
	return { quote, prefix, suffix, startOffset };
}

/** Build a minimal stored annotation (only the anchor fields matter to resolution). */
function annotation(id, note, a) {
	return {
		id,
		cardId: 1,
		note,
		quote: a.quote,
		prefix: a.prefix,
		suffix: a.suffix,
		startOffset: a.startOffset,
		createdAt: '2026-07-17T00:00:00.000Z',
		updatedAt: '2026-07-17T00:00:00.000Z'
	};
}

// The plain-text bodies exercised below, with quotes deliberately repeated so
// context / offset disambiguation is actually needed.
const UNIQUE_TEXT = 'the quick brown fox jumps';
const REPEATED_TEXT = 'alpha foo one, beta foo two, gamma foo three';
const OFFSET_TEXT = 'foo___foo___foo'; // "foo" at 0, 6, 12
const START_TEXT = 'quote foo quote rest'; // "quote" at 0 and 10
const END_TEXT = 'final foo final'; // "final" at 0 and 10
const MIX_TEXT = 'keep this line and that line';
const HTML = '<p>Hello <strong>world</strong> &amp; <em>done</em></p>';
// An attribute value that contains a literal '>' (a Markdown link title, or the
// broken-link span's interpolated href): DOMPurify serialises the '>' verbatim
// inside the quoted value, so a tag-stripping regex would leak ' b">' into the
// text. A real parser yields the browser textContent.
const HTML_ATTR_GT = '<a href="x" title="a > b">link text</a> after';
// Named and numeric HTML entities the real rendered body emits; the parser must
// decode each to the exact character the browser exposes as textContent.
const HTML_ENTITIES = '<p>a &lt; b &gt; c &#38; d &#x41; e &nbsp;f</p>';

const CALLS = [
	// exact unique-quote resolution
	{
		id: 'unique',
		fn: 'resolveAnchor',
		text: UNIQUE_TEXT,
		anchor: anchor('quick', { prefix: 'the ', suffix: ' brown', startOffset: 4 })
	},
	// disambiguation by prefix/suffix when the same quote appears several times
	{
		id: 'contextMiddle',
		fn: 'resolveAnchor',
		text: REPEATED_TEXT,
		anchor: anchor('foo', { prefix: 'beta ', suffix: ' two', startOffset: 0 })
	},
	// same repeated text, context selecting the last occurrence (offset points
	// the wrong way on purpose -- context must win over the offset hint)
	{
		id: 'contextLast',
		fn: 'resolveAnchor',
		text: REPEATED_TEXT,
		anchor: anchor('foo', { prefix: 'gamma ', suffix: ' three', startOffset: 0 })
	},
	// offset-nearest fallback: no context, ambiguous quote, offset near the middle
	{
		id: 'offsetNearest',
		fn: 'resolveAnchor',
		text: OFFSET_TEXT,
		anchor: anchor('foo', { prefix: '', suffix: '', startOffset: 7 })
	},
	// context provided but does NOT match, and the quote is unique -> accepted
	{
		id: 'staleContextUnique',
		fn: 'resolveAnchor',
		text: UNIQUE_TEXT,
		anchor: anchor('quick', { prefix: 'STALE ', suffix: ' GONE', startOffset: 4 })
	},
	// detached: the quote no longer exists in the body
	{
		id: 'detached',
		fn: 'resolveAnchor',
		text: UNIQUE_TEXT,
		anchor: anchor('vanished', { prefix: 'the ', suffix: '.', startOffset: 4 })
	},
	// empty prefix (selection at the body start), disambiguated by the suffix
	{
		id: 'emptyPrefixStart',
		fn: 'resolveAnchor',
		text: START_TEXT,
		anchor: anchor('quote', { prefix: '', suffix: ' foo', startOffset: 0 })
	},
	// empty suffix (selection at the body end), disambiguated by the prefix
	{
		id: 'emptySuffixEnd',
		fn: 'resolveAnchor',
		text: END_TEXT,
		anchor: anchor('final', { prefix: 'foo ', suffix: '', startOffset: 100 })
	},
	// extraction: rendered HTML -> plain-text coordinate space
	{ id: 'extract', fn: 'extractTextFromHtml', html: HTML },
	// extraction: an attribute value carrying a literal '>' must not corrupt the text
	{ id: 'extractAttrGt', fn: 'extractTextFromHtml', html: HTML_ATTR_GT },
	// extraction: named and numeric entities decode to their real characters
	{ id: 'extractEntities', fn: 'extractTextFromHtml', html: HTML_ENTITIES },
	// per-card helper: a mix of one resolvable and one detached annotation
	{
		id: 'perCard',
		fn: 'resolveAnnotationsForText',
		text: MIX_TEXT,
		annotations: [
			annotation(1, 'still here', anchor('that line', { prefix: 'and ', suffix: '', startOffset: 19 })),
			annotation(2, 'orphaned', anchor('deleted phrase', { prefix: '', suffix: '', startOffset: 0 }))
		]
	},
	// decoration (task 15.6): wrap a resolved range inside an inline element,
	// preserving the surrounding markup.
	{
		id: 'decorateSimple',
		fn: 'decorateAnnotatedHtml',
		// plain text: "Hello world and more"; "world" is at 6..11.
		html: '<p>Hello <strong>world</strong> and more</p>',
		ranges: [{ id: 1, start: 6, end: 11 }]
	},
	// decoration: a highlight inside a link must keep the <a href> intact (the
	// internal-link rewriting of task 7.2 must survive), nesting the mark within.
	{
		id: 'decorateLink',
		fn: 'decorateAnnotatedHtml',
		// plain text: "see alpha beta end"; "beta" is at 10..14, inside the link.
		html: '<p>see <a href="/card/1/x">alpha beta</a> end</p>',
		ranges: [{ id: 7, start: 10, end: 14 }]
	},
	// decoration: overlapping ranges cut the text node at every boundary and the
	// shared segment is tagged with every covering annotation id (space-joined).
	{
		id: 'decorateOverlap',
		fn: 'decorateAnnotatedHtml',
		// plain text: "abcdef"; id 1 covers abcd (0..4), id 2 covers cdef (2..6).
		html: '<p>abcdef</p>',
		ranges: [
			{ id: 1, start: 0, end: 4 },
			{ id: 2, start: 2, end: 6 }
		]
	},
	// decoration: no ranges -> the HTML is returned unchanged.
	{
		id: 'decorateNone',
		fn: 'decorateAnnotatedHtml',
		html: '<p>Hello world</p>',
		ranges: []
	},
	// decoration: the input is re-sanitized, so a hostile payload cannot slip in
	// through this step; ranges are in the SANITIZED text's coordinate space.
	{
		id: 'decorateSanitizes',
		fn: 'decorateAnnotatedHtml',
		// sanitized plain text: "hi there"; "there" is at 3..8.
		html: '<p>hi <script>alert(1)</script>there</p>',
		ranges: [{ id: 9, start: 3, end: 8 }]
	},
	// decoration must not lose the `target="_blank"` / `rel="noopener noreferrer"`
	// that markdown.ts's canonical render puts on external links (regression test
	// for the bug where decorateAnnotatedHtml re-sanitized with DOMPurify defaults,
	// which strip `target`): the two must share the same sanitize options.
	{
		id: 'decorateExternalLink',
		fn: 'decorateAnnotatedHtml',
		// plain text: "see alpha beta end"; "beta" is at 10..14, inside the link.
		html: '<p>see <a href="https://example.com/" target="_blank" rel="noopener noreferrer">alpha beta</a> end</p>',
		ranges: [{ id: 7, start: 10, end: 14 }]
	}
];

let harnessDir;
let harnessPath;
let outputs;

before(() => {
	harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-annotation-anchor-harness-'));
	harnessPath = path.join(harnessDir, 'annotation-anchor-harness.mjs');
	fs.writeFileSync(harnessPath, HARNESS_SOURCE, 'utf8');

	const result = spawnSync(process.execPath, [TSX_CLI, harnessPath, ROOT, JSON.stringify(CALLS)], {
		cwd: ROOT,
		encoding: 'utf8',
		timeout: 30 * 1000
	});

	if (result.error) {
		throw new Error(`running annotation-anchor harness failed to spawn: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(
			`annotation-anchor harness exited with ${result.status}:\n${result.stdout}\n${result.stderr}`
		);
	}

	const parsed = JSON.parse(result.stdout.trim());
	outputs = Object.fromEntries(CALLS.map((c, i) => [c.id, parsed[i]]));
});

after(() => {
	if (harnessDir) fs.rmSync(harnessDir, { recursive: true, force: true });
});

describe('resolveAnchor (task 15.3)', () => {
	test('resolves a quote that occurs exactly once to its character range', () => {
		const start = UNIQUE_TEXT.indexOf('quick');
		assert.deepEqual(outputs.unique, {
			status: 'resolved',
			range: { start, end: start + 'quick'.length }
		});
	});

	test('disambiguates a repeated quote by its prefix/suffix context', () => {
		const start = REPEATED_TEXT.indexOf('beta foo') + 'beta '.length;
		assert.deepEqual(outputs.contextMiddle, {
			status: 'resolved',
			range: { start, end: start + 'foo'.length }
		});
	});

	test('context wins over the offset hint (selects the last matching occurrence)', () => {
		const start = REPEATED_TEXT.indexOf('gamma foo') + 'gamma '.length;
		assert.deepEqual(outputs.contextLast, {
			status: 'resolved',
			range: { start, end: start + 'foo'.length }
		});
	});

	test('falls back to the occurrence nearest startOffset when context is absent and the quote is ambiguous', () => {
		// "foo" at 0, 6, 12; offset 7 is closest to the middle one at 6.
		assert.deepEqual(outputs.offsetNearest, {
			status: 'resolved',
			range: { start: 6, end: 9 }
		});
	});

	test('accepts a unique quote even when the stored context no longer matches', () => {
		const start = UNIQUE_TEXT.indexOf('quick');
		assert.deepEqual(outputs.staleContextUnique, {
			status: 'resolved',
			range: { start, end: start + 'quick'.length }
		});
	});

	test('returns a detached result carrying the original quote when the quote is gone', () => {
		assert.deepEqual(outputs.detached, { status: 'detached', quote: 'vanished' });
	});

	test('resolves with an empty prefix (selection at the body start), disambiguated by the suffix', () => {
		// START_TEXT: "quote" at 0 and 10; suffix " foo" only follows the first.
		assert.deepEqual(outputs.emptyPrefixStart, {
			status: 'resolved',
			range: { start: 0, end: 'quote'.length }
		});
	});

	test('resolves with an empty suffix (selection at the body end), disambiguated by the prefix', () => {
		// END_TEXT: "final" at 0 and 10; prefix "foo " only precedes the second,
		// which sits at the very end of the body (empty suffix).
		const start = END_TEXT.lastIndexOf('final');
		assert.deepEqual(outputs.emptySuffixEnd, {
			status: 'resolved',
			range: { start, end: start + 'final'.length }
		});
	});
});

describe('extractTextFromHtml (task 15.3)', () => {
	test('yields the DOM textContent: tags dropped, entities decoded, no synthetic whitespace', () => {
		assert.equal(outputs.extract, 'Hello world & done');
	});

	test('does not leak attribute characters when an attribute value contains a literal ">"', () => {
		// A tag-stripping regex would produce ' b">link text after'; the real
		// parser yields the browser textContent.
		assert.equal(outputs.extractAttrGt, 'link text after');
	});

	test('decodes named and numeric HTML entities exactly as the browser textContent does', () => {
		// &lt;/&gt; -> "<"/">", &#38; -> "&" (decimal), &#x41; -> "A" (hex),
		// &nbsp; -> U+00A0, a non-breaking space distinct from a plain space.
		assert.equal(outputs.extractEntities, 'a < b > c & d A e  f');
	});
});

describe('resolveAnnotationsForText per-card helper (task 15.3)', () => {
	test('tags a mix of resolved and detached annotations, preserving input order', () => {
		const [resolved, detached] = outputs.perCard;

		const start = MIX_TEXT.indexOf('that line');
		assert.equal(resolved.status, 'resolved');
		assert.equal(resolved.annotation.id, 1);
		assert.deepEqual(resolved.range, { start, end: start + 'that line'.length });

		assert.equal(detached.status, 'detached');
		assert.equal(detached.annotation.id, 2);
		assert.equal(detached.annotation.quote, 'deleted phrase');
	});
});

describe('decorateAnnotatedHtml (task 15.6)', () => {
	test('wraps a resolved range in a <mark> carrying its annotation id, inside its inline element', () => {
		assert.equal(
			outputs.decorateSimple,
			'<p>Hello <strong><mark class="annotation-highlight" data-annotation-id="1">world</mark></strong> and more</p>'
		);
	});

	test('keeps an internal link intact when the highlight falls inside it (task 7.2 rewriting survives)', () => {
		assert.equal(
			outputs.decorateLink,
			'<p>see <a href="/card/1/x">alpha <mark class="annotation-highlight" data-annotation-id="7">beta</mark></a> end</p>'
		);
	});

	test('cuts a text node at every boundary and tags a shared segment with every covering id', () => {
		assert.equal(
			outputs.decorateOverlap,
			'<p><mark class="annotation-highlight" data-annotation-id="1">ab</mark>' +
				'<mark class="annotation-highlight" data-annotation-id="1 2">cd</mark>' +
				'<mark class="annotation-highlight" data-annotation-id="2">ef</mark></p>'
		);
	});

	test('returns the HTML unchanged when there are no ranges', () => {
		assert.equal(outputs.decorateNone, '<p>Hello world</p>');
	});

	test('re-sanitizes the input, so a hostile payload cannot slip in through decoration', () => {
		assert.doesNotMatch(outputs.decorateSanitizes, /<script>|alert\(1\)/);
		assert.equal(
			outputs.decorateSanitizes,
			'<p>hi <mark class="annotation-highlight" data-annotation-id="9">there</mark></p>'
		);
	});

	test('preserves target="_blank" and rel="noopener noreferrer" on an external link it highlights', () => {
		assert.equal(
			outputs.decorateExternalLink,
			'<p>see <a href="https://example.com/" target="_blank" rel="noopener noreferrer">alpha ' +
				'<mark class="annotation-highlight" data-annotation-id="7">beta</mark></a> end</p>'
		);
	});
});
