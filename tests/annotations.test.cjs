// tests/annotations.test.cjs
//
// Verifies tasks 15.1 and 15.2 of docs/ROADMAP.md (section "15. Annotations
// sur les fiches"):
//   - 15.1 the data model: an `annotations` table anchored to a card, whose
//     ON DELETE CASCADE fires only on a genuine (hard) card deletion, so a
//     soft-delete (cards.active = false) preserves the annotations -- the same
//     guarantee bookmarks and reading_history rely on.
//   - 15.2 the server module src/lib/server/annotations.ts: create + list
//     round-trip, note/anchor validation rejected at the boundary, updating an
//     existing note, updating a missing id reported as "not found" (never a
//     throw/500), and delete of an existing vs. a missing id.
//
// Like tests/bookmarks-management.test.cjs, this exercises the real TypeScript
// module out-of-process through `tsx` (its extension-less relative imports,
// e.g. `./db/schema`, need a TS loader), against a real SQLite database. The
// database is migrated through the app's OWN boot-time migration path
// (src/lib/server/db/index.ts's runMigrations, MIGRATIONS_FOLDER = the repo's
// drizzle/ folder) rather than an out-of-band drizzle-kit step, so a green run
// also proves the 15.1 migration is picked up by the path the running app
// actually uses on boot. Every database file lives under a fresh mkdtempSync
// directory, so this suite never touches the real project `data/` tree and can
// run concurrently with the rest of `node --test tests/`.
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

// Harness executed by `tsx` (in a fresh process) so it can load the real
// src/lib/server/annotations.ts and src/lib/server/db/index.ts modules exactly
// as SvelteKit does, dispatch one operation against the given SQLite file, and
// print the JSON result on stdout. The `migrate` action drives the app's own
// runMigrations() so no out-of-band migration step is needed in fixtures.
const HARNESS_SOURCE = `
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [, , rootDir, dbPath, action, payloadJson] = process.argv;
const payload = JSON.parse(payloadJson || '{}');

const dbIndexUrl = pathToFileURL(path.join(rootDir, 'src', 'lib', 'server', 'db', 'index.ts')).href;
const annotationsUrl = pathToFileURL(path.join(rootDir, 'src', 'lib', 'server', 'annotations.ts')).href;

const { createSqliteConnection, createDb, runMigrations } = await import(dbIndexUrl);
const an = await import(annotationsUrl);

const sqlite = createSqliteConnection(dbPath);
const db = createDb(sqlite);

function run() {
	switch (action) {
		case 'migrate':
			// The app's own boot-time migration path (not drizzle-kit out of band).
			runMigrations(db);
			return { ok: true };
		case 'parseNote':
			return an.parseNote(payload.raw);
		case 'parseAnchor':
			return an.parseAnchor(payload.raw);
		case 'create':
			return an.createAnnotation(db, payload.cardId, payload.note, payload.anchor);
		case 'list':
			return an.listAnnotationsForCard(db, payload.cardId);
		case 'listAll':
			return an.listAllAnnotationsWithCard(db);
		case 'update':
			return { value: an.updateAnnotationNote(db, payload.id, payload.note) };
		case 'delete':
			return { deleted: an.deleteAnnotation(db, payload.id) };
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
	harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-annotations-harness-'));
	harnessPath = path.join(harnessDir, 'annotations-harness.mjs');
	fs.writeFileSync(harnessPath, HARNESS_SOURCE, 'utf8');
});

after(() => {
	if (harnessDir) fs.rmSync(harnessDir, { recursive: true, force: true });
});

/** Run one annotations action, out-of-process via tsx, and return its parsed JSON result. */
function runAnnotations(databasePath, action, payload) {
	const result = spawnSync(
		process.execPath,
		[TSX_CLI, harnessPath, ROOT, databasePath, action, JSON.stringify(payload ?? {})],
		{ cwd: ROOT, encoding: 'utf8', timeout: 30 * 1000 }
	);

	if (result.error) {
		throw new Error(`running annotations action "${action}" failed to spawn: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(
			`annotations action "${action}" exited with ${result.status}:\n${result.stdout}\n${result.stderr}`
		);
	}
	const output = result.stdout.trim();
	return output.length > 0 ? JSON.parse(output) : undefined;
}

/**
 * Migrate a fresh database (app boot-time path) and seed one KB + one card;
 * returns the card id. `key` disambiguates the KB's unique (repo_url, branch)
 * pair and the card slug so several cards can be seeded into the same database.
 */
