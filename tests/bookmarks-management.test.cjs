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
// The first part of this suite exercises the real `src/lib/server/bookmarks.ts`
// module (the logic behind the /bookmarks page) against a real, freshly
// migrated SQLite database, following the same approach as
// tests/kb-management.test.cjs: because that module is TypeScript with
// extension-less relative imports (`./db/schema`), each check runs it
// out-of-process through `tsx` via a small harness script written to a
// throwaway temp file. Every database file used here lives under a fresh
// `mkdtempSync` directory, so this suite never touches the real project
// `data/` tree and can run concurrently with the rest of `node --test tests/`.
//
// The second part ("the bookmarks route's action/HTTP contract") drives the
// actual SvelteKit `+page.server.ts` actions (createCategory, renameCategory,
// deleteCategory, addBookmark, removeBookmark) over real HTTP against a
// running instance of the app, the same way tests/access-guard-and-logout.test.cjs
// covers the KB route's actions: this is the only way to observe the id
// parsing (`parseId`) and HTTP status mapping (`fail(400)`/`fail(404)`/
// `fail(409)`) that live in the route file itself, which the module-level
// checks above cannot reach.
//
// Run with: node --test tests/
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

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

	test('adding a bookmark whose card no longer exists is a handled missing-reference result, not a crash', () => {
		const result = runBookmarks(dbPath, 'addBookmark', { cardId: 999999, categoryId });
		assert.deepEqual(result, { ok: false, reason: 'missing-reference' });
	});

	test('adding a bookmark whose category no longer exists is a handled missing-reference result, not a crash', () => {
		const result = runBookmarks(dbPath, 'addBookmark', { cardId, categoryId: 999999 });
		assert.deepEqual(result, { ok: false, reason: 'missing-reference' });
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

// --- Part 2: the /bookmarks route's action/HTTP contract -------------------
//
// Bootstraps Vite's dev server programmatically (the same engine `npm run dev`
// uses), pointed at a throwaway copy of this repo (see buildIsolatedAppCopy
// below), bound to a caller-chosen port. This mirrors
// tests/access-guard-and-logout.test.cjs's harness exactly, including its
// rationale: Vite/svelte-kit sync write cache/build state into the project
// root they are pointed at, so the dev server is pointed at a temp copy
// (node_modules brought in via a directory junction, never copied) instead of
// this repo checkout, and the server binds to a port freshly probed from the
// OS so this suite is safe to run concurrently with the rest of `node --test`.
const HTTP_HARNESS_SOURCE = `
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [, , rootDir, portArg] = process.argv;
const port = Number(portArg);

const viteEntry = pathToFileURL(path.join(rootDir, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href;
const { createServer } = await import(viteEntry);

const server = await createServer({
	root: rootDir,
	configFile: path.join(rootDir, 'vite.config.ts'),
	cacheDir: path.join(rootDir, '.vite-cache'),
	server: { port, host: '127.0.0.1', strictPort: true },
	logLevel: 'error'
});

await server.listen();
process.stdout.write('READY\\n');
`;

const APP_COPY_FILES = ['package.json', 'svelte.config.js', 'vite.config.ts', 'tsconfig.json'];
const APP_COPY_DIRS = ['src', 'static'];

/** Materialize a throwaway copy of the project that Vite can be pointed at. */
function buildIsolatedAppCopy() {
	const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-bookmarks-app-copy-'));
	for (const file of APP_COPY_FILES) {
		fs.cpSync(path.join(ROOT, file), path.join(appDir, file));
	}
	for (const dir of APP_COPY_DIRS) {
		fs.cpSync(path.join(ROOT, dir), path.join(appDir, dir), { recursive: true });
	}
	fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(appDir, 'node_modules'), 'junction');
	return appDir;
}

/** Ask the OS for a free TCP port by briefly binding to port 0, then release it. */
function getEphemeralPort() {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close((closeErr) => (closeErr ? reject(closeErr) : resolve(port)));
		});
	});
}

const STARTUP_TIMEOUT_MS = 30 * 1000;
const SHUTDOWN_TIMEOUT_MS = 5 * 1000;

