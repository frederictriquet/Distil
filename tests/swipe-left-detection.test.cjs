// tests/swipe-left-detection.test.cjs
//
// Unit checks for the pure gesture classifier `detectSwipe`
// (src/lib/swipe.ts), the decision logic behind roadmap 8.6: on mobile, a
// left swipe on the study card must advance to the next card, but only when
// the gesture is a real horizontal swipe — a big enough horizontal travel
// (`minDistance`) that stays horizontally dominant (`maxOffAxisRatio`), so
// vertical scrolls, near-diagonal drags and taps never get mistaken for one.
//
// The actual advance-to-next-card wiring (requestSubmit on the existing
// ?/next form) is client-runtime behaviour exercised through real touch
// events, which cannot be driven meaningfully from Node — the server-side
// `next` action is already covered by tests/study-draw.test.cjs. What is
// unit-testable, and is covered here, is the pure decision function itself:
// direction, threshold, and rejection of short/vertical gestures.
//
// swipe.ts is TypeScript with no relative imports, so it is loaded
// out-of-process through `tsx` (already pulled in by this project's
// `drizzle-kit` dependency), exactly as tests/redirect-path-validation.test.cjs
// does for src/lib/server/redirect.ts. The harness prints a JSON result on
// stdout; this suite never spawns `npm install`, touches the network, or
// writes into the project tree beyond a throwaway temp harness file.
//
// Run with: npm test
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TSX_CLI = require.resolve('tsx/cli');

// Harness executed by `tsx` in a fresh process: it loads the real
// src/lib/swipe.ts, runs detectSwipe over every {start, end, thresholds} case
// passed as a JSON array on argv, and prints the JSON array of results (plus
// the module's default thresholds) on stdout.
const HARNESS_SOURCE = `
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [, , rootDir, casesJson] = process.argv;
const cases = JSON.parse(casesJson);

const swipeUrl = pathToFileURL(path.join(rootDir, 'src', 'lib', 'swipe.ts')).href;
const { detectSwipe, DEFAULT_SWIPE_THRESHOLDS } = await import(swipeUrl);

process.stdout.write(
	JSON.stringify({
		defaults: DEFAULT_SWIPE_THRESHOLDS,
		results: cases.map((c) =>
			c.thresholds ? detectSwipe(c.start, c.end, c.thresholds) : detectSwipe(c.start, c.end)
		)
	})
);
`;

let harnessDir;
let harnessPath;

before(() => {
	harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-swipe-harness-'));
	harnessPath = path.join(harnessDir, 'swipe-harness.mjs');
	fs.writeFileSync(harnessPath, HARNESS_SOURCE, 'utf8');
});

after(() => {
	if (harnessDir) fs.rmSync(harnessDir, { recursive: true, force: true });
});

/** Run detectSwipe over the given {start, end, thresholds?} cases, out-of-process via tsx. */
function runDetectSwipe(cases) {
	const result = spawnSync(process.execPath, [TSX_CLI, harnessPath, ROOT, JSON.stringify(cases)], {
		cwd: ROOT,
		encoding: 'utf8',
		timeout: 30 * 1000
	});

	if (result.error) {
		throw new Error(`running the swipe harness failed to spawn: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`swipe harness exited with ${result.status}:\n${result.stdout}\n${result.stderr}`);
	}
	return JSON.parse(result.stdout);
}

describe('detectSwipe gesture classification (roadmap 8.6)', () => {
	test('a clear left drag past the default threshold is classified "left"', () => {
		const { results } = runDetectSwipe([{ start: { x: 300, y: 200 }, end: { x: 200, y: 205 } }]);
		assert.equal(results[0], 'left');
	});

	test('a clear right drag is classified "right", not "left"', () => {
		const { results } = runDetectSwipe([{ start: { x: 100, y: 200 }, end: { x: 200, y: 195 } }]);
		assert.equal(results[0], 'right');
	});

	test('a short horizontal drag under the minimum distance is rejected (null)', () => {
		// A 10px nudge is well under the documented 60px default minimum: a tap or
		// incidental drift must not be mistaken for a swipe.
		const { results } = runDetectSwipe([{ start: { x: 300, y: 200 }, end: { x: 290, y: 200 } }]);
		assert.equal(results[0], null);
	});

	test('a vertical scroll (large dy, no dx) is rejected (null)', () => {
		const { results } = runDetectSwipe([{ start: { x: 300, y: 100 }, end: { x: 300, y: 400 } }]);
		assert.equal(results[0], null);
	});

	test('a near-diagonal drag that fails horizontal dominance is rejected (null) even past the distance threshold', () => {
		// 70px left (past the 60px minimum) but paired with 90px of vertical
		// drift: the vertical component exceeds 75% of the horizontal one, so
		// this reads as a diagonal/vertical drag, not a horizontal swipe.
		const { results } = runDetectSwipe([{ start: { x: 300, y: 100 }, end: { x: 230, y: 190 } }]);
		assert.equal(results[0], null);
	});

	test('a drag exactly at the minimum distance threshold still counts as a swipe', () => {
		const { defaults, results } = runDetectSwipe([
			{ start: { x: 300, y: 200 }, end: { x: 300 - 60, y: 200 } }
		]);
		assert.equal(defaults.minDistance, 60);
		assert.equal(results[0], 'left');
	});

	test('a drag just under the minimum distance threshold is rejected (null)', () => {
		const { results } = runDetectSwipe([{ start: { x: 300, y: 200 }, end: { x: 300 - 59, y: 200 } }]);
		assert.equal(results[0], null);
	});

	test('custom thresholds are honoured instead of the defaults', () => {
		// With a 200px minimum, a 100px left drag that would pass the default
		// threshold must be rejected under the stricter custom one.
		const { results } = runDetectSwipe([
			{
				start: { x: 300, y: 200 },
				end: { x: 200, y: 200 },
				thresholds: { minDistance: 200, maxOffAxisRatio: 0.75 }
			}
		]);
		assert.equal(results[0], null);
	});

	test('a tap with no movement at all is rejected (null)', () => {
		const { results } = runDetectSwipe([{ start: { x: 150, y: 150 }, end: { x: 150, y: 150 } }]);
		assert.equal(results[0], null);
	});
});
