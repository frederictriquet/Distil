// tests/content-rendering-markdown.test.cjs
//
// Verifies tasks 7.1 and 7.2 of docs/ROADMAP.md ("Rendu du contenu") against
// the canonical `renderCardMarkdown` export of src/lib/server/markdown.ts:
//   - 7.1 a card's Markdown body is converted to HTML: basic inline/block
//     markup renders, fenced code blocks get syntax-highlighting markup
//     (highlight.js spans/classes), and the produced HTML is always passed
//     through DOMPurify — a hostile <script> tag and an onerror="" handler
//     injected in the raw body never survive into the returned HTML.
//   - 7.2 a relative Markdown link to another `.md` file of the same
//     knowledge base is rewritten to the in-app `/card/<kbId>/<path>` route,
//     resolved against the current card's sourcePath/contentSubdir (`./`
//     and `../` normalised), keeping any `#anchor` or `?query` suffix.
//     External http(s) links are left intact and get target="_blank"
//     rel="noopener noreferrer" so they open safely. A relative `.md` link
//     that resolves outside the KB's content sub-directory, or that cannot
//     be resolved at all (no current sourcePath), is not turned into a
//     dead `/card/...` route: it must not produce a live, unresolvable
//     link, while its text must still be present.
//
// This is a pure, DB-free module (no SvelteKit imports), so it is exercised
// directly rather than through a running server. It is still loaded through
// `tsx` (a direct devDependency, already used the same way by
// tests/runtime-error-handling.test.cjs) via a small harness script run in a
// child process, because this repo's TypeScript sources are not otherwise
// loadable by plain `node --test`. The harness is written to a fresh
// mkdtempSync directory so this suite is safe to run concurrently with the
// rest of `node --test tests/`.
//
// Run with: npm test
//   (single file: node --test tests/content-rendering-markdown.test.cjs)
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TSX_CLI = require.resolve('tsx/cli');

// Harness: import the real src/lib/server/markdown.ts module and render each
// case's (content, context) pair, returning the HTML strings as a JSON array
// so a single child process covers every case in this suite.
const HARNESS_SOURCE = `
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [, , rootDir, casesJson] = process.argv;
const cases = JSON.parse(casesJson);

const mod = await import(pathToFileURL(path.join(rootDir, 'src', 'lib', 'server', 'markdown.ts')).href);

const results = cases.map((c) => mod.renderCardMarkdown(c.content, c.context));
process.stdout.write(JSON.stringify(results));
`;

const CASES = [
	{
		id: 'basic',
		content: 'Hello **world**',
		context: { kbId: 1, sourcePath: null, contentSubdir: '' }
	},
	{
		id: 'codeBlock',
		content: '```js\nconst x = 1;\nfunction f() { return x; }\n```\n',
		context: { kbId: 1, sourcePath: null, contentSubdir: '' }
	},
	{
		id: 'hostileScript',
		content: 'Text\n\n<script>alert(1)</script>\n',
		context: { kbId: 1, sourcePath: null, contentSubdir: '' }
	},
	{
		id: 'hostileOnError',
		content: '<img src=x onerror="alert(1)">',
		context: { kbId: 1, sourcePath: null, contentSubdir: '' }
	},
	{
		id: 'internalLinkSameDir',
		content: '[link](note.md)',
		context: { kbId: 5, sourcePath: 'guide/intro.md', contentSubdir: 'guide' }
	},
	{
		id: 'internalLinkParentDirWithAnchor',
		content: '[link](../concepts/foo.md#section)',
		context: { kbId: 5, sourcePath: 'guide/topics/a.md', contentSubdir: 'guide' }
	},
	{
		id: 'internalLinkWithQuery',
		content: '[link](note.md?x=1)',
		context: { kbId: 5, sourcePath: 'guide/intro.md', contentSubdir: 'guide' }
	},
	{
		id: 'externalLink',
		content: '[ext](https://example.com/page)',
		context: { kbId: 5, sourcePath: 'guide/a.md', contentSubdir: 'guide' }
	},
	{
		id: 'linkOutsideKbContentDir',
		content: '[out](../../other-dir/file.md)',
		context: { kbId: 5, sourcePath: 'kb-content/notes/x.md', contentSubdir: 'kb-content' }
	},
	{
		id: 'linkWithoutSourcePath',
		content: '[link](note.md)',
		context: { kbId: 5, sourcePath: null, contentSubdir: 'guide' }
	}
];

