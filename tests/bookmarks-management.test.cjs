// Verifies tasks 9.1, 9.2 and 9.3 of docs/ROADMAP.md (section "9. Bookmarks"):
//   - 9.1 bookmark categories can be created, renamed and deleted: names are
//     validated at the server boundary (rejecting empty/blank input, trimming
//     surrounding whitespace), a duplicate name (on create or rename) is
//     reported as a handled unique-constraint violation rather than crashing,
//     and renaming/deleting an unknown category id is reported as "not found"
//     rather than a silent no-op success -- deleting a category also removes
//     its bookmarks (the schema's ON DELETE CASCADE).
//   - 9.2 a card can be bookmarked into a category: adding the same
//     (cardId, categoryId) pair twice is idempotent (a handled "duplicate"
//     result, never a crash), and a bookmark can be removed by that same pair
//     (toggle semantics), reporting whether one actually existed.
//   - 9.3 bookmarks list grouped by category, each entry carrying its card's
//     title/slug for display and a link to its card detail page; categories
//     with no bookmarks are still listed (empty state), and the grouping is
//     stably ordered.
//
// These exercise the real `src/lib/server/bookmarks.ts` module (the logic
// behind the /bookmarks page) against a real, freshly migrated SQLite
// database, following the same approach as tests/kb-management.test.cjs:
// because that module is TypeScript with extension-less relative imports
// (`./db/schema`), each check runs it out-of-process through `tsx` via a
// small harness script written to a throwaway temp file. Every database file
// used here lives under a fresh `mkdtempSync` directory, so this suite never
// touches the real project `data/` tree and can run concurrently with the
// rest of `node --test tests/`.
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

/** Run the project's reproducible migration ("npm run db:migrate", task 2.3). */
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
// `src/lib/server/bookmarks.ts` and `src/lib/server/db/index.ts` modules
// exactly as SvelteKit does, dispatch one action from `bookmarks.ts` against
// the given SQLite file, and print the JSON result on stdout. Errors thrown
// by the module (the unique-constraint violations task 9.1/9.2 must handle)
// are caught here and reported as `{ threw: true, unique: <bool> }` instead of
// a nonzero exit, so tests can assert on them.
const HARNESS_SOURCE = `
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [, , rootDir, dbPath, action, payloadJson] = process.argv;
const payload = JSON.parse(payloadJson || '{}');

const dbIndexUrl = pathToFileURL(path.join(rootDir, 'src', 'lib', 'server', 'db', 'index.ts')).href;
const bookmarksUrl = pathToFileURL(path.join(rootDir, 'src', 'lib', 'server', 'bookmarks.ts')).href;

const { createSqliteConnection, createDb } = await import(dbIndexUrl);
const bm = await import(bookmarksUrl);

const sqlite = createSqliteConnection(dbPath);
const db = createDb(sqlite);

function run() {
	switch (action) {
		case 'parseCategoryName':
			return bm.parseCategoryName(payload.raw);
		case 'createCategory':
			try {
				return { ok: true, value: bm.createBookmarkCategory(db, payload.name) };
			} catch (error) {
				return { ok: false, unique: bm.isUniqueConstraintError(error), message: String(error) };
			}
		case 'renameCategory':
			try {
				return { ok: true, value: bm.renameBookmarkCategory(db, payload.id, payload.name) };
			} catch (error) {
				return { ok: false, unique: bm.isUniqueConstraintError(error), message: String(error) };
			}
		case 'deleteCategory':
			return { deleted: bm.deleteBookmarkCategory(db, payload.id) };
		case 'listCategories':
			return bm.listBookmarkCategories(db);
		case 'addBookmark':
			return bm.addBookmark(db, payload.cardId, payload.categoryId);
		case 'removeBookmark':
			return { removed: bm.removeBookmark(db, payload.cardId, payload.categoryId) };
		case 'listByCategory':
			return bm.listBookmarksByCategory(db);
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
	harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-bookmarks-harness-'));
	harnessPath = path.join(harnessDir, 'bookmarks-harness.mjs');
	fs.writeFileSync(harnessPath, HARNESS_SOURCE, 'utf8');
});

after(() => {
	if (harnessDir) fs.rmSync(harnessDir, { recursive: true, force: true });
});

/** Run one `bookmarks.ts` action, out-of-process via tsx, and return its parsed JSON result. */
function runBookmarks(databasePath, action, payload) {
	const result = spawnSync(
		process.execPath,
		[TSX_CLI, harnessPath, ROOT, databasePath, action, JSON.stringify(payload ?? {})],
		{ cwd: ROOT, encoding: 'utf8', timeout: 30 * 1000 }
	);

	if (result.error) {
		throw new Error(`running bookmarks action "${action}" failed to spawn: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(
			`bookmarks action "${action}" exited with ${result.status}:\n${result.stdout}\n${result.stderr}`
		);
	}
	const output = result.stdout.trim();
	return output.length > 0 ? JSON.parse(output) : undefined;
}