function migrateAndSeedCard(databasePath, key = 'a') {
	const migrated = runAnnotations(databasePath, 'migrate', {});
	assert.deepEqual(migrated, { ok: true }, 'sanity check: the boot-time migration must succeed');

	const raw = new Database(databasePath);
	try {
		raw
			.prepare('INSERT INTO knowledge_bases (name, repo_url, branch) VALUES (?, ?, ?)')
			.run(`KB ${key}`, `https://example.test/repo-${key}.git`, 'main');
		const kbId = raw.prepare('SELECT last_insert_rowid() AS id').get().id;
		raw
			.prepare('INSERT INTO cards (kb_id, slug, title, active) VALUES (?, ?, ?, 1)')
			.run(kbId, `card-${key}`, `Card ${key}`);
		return raw.prepare('SELECT last_insert_rowid() AS id').get().id;
	} finally {
		raw.close();
	}
}

const VALID_ANCHOR = { quote: 'selected span', prefix: 'the ', suffix: ' of text', startOffset: 4 };

describe('validating an annotation note at the boundary (task 15.2)', () => {
	let workDir;
	let dbPath;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-annotations-parse-note-'));
		// parseNote never touches the database; the harness still opens a throwaway file.
		dbPath = path.join(workDir, 'unused.db');
	});

	after(() => {
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('rejects an empty note', () => {
		const result = runAnnotations(dbPath, 'parseNote', { raw: '' });
		assert.equal(result.ok, false);
		assert.match(result.error, /required/i);
	});

	test('rejects a whitespace-only note (trimmed to empty)', () => {
		const result = runAnnotations(dbPath, 'parseNote', { raw: '   \t  ' });
		assert.equal(result.ok, false);
		assert.match(result.error, /required/i);
	});

	test('rejects a non-string note', () => {
		const result = runAnnotations(dbPath, 'parseNote', { raw: null });
		assert.equal(result.ok, false);
	});

	test('rejects a note longer than the maximum length', () => {
		const result = runAnnotations(dbPath, 'parseNote', { raw: 'x'.repeat(10_001) });
		assert.equal(result.ok, false);
		assert.match(result.error, /at most/i);
	});

	test('accepts a valid note and trims surrounding whitespace', () => {
		const result = runAnnotations(dbPath, 'parseNote', { raw: '  A useful remark  ' });
		assert.equal(result.ok, true);
		assert.equal(result.value, 'A useful remark');
	});
});

describe('validating an annotation anchor at the boundary (task 15.2)', () => {
	let workDir;
	let dbPath;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-annotations-parse-anchor-'));
		dbPath = path.join(workDir, 'unused.db');
	});

	after(() => {
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('rejects a non-object anchor', () => {
		assert.equal(runAnnotations(dbPath, 'parseAnchor', { raw: null }).ok, false);
		assert.equal(runAnnotations(dbPath, 'parseAnchor', { raw: 'nope' }).ok, false);
	});

	test('rejects an empty quote', () => {
		const result = runAnnotations(dbPath, 'parseAnchor', {
			raw: { quote: '', prefix: 'a', suffix: 'b', startOffset: 0 }
		});
		assert.equal(result.ok, false);
		assert.match(result.error, /quote/i);
	});

	test('rejects a non-string prefix or suffix', () => {
		assert.equal(
			runAnnotations(dbPath, 'parseAnchor', { raw: { quote: 'q', prefix: 1, suffix: 'b', startOffset: 0 } }).ok,
			false
		);
		assert.equal(
			runAnnotations(dbPath, 'parseAnchor', { raw: { quote: 'q', prefix: 'a', suffix: 2, startOffset: 0 } }).ok,
			false
		);
	});

	test('rejects a negative or non-integer offset', () => {
		assert.equal(
			runAnnotations(dbPath, 'parseAnchor', { raw: { quote: 'q', prefix: 'a', suffix: 'b', startOffset: -1 } }).ok,
			false
		);
		assert.equal(
			runAnnotations(dbPath, 'parseAnchor', { raw: { quote: 'q', prefix: 'a', suffix: 'b', startOffset: 1.5 } }).ok,
			false
		);
	});

	test('accepts a valid anchor, including empty prefix/suffix (selection at the body edge)', () => {
		const result = runAnnotations(dbPath, 'parseAnchor', {
			raw: { quote: 'edge', prefix: '', suffix: '', startOffset: 0 }
		});
		assert.equal(result.ok, true);
		assert.deepEqual(result.value, { quote: 'edge', prefix: '', suffix: '', startOffset: 0 });
	});
});

