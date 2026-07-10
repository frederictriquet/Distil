// tests/study-draw.test.cjs
//
// Verifies tasks 8.1, 8.2 and 8.5 of docs/ROADMAP.md (section "8. Tirage et
// vue d'étude"), at the level of the pure logic in src/lib/server/study.ts:
//   - 8.1 the weighted random draw only considers active cards belonging to
//     a knowledge base currently in focus, weights them by their theme's
//     themePreferences.weight (proportionally: a card is picked more often
//     the higher its weight relative to the pool), excludes cards seen in
//     the most recent readings, and falls back to the full eligible pool
//     (rather than returning nothing) when every eligible card was recently
//     seen;
//   - 8.2 recording a reading inserts a row into readingHistory (card id +
//     timestamp);
//   - 8.5 the "more/less of this theme" weight adjustment is clamped to a
//     strictly-positive range and subsequent draws reflect the new weight.
//
// Like tests/kb-management.test.cjs, this drives the real TypeScript module
// out-of-process through `tsx` (extension-less relative imports such as
// `./db/schema` are resolved by the bundler/svelte-kit at build time, not by
// plain Node ESM) against a real, freshly migrated SQLite database. Every
// database file lives under a fresh `mkdtempSync` directory, so this suite
// never touches the real project `data/` tree and can run concurrently with
// the rest of `node --test tests/`.
//
// Run with: node --test tests/
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const TSX_CLI = require.resolve('tsx/cli');
const DRIZZLE_KIT_CLI = path.join(ROOT, 'node_modules', 'drizzle-kit', 'bin.cjs');