describe('validating a bookmark category name (task 9.1)', () => {
	let workDir;
	let dbPath;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-bookmarks-parse-'));
		// parseCategoryName never touches the database, so no migration is
		// needed for these cases; the harness still opens a throwaway file.
		dbPath = path.join(workDir, 'unused.db');
	});

	after(() => {
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('rejects an empty name', () => {
		const result = runBookmarks(dbPath, 'parseCategoryName', { raw: '' });
		assert.equal(result.ok, false);
		assert.match(result.error, /required/i);
	});

	test('rejects a whitespace-only name (trimmed to empty)', () => {
		const result = runBookmarks(dbPath, 'parseCategoryName', { raw: '   \t  ' });
		assert.equal(result.ok, false);
		assert.match(result.error, /required/i);
	});

	test('rejects a non-string value', () => {
		const result = runBookmarks(dbPath, 'parseCategoryName', { raw: null });
		assert.equal(result.ok, false);
	});

	test('accepts a valid name and trims surrounding whitespace', () => {
		const result = runBookmarks(dbPath, 'parseCategoryName', { raw: '  Algorithms  ' });
		assert.equal(result.ok, true);
		assert.equal(result.value, 'Algorithms');
	});
});

describe('bookmark category CRUD (task 9.1)', () => {
	let workDir;
	let dbPath;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-bookmarks-crud-'));
		dbPath = path.join(workDir, 'bookmarks.db');
		runMigrate(dbPath);
	});

	after(() => {
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	let categoryId;

	test('creating a category persists it and it appears in the listing', () => {
		const created = runBookmarks(dbPath, 'createCategory', { name: 'Algorithms' });
		assert.equal(created.ok, true);
		assert.ok(Number.isInteger(created.value.id));
		assert.equal(created.value.name, 'Algorithms');
		categoryId = created.value.id;

		const list = runBookmarks(dbPath, 'listCategories', {});
		assert.ok(list.some((c) => c.id === categoryId && c.name === 'Algorithms'));
	});

	test('creating a second category with the same name is a handled unique-constraint violation, not a crash', () => {
		const result = runBookmarks(dbPath, 'createCategory', { name: 'Algorithms' });
		assert.equal(result.ok, false);
		assert.equal(result.unique, true, 'expected a duplicate category name to be reported as a unique-constraint error');
	});

	test('renaming a category updates its name', () => {
		// Creates a second category ("Databases") so the next test can attempt
		// to rename `categoryId` onto its name.
		runBookmarks(dbPath, 'createCategory', { name: 'Databases' });

		const renamed = runBookmarks(dbPath, 'renameCategory', { id: categoryId, name: 'Data Structures' });
		assert.equal(renamed.ok, true);
		assert.equal(renamed.value.id, categoryId);
		assert.equal(renamed.value.name, 'Data Structures');

		const list = runBookmarks(dbPath, 'listCategories', {});
		assert.ok(list.some((c) => c.id === categoryId && c.name === 'Data Structures'));
	});

	test('renaming a category to a name already used by another category is a handled unique-constraint violation', () => {
		const result = runBookmarks(dbPath, 'renameCategory', { id: categoryId, name: 'Databases' });
		assert.equal(result.ok, false);
		assert.equal(result.unique, true);
	});

	test('renaming an unknown category id reports not-found (undefined), not a silent success', () => {
		const result = runBookmarks(dbPath, 'renameCategory', { id: 999999, name: 'Ghost Category' });
		assert.equal(result.ok, true);
		assert.equal(result.value, undefined, 'expected no row to be returned for an unknown category id');
	});

	test('deleting an unknown category id reports nothing deleted, not a silent success', () => {
		const result = runBookmarks(dbPath, 'deleteCategory', { id: 999999 });
		assert.equal(result.deleted, false);
	});

	test('deleting a category removes it and cascades its bookmarks', () => {
		// Fixture: a KB, a card, and a bookmark linking the card to categoryId.
		const raw = new Database(dbPath);
		raw
			.prepare('INSERT INTO knowledge_bases (name, repo_url, branch) VALUES (?, ?, ?)')
			.run('KB', 'https://example.test/repo.git', 'main');
		const kbId = raw.prepare('SELECT last_insert_rowid() AS id').get().id;
		raw.prepare('INSERT INTO cards (kb_id, slug, title, active) VALUES (?, ?, ?, 1)').run(kbId, 'card-1', 'Card One');
		const cardId = raw.prepare('SELECT last_insert_rowid() AS id').get().id;
		raw.close();

		const added = runBookmarks(dbPath, 'addBookmark', { cardId, categoryId });
		assert.equal(added.ok, true);

		const rawBefore = new Database(dbPath);
		assert.equal(
			rawBefore.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE category_id = ?').get(categoryId).n,
			1,
			'sanity check: the bookmark should exist before the category is deleted'
		);
		rawBefore.close();

		const result = runBookmarks(dbPath, 'deleteCategory', { id: categoryId });
		assert.equal(result.deleted, true);

		const rawAfter = new Database(dbPath);
		assert.equal(
			rawAfter.prepare('SELECT COUNT(*) AS n FROM bookmark_categories WHERE id = ?').get(categoryId).n,
			0,
			'the category row must be removed'
		);
		assert.equal(
			rawAfter.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE category_id = ?').get(categoryId).n,
			0,
			'deleting a category must cascade-delete its bookmarks'
		);
		rawAfter.close();
	});
});