describe('creating and listing a card\'s annotations (task 15.2)', () => {
	let workDir;
	let dbPath;
	let cardId;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-annotations-crud-'));
		dbPath = path.join(workDir, 'annotations.db');
		cardId = migrateAndSeedCard(dbPath);
	});

	after(() => {
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('a card with no annotations lists an empty array (empty state)', () => {
		assert.deepEqual(runAnnotations(dbPath, 'list', { cardId }), []);
	});

	test('creating an annotation persists it and returns the created row', () => {
		const result = runAnnotations(dbPath, 'create', {
			cardId,
			note: 'First note',
			anchor: VALID_ANCHOR
		});
		assert.equal(result.ok, true);
		assert.ok(Number.isInteger(result.value.id));
		assert.equal(result.value.cardId, cardId);
		assert.equal(result.value.note, 'First note');
		assert.equal(result.value.quote, VALID_ANCHOR.quote);
		assert.equal(result.value.prefix, VALID_ANCHOR.prefix);
		assert.equal(result.value.suffix, VALID_ANCHOR.suffix);
		assert.equal(result.value.startOffset, VALID_ANCHOR.startOffset);
	});

	test('created annotations appear in the listing, ordered stably by creation then id', () => {
		runAnnotations(dbPath, 'create', { cardId, note: 'Second note', anchor: VALID_ANCHOR });

		const list = runAnnotations(dbPath, 'list', { cardId });
		assert.equal(list.length, 2);
		assert.deepEqual(
			list.map((a) => a.note),
			['First note', 'Second note']
		);
		// The list is sorted by (createdAt, id): even if both rows share the same
		// unixepoch second, the ascending id keeps insertion order stable.
		assert.ok(list[0].id < list[1].id);
	});

	test('creating an annotation for a card that no longer exists is a handled missing-card result, not a crash', () => {
		const result = runAnnotations(dbPath, 'create', {
			cardId: 999999,
			note: 'Orphan',
			anchor: VALID_ANCHOR
		});
		assert.deepEqual(result, { ok: false, reason: 'missing-card' });
	});
});

describe('updating an annotation note by id (task 15.2)', () => {
	let workDir;
	let dbPath;
	let cardId;
	let annotationId;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-annotations-update-'));
		dbPath = path.join(workDir, 'annotations.db');
		cardId = migrateAndSeedCard(dbPath);
		annotationId = runAnnotations(dbPath, 'create', { cardId, note: 'Before', anchor: VALID_ANCHOR }).value.id;
	});

	after(() => {
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('updating an existing note returns the updated row', () => {
		const result = runAnnotations(dbPath, 'update', { id: annotationId, note: 'After' });
		assert.ok(result.value);
		assert.equal(result.value.id, annotationId);
		assert.equal(result.value.note, 'After');

		const list = runAnnotations(dbPath, 'list', { cardId });
		assert.equal(list.find((a) => a.id === annotationId).note, 'After');
	});

	test('updating a missing id reports not-found (undefined), never a throw/500', () => {
		const result = runAnnotations(dbPath, 'update', { id: 999999, note: 'Ghost' });
		assert.equal(result.value, undefined, 'expected no row to be returned for an unknown annotation id');
	});
});

describe('deleting an annotation by id (task 15.2)', () => {
	let workDir;
	let dbPath;
	let cardId;
	let annotationId;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-annotations-delete-'));
		dbPath = path.join(workDir, 'annotations.db');
		cardId = migrateAndSeedCard(dbPath);
		annotationId = runAnnotations(dbPath, 'create', { cardId, note: 'To delete', anchor: VALID_ANCHOR }).value.id;
	});

	after(() => {
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('deleting an existing annotation reports it as actually removed', () => {
		const result = runAnnotations(dbPath, 'delete', { id: annotationId });
		assert.equal(result.deleted, true);
		assert.deepEqual(runAnnotations(dbPath, 'list', { cardId }), []);
	});

	test('deleting a missing id reports nothing deleted, not a silent success', () => {
		const result = runAnnotations(dbPath, 'delete', { id: annotationId });
		assert.equal(result.deleted, false);
	});
});