/** Run the project's reproducible migration against an isolated database file. */
function runMigrate(databasePath) {
	const result = spawnSync(process.execPath, [DRIZZLE_KIT_CLI, 'migrate'], {
		cwd: ROOT,
		encoding: 'utf8',
		timeout: 60 * 1000,
		env: { ...process.env, DATABASE_PATH: databasePath }
	});

	if (result.error) {
		throw new Error(`spawning the drizzle-kit migrate CLI failed: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`drizzle-kit migrate failed:\n${result.stdout}\n${result.stderr}`);
	}
	return result;
}

// Harness executed by `tsx` (in a fresh process) so it can load the real
// `src/lib/server/study.ts` module exactly as SvelteKit does, dispatch one
// action against the given SQLite file, and print the JSON result on stdout.
// The random source used by `weightedPick`/`drawCard` is a tiny stepping
// function fed from a caller-supplied `rngSequence` array (cycling once
// exhausted), so every draw exercised here is fully deterministic.
const HARNESS_SOURCE = `
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [, , rootDir, dbPath, action, payloadJson] = process.argv;
const payload = JSON.parse(payloadJson || '{}');

const dbIndexUrl = pathToFileURL(path.join(rootDir, 'src', 'lib', 'server', 'db', 'index.ts')).href;
const studyUrl = pathToFileURL(path.join(rootDir, 'src', 'lib', 'server', 'study.ts')).href;

const { createSqliteConnection, createDb } = await import(dbIndexUrl);
const study = await import(studyUrl);

const sqlite = createSqliteConnection(dbPath);
const db = createDb(sqlite);

function makeRng(sequence) {
	if (!sequence || sequence.length === 0) return undefined;
	let i = 0;
	return () => {
		const value = sequence[i % sequence.length];
		i += 1;
		return value;
	};
}

function run() {
	switch (action) {
		case 'listEligible':
			return study.listEligibleCards(db);
		case 'recentIds':
			return Array.from(study.getRecentCardIds(db, payload.limit)).sort((a, b) => a - b);
		case 'weightedPick': {
			const rng = makeRng(payload.rngSequence);
			return study.weightedPick(payload.items, rng);
		}
		case 'weightedPickMany': {
			// One process, one rng value per pick: avoids spawning a fresh tsx
			// process per sample for the proportionality sweep below.
			return payload.rngValues.map((value) => study.weightedPick(payload.items, () => value));
		}
		case 'draw': {
			const rng = makeRng(payload.rngSequence);
			const card = study.drawCard(db, { rng, recentCount: payload.recentCount });
			return card ?? null;
		}
		case 'drawMany': {
			// One process, many draws with the module's real Math.random source:
			// avoids spawning a fresh tsx process per sample for the statistical
			// "subsequent draws reflect the weight" check below.
			const counts = {};
			for (let i = 0; i < payload.times; i += 1) {
				const card = study.drawCard(db, { recentCount: payload.recentCount });
				if (card && card.theme) {
					counts[card.theme] = (counts[card.theme] ?? 0) + 1;
				}
			}
			return counts;
		}
		case 'recordReading':
			study.recordReading(db, payload.cardId);
			return null;
		case 'adjustWeight':
			return study.adjustThemeWeight(db, payload.theme, payload.direction);
		case 'adjustWeightMany': {
			// One process, many adjustments: avoids spawning a fresh tsx process
			// per repetition for the clamping checks below.
			let last;
			for (let i = 0; i < payload.times; i += 1) {
				last = study.adjustThemeWeight(db, payload.theme, payload.direction);
			}
			return last;
		}
		case 'constants':
			return {
				DEFAULT_WEIGHT: study.DEFAULT_WEIGHT,
				DEFAULT_RECENT_COUNT: study.DEFAULT_RECENT_COUNT,
				WEIGHT_STEP: study.WEIGHT_STEP,
				MIN_WEIGHT: study.MIN_WEIGHT,
				MAX_WEIGHT: study.MAX_WEIGHT
			};
		default:
			throw new Error('unknown harness action: ' + action);
	}
}

try {
	const result = run();
	process.stdout.write(JSON.stringify(result === undefined ? null : result));
} finally {
	sqlite.close();
}
`;

let harnessDir;
let harnessPath;

before(() => {
	harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-study-harness-'));
	harnessPath = path.join(harnessDir, 'study-harness.mjs');
	fs.writeFileSync(harnessPath, HARNESS_SOURCE, 'utf8');
});

after(() => {
	if (harnessDir) fs.rmSync(harnessDir, { recursive: true, force: true });
});

/** Run one `study.ts` action, out-of-process via tsx, and return its parsed JSON result. */
function runStudy(databasePath, action, payload) {
	const result = spawnSync(
		process.execPath,
		[TSX_CLI, harnessPath, ROOT, databasePath, action, JSON.stringify(payload ?? {})],
		{ cwd: ROOT, encoding: 'utf8', timeout: 30 * 1000 }
	);

	if (result.error) {
		throw new Error(`running study action "${action}" failed to spawn: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`study action "${action}" exited with ${result.status}:\n${result.stdout}\n${result.stderr}`);
	}
	const output = result.stdout.trim();
	return output.length > 0 ? JSON.parse(output) : undefined;
}