describe('bookmarking a card into a category, toggle semantics (task 9.2)', () => {
	let workDir;
	let dbPath;
	let cardId;
	let categoryId;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-bookmarks-toggle-'));
		dbPath = path.join(workDir, 'bookmarks.db');
		runMigrate(dbPath);

		const raw = new Database(dbPath);
		raw
			.prepare('INSERT INTO knowledge_bases (name, repo_url, branch) VALUES (?, ?, ?)')
			.run('KB', 'https://example.test/repo.git', 'main');
		const kbId = raw.prepare('SELECT last_insert_rowid() AS id').get().id;
		raw.prepare('INSERT INTO cards (kb_id, slug, title, active) VALUES (?, ?, ?, 1)').run(kbId, 'card-1', 'Card One');
		cardId = raw.prepare('SELECT last_insert_rowid() AS id').get().id;
		raw.close();

		categoryId = runBookmarks(dbPath, 'createCategory', { name: 'Later' }).value.id;
	});

	after(() => {
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('adding a bookmark for a new (cardId, categoryId) pair reports it as newly created', () => {
		const result = runBookmarks(dbPath, 'addBookmark', { cardId, categoryId });
		assert.deepEqual(result, { ok: true, created: true });

		const raw = new Database(dbPath);
		assert.equal(
			raw.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE card_id = ? AND category_id = ?').get(cardId, categoryId).n,
			1
		);
		raw.close();
	});

	test('adding the same (cardId, categoryId) bookmark again is idempotent, not a crash', () => {
		const result = runBookmarks(dbPath, 'addBookmark', { cardId, categoryId });
		assert.deepEqual(result, { ok: false, reason: 'duplicate' });

		const raw = new Database(dbPath);
		assert.equal(
			raw.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE card_id = ? AND category_id = ?').get(cardId, categoryId).n,
			1,
			'the duplicate add must not create a second row'
		);
		raw.close();
	});

	test('removing the bookmark for that pair reports it as actually removed', () => {
		const result = runBookmarks(dbPath, 'removeBookmark', { cardId, categoryId });
		assert.equal(result.removed, true);

		const raw = new Database(dbPath);
		assert.equal(
			raw.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE card_id = ? AND category_id = ?').get(cardId, categoryId).n,
			0
		);
		raw.close();
	});

	test('removing a bookmark for a pair that no longer exists reports nothing removed, not a silent success', () => {
		const result = runBookmarks(dbPath, 'removeBookmark', { cardId, categoryId });
		assert.equal(result.removed, false);
	});

	test('after remove, the same pair can be bookmarked again (toggle back on)', () => {
		const result = runBookmarks(dbPath, 'addBookmark', { cardId, categoryId });
		assert.deepEqual(result, { ok: true, created: true });
	});
});