/** Start the real app (via the Vite dev server harness above) with the given environment. */
async function startApp(env) {
	const port = await getEphemeralPort();
	const appDir = buildIsolatedAppCopy();
	const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-bookmarks-web-harness-'));
	const harnessPath = path.join(harnessDir, 'web-harness.mjs');
	fs.writeFileSync(harnessPath, HTTP_HARNESS_SOURCE, 'utf8');

	const child = spawn(process.execPath, [TSX_CLI, harnessPath, appDir, String(port)], {
		cwd: appDir,
		env: { ...process.env, ...env },
		stdio: ['ignore', 'pipe', 'pipe']
	});

	let stdoutBuf = '';
	let stderrBuf = '';
	child.stdout.on('data', (chunk) => {
		stdoutBuf += chunk.toString();
	});
	child.stderr.on('data', (chunk) => {
		stderrBuf += chunk.toString();
	});

	await new Promise((resolve, reject) => {
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(
				new Error(
					`dev server harness did not report readiness within ${STARTUP_TIMEOUT_MS}ms.\n` +
						`stdout:\n${stdoutBuf}\nstderr:\n${stderrBuf}`
				)
			);
		}, STARTUP_TIMEOUT_MS);

		function checkReady() {
			if (settled || !/^READY$/m.test(stdoutBuf)) return;
			settled = true;
			cleanup();
			resolve();
		}
		function onError(err) {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error(`failed to spawn the dev server harness: ${err.message}`));
		}
		function onExit(code, signal) {
			if (settled) return;
			settled = true;
			cleanup();
			reject(
				new Error(
					`dev server harness exited early (code=${code}, signal=${signal}) before becoming ready.\n` +
						`stderr:\n${stderrBuf}`
				)
			);
		}
		function cleanup() {
			clearTimeout(timer);
			child.stdout.removeListener('data', checkReady);
			child.removeListener('error', onError);
			child.removeListener('exit', onExit);
		}

		child.stdout.on('data', checkReady);
		child.once('error', onError);
		child.once('exit', onExit);
		checkReady();
	});

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		async stop() {
			child.kill('SIGKILL');
			await new Promise((resolve) => {
				const timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
				child.once('close', () => {
					clearTimeout(timer);
					resolve();
				});
			});
			child.stdout?.destroy();
			child.stderr?.destroy();
			fs.rmSync(harnessDir, { recursive: true, force: true });
			fs.rmSync(path.join(appDir, 'node_modules'), { force: true });
			fs.rmSync(appDir, { recursive: true, force: true });
		}
	};
}

const REQUEST_TIMEOUT_MS = 10 * 1000;

/** A minimal fetch-shaped helper built on node:http; see access-guard-and-logout.test.cjs for the rationale (no dangling keep-alive sockets). */
function fetch(url, { method = 'GET', headers = {}, body } = {}) {
	const target = new URL(url);
	const requestBody = body === undefined ? undefined : String(body);
	const requestHeaders = { ...headers };
	if (requestBody !== undefined) {
		requestHeaders['content-type'] ??= 'application/x-www-form-urlencoded;charset=UTF-8';
		requestHeaders['content-length'] = Buffer.byteLength(requestBody);
	}
	requestHeaders.connection = 'close';

	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: target.hostname,
				port: target.port,
				path: target.pathname + target.search,
				method,
				headers: requestHeaders,
				agent: false,
				timeout: REQUEST_TIMEOUT_MS
			},
			(res) => {
				const chunks = [];
				res.on('data', (chunk) => chunks.push(chunk));
				res.on('end', () => {
					const rawBody = Buffer.concat(chunks).toString('utf8');
					const setCookie = res.headers['set-cookie'];
					resolve({
						status: res.statusCode,
						headers: {
							get: (name) => {
								const value = res.headers[name.toLowerCase()];
								return Array.isArray(value) ? value.join(', ') : (value ?? null);
							},
							getSetCookie: () => (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [])
						},
						async text() {
							return rawBody;
						},
						async json() {
							return JSON.parse(rawBody);
						}
					});
				});
				res.on('error', (err) => reject(new Error(`response error for ${url}: ${err.message}`)));
			}
		);
		req.on('timeout', () => req.destroy(new Error(`request to ${url} timed out after ${REQUEST_TIMEOUT_MS}ms`)));
		req.on('error', (err) => reject(new Error(`request error for ${url}: ${err.message}`)));
		if (requestBody !== undefined) req.write(requestBody);
		req.end();
	});
}