describe('the weighted draw pool (task 8.1: eligibility filters)', () => {
	let workDir;
	let dbPath;
	let raw;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-study-pool-'));
		dbPath = path.join(workDir, 'study.db');
		runMigrate(dbPath);

		raw = new Database(dbPath);
		// KB in focus, with one active and one inactive card.
		raw.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 1)').run(
			'Focused KB',
			'https://example.test/focused.git',
			'main'
		);
		// KB NOT in focus, with an active card that must never be drawn.
		raw.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (2, ?, ?, ?, 0)').run(
			'Unfocused KB',
			'https://example.test/unfocused.git',
			'main'
		);
		raw
			.prepare('INSERT INTO cards (id, kb_id, slug, title, theme, active) VALUES (1, 1, ?, ?, ?, 1)')
			.run('active-in-focus', 'Active in focus', 'sql');
		raw
			.prepare('INSERT INTO cards (id, kb_id, slug, title, theme, active) VALUES (2, 1, ?, ?, ?, 0)')
			.run('inactive-in-focus', 'Inactive in focus', 'sql');
		raw
			.prepare('INSERT INTO cards (id, kb_id, slug, title, theme, active) VALUES (3, 2, ?, ?, ?, 1)')
			.run('active-out-of-focus', 'Active out of focus', 'sql');
	});

	after(() => {
		if (raw) raw.close();
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('only the active card from the focused KB is eligible', () => {
		const eligible = runStudy(dbPath, 'listEligible', {});
		assert.deepEqual(
			eligible.map((c) => c.id),
			[1],
			'inactive cards and cards from an unfocused KB must be excluded from the pool'
		);
	});

	test('an eligible card with no matching theme preference row gets the default weight', () => {
		const eligible = runStudy(dbPath, 'listEligible', {});
		const constants = runStudy(dbPath, 'constants', {});
		assert.equal(eligible[0].weight, constants.DEFAULT_WEIGHT);
	});

	test('drawCard never returns the inactive card or the card from the unfocused KB', () => {
		for (let i = 0; i < 5; i += 1) {
			const card = runStudy(dbPath, 'draw', { rngSequence: [i / 5] });
			assert.ok(card, 'expected a card to be drawn (there is one eligible card)');
			assert.equal(card.id, 1);
		}
	});

	test('drawCard returns undefined when there is no eligible card at all', () => {
		const emptyWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-study-empty-'));
		try {
			const emptyDbPath = path.join(emptyWorkDir, 'empty.db');
			runMigrate(emptyDbPath);
			const card = runStudy(emptyDbPath, 'draw', {});
			assert.equal(card, null);
		} finally {
			fs.rmSync(emptyWorkDir, { recursive: true, force: true });
		}
	});
});

describe('weightedPick: proportional selection given the injected rng (task 8.1)', () => {
	let dbPath;

	before(() => {
		const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-study-pick-'));
		dbPath = path.join(workDir, 'unused.db');
		// weightedPick never touches the database; a throwaway path is enough.
	});

	test('a higher-weight item is picked proportionally more often across an even rng sweep', () => {
		const items = [
			{ key: 'low', weight: 1 },
			{ key: 'high', weight: 3 }
		];
		// 100 evenly spaced rng values covering the full [0, 1) range.
		const rngValues = Array.from({ length: 100 }, (_, i) => i / 100);
		const picks = runStudy(dbPath, 'weightedPickMany', { items, rngValues });
		const counts = { low: 0, high: 0 };
		for (const picked of picks) counts[picked.key] += 1;
		// Weight ratio is 1:3 (25%:75% of the total weight of 4); an even sweep
		// over the full unit interval must reproduce that ratio exactly.
		assert.equal(counts.low, 25);
		assert.equal(counts.high, 75);
	});

	test('the lowest rng value picks the first item, the highest picks the last', () => {
		const items = [
			{ key: 'a', weight: 1 },
			{ key: 'b', weight: 1 },
			{ key: 'c', weight: 1 }
		];
		const first = runStudy(dbPath, 'weightedPick', { items, rngSequence: [0] });
		const last = runStudy(dbPath, 'weightedPick', { items, rngSequence: [0.999999] });
		assert.equal(first.key, 'a');
		assert.equal(last.key, 'c');
	});

	test('an empty item list has nothing to pick', () => {
		const picked = runStudy(dbPath, 'weightedPick', { items: [], rngSequence: [0.5] });
		assert.equal(picked, null);
	});
});