describe('listing bookmarks grouped by category (task 9.3)', () => {
	let workDir;
	let dbPath;
	let cardOneId;
	let cardTwoId;
	let categoryAId;
	let categoryBId;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-bookmarks-list-'));
		dbPath = path.join(workDir, 'bookmarks.db');
		runMigrate(dbPath);

		const raw = new Database(dbPath);
		raw
			.prepare('INSERT INTO knowledge_bases (name, repo_url, branch) VALUES (?, ?, ?)')
			.run('KB', 'https://example.test/repo.git', 'main');
		const kbId = raw.prepare('SELECT last_insert_rowid() AS id').get().id;
		raw.prepare('INSERT INTO cards (kb_id, slug, title, active) VALUES (?, ?, ?, 1)').run(kbId, 'card-1', 'Binary Search');
		cardOneId = raw.prepare('SELECT last_insert_rowid() AS id').get().id;
		raw.prepare('INSERT INTO cards (kb_id, slug, title, active) VALUES (?, ?, ?, 1)').run(kbId, 'card-2', 'Merge Sort');
		cardTwoId = raw.prepare('SELECT last_insert_rowid() AS id').get().id;
		raw.close();

		categoryAId = runBookmarks(dbPath, 'createCategory', { name: 'Alpha' }).value.id;
		categoryBId = runBookmarks(dbPath, 'createCategory', { name: 'Beta' }).value.id;
	});

	after(() => {
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('a category with no bookmarks is still listed, with an empty bookmarks array (empty state)', () => {
		const list = runBookmarks(dbPath, 'listByCategory', {});
		const alpha = list.find((c) => c.id === categoryAId);
		const beta = list.find((c) => c.id === categoryBId);
		assert.ok(alpha);
		assert.ok(beta);
		assert.deepEqual(alpha.bookmarks, []);
		assert.deepEqual(beta.bookmarks, []);
	});

	test('bookmarks appear grouped under their own category, carrying the card title and id', () => {
		runBookmarks(dbPath, 'addBookmark', { cardId: cardOneId, categoryId: categoryAId });
		runBookmarks(dbPath, 'addBookmark', { cardId: cardTwoId, categoryId: categoryBId });

		const list = runBookmarks(dbPath, 'listByCategory', {});
		const alpha = list.find((c) => c.id === categoryAId);
		const beta = list.find((c) => c.id === categoryBId);

		assert.equal(alpha.bookmarks.length, 1);
		assert.equal(alpha.bookmarks[0].cardId, cardOneId);
		assert.equal(alpha.bookmarks[0].cardTitle, 'Binary Search');

		assert.equal(beta.bookmarks.length, 1);
		assert.equal(beta.bookmarks[0].cardId, cardTwoId);
		assert.equal(beta.bookmarks[0].cardTitle, 'Merge Sort');
	});

	test('a category with several bookmarks lists all of them, none dropped and none duplicated across categories', () => {
		runBookmarks(dbPath, 'addBookmark', { cardId: cardTwoId, categoryId: categoryAId });

		const list = runBookmarks(dbPath, 'listByCategory', {});
		const alpha = list.find((c) => c.id === categoryAId);
		const beta = list.find((c) => c.id === categoryBId);

		assert.equal(alpha.bookmarks.length, 2, 'Alpha should now hold both bookmarked cards');
		assert.deepEqual(
			alpha.bookmarks.map((b) => b.cardId).sort(),
			[cardOneId, cardTwoId].sort()
		);
		assert.equal(beta.bookmarks.length, 1, "Beta's own bookmark must be unaffected by Alpha's second bookmark");
	});
});

test('the ROADMAP checks off tasks 9.1, 9.2 and 9.3 (bookmarks)', () => {
	const roadmap = fs.readFileSync(path.join(ROOT, 'docs', 'ROADMAP.md'), 'utf8');
	for (const taskId of ['9.1', '9.2', '9.3']) {
		const escaped = taskId.replace('.', '\\.');
		const line = roadmap.split('\n').find((l) => new RegExp(`\\*\\*${escaped}\\*\\*`).test(l));
		assert.ok(line, `expected to find the "${taskId}" task line in docs/ROADMAP.md`);
		assert.match(line, /^- \[x\]/i, `task ${taskId} must be checked off`);
	}
});