describe('listing every annotation across cards with its owning card (task 15.12)', () => {
	let workDir;
	let dbPath;
	let cardAId;
	let cardBId;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-annotations-list-all-'));
		dbPath = path.join(workDir, 'annotations.db');
		cardAId = migrateAndSeedCard(dbPath, 'a');
		cardBId = migrateAndSeedCard(dbPath, 'b');
	});

	after(() => {
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('with no annotations at all the global list is empty (empty state)', () => {
		assert.deepEqual(runAnnotations(dbPath, 'listAll', {}), []);
	});

	test('lists annotations from every card, each carrying its owning card identity', () => {
		runAnnotations(dbPath, 'create', { cardId: cardAId, note: 'Note on A', anchor: VALID_ANCHOR });
		runAnnotations(dbPath, 'create', { cardId: cardBId, note: 'Note on B', anchor: VALID_ANCHOR });

		const list = runAnnotations(dbPath, 'listAll', {});
		assert.equal(list.length, 2, 'both cards\' annotations must appear in the global list');

		const onA = list.find((a) => a.note === 'Note on A');
		const onB = list.find((a) => a.note === 'Note on B');
		assert.ok(onA && onB);
		assert.equal(onA.cardId, cardAId);
		assert.equal(onA.quote, VALID_ANCHOR.quote);
		assert.equal(onA.cardTitle, 'Card a');
		assert.equal(onA.cardSlug, 'card-a');
		assert.equal(onA.cardActive, true);
		assert.equal(onB.cardId, cardBId);
		assert.equal(onB.cardTitle, 'Card b');
	});

	test('is ordered most-recent-first (creation then id, descending)', () => {
		const list = runAnnotations(dbPath, 'listAll', {});
		// The two annotations may share the same unixepoch second, so the tie-break
		// on descending id keeps the last-inserted one first.
		assert.ok(list[0].id > list[1].id, 'the most recently created annotation must come first');
	});

	test('keeps listing an annotation whose card was soft-deleted, flagged inactive', () => {
		const raw = new Database(dbPath);
		try {
			raw.pragma('foreign_keys = ON');
			raw.prepare('UPDATE cards SET active = 0 WHERE id = ?').run(cardAId);
		} finally {
			raw.close();
		}

		const list = runAnnotations(dbPath, 'listAll', {});
		const onA = list.find((a) => a.cardId === cardAId);
		assert.ok(onA, 'a soft-deleted card must keep its annotation listed globally');
		assert.equal(onA.cardActive, false, 'the owning card must be reported as inactive');
	});
});

describe('annotations survive a soft-delete but cascade on a hard card deletion (task 15.1)', () => {
	let workDir;
	let dbPath;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-annotations-cascade-'));
		dbPath = path.join(workDir, 'annotations.db');
	});

	after(() => {
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	function countAnnotations(cardId) {
		const raw = new Database(dbPath);
		try {
			return raw.prepare('SELECT COUNT(*) AS n FROM annotations WHERE card_id = ?').get(cardId).n;
		} finally {
			raw.close();
		}
	}

	test('setting cards.active = false (soft-delete) keeps the card\'s annotations', () => {
		const cardId = migrateAndSeedCard(dbPath, 'soft');
		runAnnotations(dbPath, 'create', { cardId, note: 'Survives soft-delete', anchor: VALID_ANCHOR });
		assert.equal(countAnnotations(cardId), 1, 'sanity check: the annotation must exist before the soft-delete');

		const raw = new Database(dbPath);
		try {
			// foreign_keys must be ON so this test faithfully mirrors the app; a
			// soft-delete is a plain UPDATE and must never cascade.
			raw.pragma('foreign_keys = ON');
			raw.prepare('UPDATE cards SET active = 0 WHERE id = ?').run(cardId);
		} finally {
			raw.close();
		}

		assert.equal(countAnnotations(cardId), 1, 'a soft-delete (active = false) must preserve the annotations');
	});

	test('hard-deleting the card cascades its annotations away', () => {
		const cardId = migrateAndSeedCard(dbPath, 'hard');
		runAnnotations(dbPath, 'create', { cardId, note: 'Removed on hard delete', anchor: VALID_ANCHOR });
		assert.equal(countAnnotations(cardId), 1, 'sanity check: the annotation must exist before the hard delete');

		const raw = new Database(dbPath);
		try {
			raw.pragma('foreign_keys = ON');
			raw.prepare('DELETE FROM cards WHERE id = ?').run(cardId);
		} finally {
			raw.close();
		}

		assert.equal(countAnnotations(cardId), 0, 'a genuine card deletion must cascade-delete its annotations');
	});
});

test('the ROADMAP checks off tasks 15.1 and 15.2 (annotations data model + server module)', () => {
	const roadmap = fs.readFileSync(path.join(ROOT, 'docs', 'ROADMAP.md'), 'utf8');
	for (const taskId of ['15.1', '15.2']) {
		const escaped = taskId.replace('.', '\\.');
		const line = roadmap.split('\n').find((l) => new RegExp(`\\*\\*${escaped}\\*\\*`).test(l));
		assert.ok(line, `expected to find the "${taskId}" task line in docs/ROADMAP.md`);
		assert.match(line, /^- \[x\]/i, `task ${taskId} must be checked off`);
	}
});