describe('recency exclusion and its graceful fallback (task 8.1)', () => {
	let workDir;
	let dbPath;
	let raw;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-study-recency-'));
		dbPath = path.join(workDir, 'study.db');
		runMigrate(dbPath);

		raw = new Database(dbPath);
		raw.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 1)').run(
			'Focused KB',
			'https://example.test/focused.git',
			'main'
		);
		raw
			.prepare('INSERT INTO cards (id, kb_id, slug, title, theme, active) VALUES (1, 1, ?, ?, ?, 1)')
			.run('card-a', 'Card A', 'sql');
		raw
			.prepare('INSERT INTO cards (id, kb_id, slug, title, theme, active) VALUES (2, 1, ?, ?, ?, 1)')
			.run('card-b', 'Card B', 'sql');
	});

	after(() => {
		if (raw) raw.close();
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('a recently read card is excluded from the draw even when the rng would otherwise favor it', () => {
		raw.prepare('INSERT INTO reading_history (card_id) VALUES (1)').run();
		// rng = 0 would pick the first item in an unfiltered, equally-weighted
		// pool; card 1 is the most recent reading, so it must be filtered out
		// and card 2 must be the only one left to draw.
		const card = runStudy(dbPath, 'draw', { rngSequence: [0], recentCount: 1 });
		assert.equal(card.id, 2);
	});

	test('when every eligible card was recently seen, the draw falls back to the full pool instead of returning nothing', () => {
		raw.prepare('DELETE FROM reading_history').run();
		raw.prepare('INSERT INTO reading_history (card_id) VALUES (1)').run();
		raw.prepare('INSERT INTO reading_history (card_id) VALUES (2)').run();
		// Both eligible cards are now "recent" (recentCount covers both); the
		// draw must still return a card rather than undefined.
		const card = runStudy(dbPath, 'draw', { rngSequence: [0.3], recentCount: 2 });
		assert.ok(card, 'expected a fallback draw over the full eligible pool');
		assert.ok([1, 2].includes(card.id));
	});

	test('getRecentCardIds returns the ids of the most recent readings, most recent first, up to the limit', () => {
		raw.prepare('DELETE FROM reading_history').run();
		raw.prepare('INSERT INTO reading_history (card_id) VALUES (1)').run();
		raw.prepare('INSERT INTO reading_history (card_id) VALUES (2)').run();
		raw.prepare('INSERT INTO reading_history (card_id) VALUES (1)').run();
		const ids = runStudy(dbPath, 'recentIds', { limit: 1 });
		assert.deepEqual(ids, [1], 'the single most recent reading was of card 1');
	});
});

describe('recording a reading (task 8.2)', () => {
	let workDir;
	let dbPath;
	let raw;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-study-record-'));
		dbPath = path.join(workDir, 'study.db');
		runMigrate(dbPath);

		raw = new Database(dbPath);
		raw.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 1)').run(
			'Focused KB',
			'https://example.test/focused.git',
			'main'
		);
		raw
			.prepare('INSERT INTO cards (id, kb_id, slug, title, active) VALUES (1, 1, ?, ?, 1)')
			.run('card-a', 'Card A');
	});

	after(() => {
		if (raw) raw.close();
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('recordReading inserts a reading_history row for the given card id, with a timestamp', () => {
		assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM reading_history').get().n, 0);
		runStudy(dbPath, 'recordReading', { cardId: 1 });
		const rows = raw.prepare('SELECT card_id AS cardId, read_at AS readAt FROM reading_history').all();
		assert.equal(rows.length, 1);
		assert.equal(rows[0].cardId, 1);
		assert.ok(Number.isInteger(rows[0].readAt) && rows[0].readAt > 0, 'expected a real timestamp to be stored');
	});

	test('recording a second reading adds another row rather than replacing the first', () => {
		runStudy(dbPath, 'recordReading', { cardId: 1 });
		assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM reading_history').get().n, 2);
	});
});