const TEST_PASSWORD = 'correct horse battery staple';
const TEST_SESSION_SECRET = 'y'.repeat(32);

/** POST a classic (no-JS) login submission and return the raw response. */
function submitLogin(baseUrl, password = TEST_PASSWORD) {
	return fetch(`${baseUrl}/login`, {
		method: 'POST',
		redirect: 'manual',
		body: new URLSearchParams({ password })
	});
}

/** The `name=value` pair of the distil_session Set-Cookie header, for a subsequent request's Cookie header. */
function extractSessionCookiePair(response) {
	const setCookie = response.headers.getSetCookie();
	const cookie = setCookie.find((c) => c.startsWith('distil_session='));
	assert.ok(cookie, 'expected a distil_session Set-Cookie header from login');
	return cookie.split(';')[0];
}

describe("the bookmarks route's action/HTTP contract (tasks 9.1, 9.2: id validation and status-code mapping)", () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;
	let cardId;
	let categoryId;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-bookmarks-http-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);

		// Fixture: a KB and a card, so addBookmark/removeBookmark have a real
		// cardId to reference, plus a category for the id-validation checks.
		const raw = new Database(dbPath);
		raw
			.prepare('INSERT INTO knowledge_bases (name, repo_url, branch) VALUES (?, ?, ?)')
			.run('KB', 'https://example.test/repo.git', 'main');
		const kbId = raw.prepare('SELECT last_insert_rowid() AS id').get().id;
		raw.prepare('INSERT INTO cards (kb_id, slug, title, active) VALUES (?, ?, ?, 1)').run(kbId, 'card-1', 'Card One');
		cardId = raw.prepare('SELECT last_insert_rowid() AS id').get().id;
		raw
			.prepare('INSERT INTO bookmark_categories (name) VALUES (?)')
			.run('Existing Category');
		categoryId = raw.prepare('SELECT last_insert_rowid() AS id').get().id;
		raw.close();

		app = await startApp({
			APP_PASSWORD: TEST_PASSWORD,
			SESSION_SECRET: TEST_SESSION_SECRET,
			DATABASE_PATH: dbPath
		});

		const loginRes = await submitLogin(app.baseUrl);
		assert.equal(loginRes.status, 303, 'sanity check: login must succeed before exercising the guarded route');
		cookie = extractSessionCookiePair(loginRes);
	});

	after(async () => {
		if (app) await app.stop();
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	/**
	 * `Accept: text/html` mirrors a classic (no-JS) form submission, which is
	 * the mode in which SvelteKit answers with the *real* HTTP status code for
	 * a fail() result (see tests/access-guard-and-logout.test.cjs); without it,
	 * fail()/success results are all wrapped in a 200 JSON envelope instead.
	 */
	function callBookmarksAction(action, formFields) {
		return fetch(`${app.baseUrl}/bookmarks?/${action}`, {
			method: 'POST',
			redirect: 'manual',
			headers: { cookie, accept: 'text/html' },
			body: new URLSearchParams(formFields)
		});
	}

	test('createCategory with a blank name answers 400, not a silent success', async () => {
		assert.equal((await callBookmarksAction('createCategory', { name: '   ' })).status, 400);
	});

	test('createCategory with a name already in use answers 400 (handled unique-constraint violation)', async () => {
		assert.equal((await callBookmarksAction('createCategory', { name: 'Existing Category' })).status, 400);
	});

	test('createCategory with a valid, unused name answers success (not wrapped in an error)', async () => {
		const res = await callBookmarksAction('createCategory', { name: 'Brand New Category' });
		assert.equal(res.status, 200);
	});

	test('renameCategory with a non-numeric id answers 400, not a silent success', async () => {
		assert.equal((await callBookmarksAction('renameCategory', { id: 'not-a-number', name: 'Whatever' })).status, 400);
	});

	test('renameCategory with a missing id answers 400, not a silent success', async () => {
		assert.equal((await callBookmarksAction('renameCategory', { name: 'Whatever' })).status, 400);
	});

	test('renameCategory for an id that does not exist answers 404, not a silent success', async () => {
		assert.equal((await callBookmarksAction('renameCategory', { id: '999999', name: 'Ghost' })).status, 404);
	});

	test('renameCategory onto a name already used by another category answers 400', async () => {
		const created = await callBookmarksAction('createCategory', { name: 'Rename Target Collision' });
		assert.equal(created.status, 200);

		const res = await callBookmarksAction('renameCategory', { id: String(categoryId), name: 'Rename Target Collision' });
		assert.equal(res.status, 400);
	});

	test('renameCategory with a present id but a blank name answers 400, not a silent success', async () => {
		assert.equal((await callBookmarksAction('renameCategory', { id: String(categoryId), name: '   ' })).status, 400);
	});

	test('deleteCategory with a non-numeric id answers 400, not a silent success', async () => {
		assert.equal((await callBookmarksAction('deleteCategory', { id: 'nope' })).status, 400);
	});

	test('deleteCategory for an id that does not exist answers 404, not a silent success', async () => {
		assert.equal((await callBookmarksAction('deleteCategory', { id: '999999' })).status, 404);
	});

	test('addBookmark with a non-numeric cardId or categoryId answers 400, not a silent success', async () => {
		assert.equal((await callBookmarksAction('addBookmark', { cardId: 'x', categoryId: String(categoryId) })).status, 400);
		assert.equal((await callBookmarksAction('addBookmark', { cardId: String(cardId), categoryId: 'y' })).status, 400);
	});

	test('addBookmark for a new (cardId, categoryId) pair answers success', async () => {
		const res = await callBookmarksAction('addBookmark', { cardId: String(cardId), categoryId: String(categoryId) });
		assert.equal(res.status, 200);
	});

	test('addBookmark for a pair that is already bookmarked answers 409, not a 500', async () => {
		const res = await callBookmarksAction('addBookmark', { cardId: String(cardId), categoryId: String(categoryId) });
		assert.equal(res.status, 409);
	});

	test('addBookmark for a valid-but-nonexistent cardId answers 404 (foreign-key violation), not a 500', async () => {
		const res = await callBookmarksAction('addBookmark', { cardId: '999999', categoryId: String(categoryId) });
		assert.equal(res.status, 404);
	});

	test('addBookmark for a valid-but-nonexistent categoryId answers 404 (foreign-key violation), not a 500', async () => {
		const res = await callBookmarksAction('addBookmark', { cardId: String(cardId), categoryId: '999999' });
		assert.equal(res.status, 404);
	});

	test('removeBookmark with a non-numeric cardId or categoryId answers 400, not a silent success', async () => {
		assert.equal((await callBookmarksAction('removeBookmark', { cardId: 'x', categoryId: String(categoryId) })).status, 400);
		assert.equal((await callBookmarksAction('removeBookmark', { cardId: String(cardId), categoryId: 'y' })).status, 400);
	});

	test('removeBookmark for a pair that exists answers success', async () => {
		const res = await callBookmarksAction('removeBookmark', { cardId: String(cardId), categoryId: String(categoryId) });
		assert.equal(res.status, 200);
	});

	test('removeBookmark for a pair that no longer exists answers 404, not a silent success', async () => {
		const res = await callBookmarksAction('removeBookmark', { cardId: String(cardId), categoryId: String(categoryId) });
		assert.equal(res.status, 404);
	});

	test('an unauthenticated attempt to call a bookmarks action is redirected by the guard, never executed', async () => {
		const res = await fetch(`${app.baseUrl}/bookmarks?/deleteCategory`, {
			method: 'POST',
			redirect: 'manual',
			headers: { accept: 'text/html' },
			body: new URLSearchParams({ id: String(categoryId) })
		});
		assert.equal(res.status, 303);
		assert.equal(res.headers.get('location'), '/login?redirectTo=' + encodeURIComponent('/bookmarks?/deleteCategory'));
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