let harnessDir;
let harnessPath;
let outputs;

before(() => {
	harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-markdown-harness-'));
	harnessPath = path.join(harnessDir, 'markdown-harness.mjs');
	fs.writeFileSync(harnessPath, HARNESS_SOURCE, 'utf8');

	const result = spawnSync(process.execPath, [TSX_CLI, harnessPath, ROOT, JSON.stringify(CASES)], {
		cwd: ROOT,
		encoding: 'utf8',
		timeout: 30 * 1000
	});

	if (result.error) {
		throw new Error(`running markdown harness failed to spawn: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`markdown harness exited with ${result.status}:\n${result.stdout}\n${result.stderr}`);
	}

	const rendered = JSON.parse(result.stdout.trim());
	outputs = Object.fromEntries(CASES.map((c, i) => [c.id, rendered[i]]));
});

after(() => {
	if (harnessDir) fs.rmSync(harnessDir, { recursive: true, force: true });
});

describe('7.1 markdown body -> sanitized HTML', () => {
	test('renders basic inline markup to HTML', () => {
		assert.match(outputs.basic, /<strong>world<\/strong>/);
	});

	test('syntax-highlights fenced code blocks', () => {
		const html = outputs.codeBlock;
		// The code block itself is tagged with the fenced language...
		assert.match(html, /<code class="hljs language-js">/);
		// ...and its tokens are wrapped in highlight.js spans, not dumped as
		// plain escaped text.
		assert.match(html, /<span class="hljs-keyword">const<\/span>/);
		assert.match(html, /<span class="hljs-number">1<\/span>/);
	});

	test('strips a <script> tag from a hostile body', () => {
		const html = outputs.hostileScript;
		assert.doesNotMatch(html, /<script/i);
		assert.doesNotMatch(html, /alert\(1\)/);
		assert.match(html, /Text/);
	});

	test('strips an onerror="" handler from a hostile body', () => {
		const html = outputs.hostileOnError;
		assert.doesNotMatch(html, /onerror/i);
		assert.doesNotMatch(html, /alert\(1\)/);
	});
});

describe('7.2 internal card link rewriting', () => {
	test('rewrites a same-directory relative .md link to /card/<kbId>/<path>', () => {
		assert.match(outputs.internalLinkSameDir, /<a href="\/card\/5\/note">link<\/a>/);
	});

	test('normalises ../ and keeps the #anchor on a rewritten link', () => {
		assert.match(
			outputs.internalLinkParentDirWithAnchor,
			/<a href="\/card\/5\/concepts\/foo#section">link<\/a>/
		);
	});

	test('keeps a ?query string on a rewritten link', () => {
		assert.match(outputs.internalLinkWithQuery, /<a href="\/card\/5\/note\?x=1">link<\/a>/);
	});

	test('leaves an external http(s) link intact and safe to open', () => {
		const html = outputs.externalLink;
		assert.match(html, /href="https:\/\/example\.com\/page"/);
		assert.match(html, /target="_blank"/);
		assert.match(html, /rel="noopener noreferrer"/);
	});

	test('does not produce a dead /card/ link for a .md target outside the KB content dir', () => {
		const html = outputs.linkOutsideKbContentDir;
		assert.doesNotMatch(html, /\/card\//);
		assert.doesNotMatch(html, /<a\s/);
		assert.match(html, /out/);
	});

	test('does not produce a dead /card/ link when the current card has no sourcePath', () => {
		const html = outputs.linkWithoutSourcePath;
		assert.doesNotMatch(html, /\/card\//);
		assert.doesNotMatch(html, /<a\s/);
		assert.match(html, /link/);
	});
});