describe('adjusting a theme weight, up/down and clamped (task 8.5)', () => {
	let workDir;
	let dbPath;
	let raw;
	let constants;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-study-weight-'));
		dbPath = path.join(workDir, 'study.db');
		runMigrate(dbPath);
		raw = new Database(dbPath);
		constants = runStudy(dbPath, 'constants', {});
	});

	after(() => {
		if (raw) raw.close();
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('"more" on a theme with no existing preference row creates one above the default weight', () => {
		const next = runStudy(dbPath, 'adjustWeight', { theme: 'sql', direction: 'up' });
		assert.ok(next > constants.DEFAULT_WEIGHT, 'the weight must increase from the default baseline');
		const row = raw.prepare('SELECT weight FROM theme_preferences WHERE theme = ?').get('sql');
		assert.equal(row.weight, next);
	});

	test('"less" on an existing theme decreases its weight', () => {
		const before = raw.prepare('SELECT weight FROM theme_preferences WHERE theme = ?').get('sql').weight;
		const next = runStudy(dbPath, 'adjustWeight', { theme: 'sql', direction: 'down' });
		assert.ok(next < before, 'the weight must decrease');
	});

	test('repeated "less" clamps the weight at a strictly-positive floor, never reaching zero or below', () => {
		const last = runStudy(dbPath, 'adjustWeightMany', { theme: 'floor-test', direction: 'down', times: 50 });
		assert.ok(last > 0, `weight must stay strictly positive, got ${last}`);
		assert.equal(last, constants.MIN_WEIGHT);
		// One more "down" must not push it any lower.
		const again = runStudy(dbPath, 'adjustWeight', { theme: 'floor-test', direction: 'down' });
		assert.equal(again, constants.MIN_WEIGHT);
	});

	test('repeated "more" clamps the weight at a sensible ceiling', () => {
		const last = runStudy(dbPath, 'adjustWeightMany', { theme: 'ceiling-test', direction: 'up', times: 50 });
		assert.equal(last, constants.MAX_WEIGHT);
		const again = runStudy(dbPath, 'adjustWeight', { theme: 'ceiling-test', direction: 'up' });
		assert.equal(again, constants.MAX_WEIGHT);
	});

	test('subsequent draws reflect the adjusted weight: a theme pushed to the ceiling dominates one left at the default', () => {
		const drawWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-study-weight-draws-'));
		try {
			const drawDbPath = path.join(drawWorkDir, 'draws.db');
			runMigrate(drawDbPath);
			const drawRaw = new Database(drawDbPath);
			drawRaw
				.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 1)')
				.run('Focused KB', 'https://example.test/focused.git', 'main');
			drawRaw
				.prepare('INSERT INTO cards (id, kb_id, slug, title, theme, active) VALUES (1, 1, ?, ?, ?, 1)')
				.run('boosted-card', 'Boosted card', 'boosted');
			drawRaw
				.prepare('INSERT INTO cards (id, kb_id, slug, title, theme, active) VALUES (2, 1, ?, ?, ?, 1)')
				.run('baseline-card', 'Baseline card', 'baseline');
			drawRaw.close();

			runStudy(drawDbPath, 'adjustWeightMany', { theme: 'boosted', direction: 'up', times: 50 });
			runStudy(drawDbPath, 'adjustWeightMany', { theme: 'baseline', direction: 'down', times: 50 });

			// recentCount: 0 disables the recency filter so every draw sees the
			// full 2-card pool, isolating the effect of the weight adjustment.
			// This uses the module's real (unseeded) Math.random source: with the
			// boosted theme at the weight ceiling and the baseline theme at the
			// floor, the boosted card must dominate an overwhelming majority of a
			// large sample.
			const counts = runStudy(drawDbPath, 'drawMany', { recentCount: 0, times: 200 });
			assert.ok(
				counts.boosted >= 150,
				`expected the boosted theme to dominate the draws, got ${JSON.stringify(counts)}`
			);
		} finally {
			fs.rmSync(drawWorkDir, { recursive: true, force: true });
		}
	});
});

test('the ROADMAP checks off tasks 8.1-8.5 (weighted draw and study view)', () => {
	const roadmap = fs.readFileSync(path.join(ROOT, 'docs', 'ROADMAP.md'), 'utf8');
	for (const taskId of ['8.1', '8.2', '8.3', '8.4', '8.5']) {
		const escaped = taskId.replace('.', '\\.');
		const line = roadmap.split('\n').find((l) => new RegExp(`\\*\\*${escaped}\\*\\*`).test(l));
		assert.ok(line, `expected to find the "${taskId}" task line in docs/ROADMAP.md`);
		assert.match(line, /^- \[x\]/i, `task ${taskId} must be checked off`);
	}
});
