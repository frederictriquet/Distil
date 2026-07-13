// tests/study-bookmark-panel.test.cjs
//
// Verifies roadmap 8.7 (the study view's bookmark panel) at the HTTP level,
// against a real running instance of the app -- the same approach as
// tests/study-reading-signal.test.cjs and the HTTP part of
// tests/bookmarks-management.test.cjs:
//   - the study view's `load` (src/routes/+page.server.ts) exposes the full
//     list of bookmark categories and the ids of the categories the current
//     card is already bookmarked in, fetched the same way the real client
//     does for a data-only request (SvelteKit's `/__data.json` endpoint),
//     since the panel that renders this data only mounts client-side (no-JS
//     HTML never shows it -- see src/routes/+page.svelte's `panelOpen` state);
//   - the `createCategory` named action creates a category inline from the
//     study view, reusing src/lib/server/bookmarks.ts, with the same
//     boundary validation and status mapping as the /bookmarks route (blank
//     name -> 400, duplicate name -> 409, per the route's own `fail(409, ...)`
//     for a unique-constraint violation -- note this differs from the
//     /bookmarks route's own createCategory, which answers 400 for a
//     duplicate; each route maps the same `isUniqueConstraintError` result to
//     its own chosen status, so this suite asserts the study route's actual
//     documented status (409), not the other route's);
//   - the `addBookmarks` named action saves the current card into every
//     selected category in one call: invalid/missing ids answer 4xx, and a
//     multi-category submission where one category is already bookmarked
//     succeeds for all of them (idempotent no-op for the duplicate, real
//     insert for the rest) rather than failing the whole batch.
//
// The actual opening of the panel (the "Bookmark" button) is client-runtime
// behaviour that cannot be driven meaningfully from Node, so it is not
// exercised here.
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
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const TSX_CLI = require.resolve('tsx/cli');
const DRIZZLE_KIT_CLI = path.join(ROOT, 'node_modules', 'drizzle-kit', 'bin.cjs');

const TEST_PASSWORD = 'correct horse battery staple';
const TEST_SESSION_SECRET = 'b'.repeat(32);
const STARTUP_TIMEOUT_MS = 30 * 1000;
const SHUTDOWN_TIMEOUT_MS = 5 * 1000;

// Bootstraps Vite's dev server programmatically, pointed at a throwaway copy
// of this repo, bound to a caller-chosen port. See
// tests/access-guard-and-logout.test.cjs for the rationale of every detail
// here -- this harness is intentionally identical to the one in
// tests/study-reading-signal.test.cjs and tests/bookmarks-management.test.cjs.
const HARNESS_SOURCE = `
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

/** Run the project's migration against an isolated database file. */
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
}

const APP_COPY_FILES = ['package.json', 'svelte.config.js', 'vite.config.ts', 'tsconfig.json'];
const APP_COPY_DIRS = ['src', 'static'];

/** Materialize a throwaway copy of the project for Vite to run against. */
function buildIsolatedAppCopy() {
	const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-bookmark-panel-app-copy-'));
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

/** Start the real app with the given environment; resolves once it is ready. */
async function startApp(env) {
	const port = await getEphemeralPort();
	const appDir = buildIsolatedAppCopy();
	const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-bookmark-panel-web-harness-'));
	const harnessPath = path.join(harnessDir, 'web-harness.mjs');
	fs.writeFileSync(harnessPath, HARNESS_SOURCE, 'utf8');

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

// See tests/access-guard-and-logout.test.cjs for the rationale of this
// node:http-based fetch-alike (avoiding undici's pooled keep-alive sockets,
// which would otherwise keep this test process alive after the server under
// test is killed).
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

/** All `Set-Cookie` values from a fetch response. */
function setCookies(response) {
	return typeof response.headers.getSetCookie === 'function'
		? response.headers.getSetCookie()
		: [response.headers.get('set-cookie')].filter(Boolean);
}

/** The `name=value` pair only, suitable for a subsequent request's Cookie header. */
function cookiePair(setCookieHeader) {
	return setCookieHeader.split(';')[0];
}

/** Log in and return a Cookie-header-ready session pair. */
async function login(baseUrl) {
	const res = await fetch(`${baseUrl}/login`, {
		method: 'POST',
		redirect: 'manual',
		body: new URLSearchParams({ password: TEST_PASSWORD })
	});
	assert.equal(res.status, 303, 'expected the test login to succeed');
	const cookie = setCookies(res).find((c) => c.startsWith('distil_session='));
	assert.ok(cookie, 'expected a distil_session Set-Cookie header from login');
	return cookiePair(cookie);
}

/** Open a short-lived raw connection to inspect/seed fixtures directly. */
function withRawDb(dbPath, fn) {
	const conn = new Database(dbPath);
	try {
		return fn(conn);
	} finally {
		conn.close();
	}
}

/**
 * Fetch the study view's `load` data over SvelteKit's own data-only HTTP
 * endpoint (`/__data.json`, documented at
 * https://svelte.dev/docs/kit/$app-navigation as the mechanism the client
 * router itself uses for data fetches) and decode it with the same `devalue`
 * codec SvelteKit encodes it with. This is the only way to observe `load`'s
 * `categories`/`bookmarkedCategoryIds` fields over real HTTP: the bookmark
 * panel that would otherwise render them only mounts client-side (its
 * `panelOpen` state starts `false`), so a plain no-JS `GET /` never shows them.
 */
async function fetchPageData(baseUrl, cookie) {
	const res = await fetch(`${baseUrl}/__data.json`, { headers: { cookie } });
	assert.equal(res.status, 200, 'expected the data-only request for / to succeed');
	const raw = await res.text();
	const parsed = JSON.parse(raw);
	assert.equal(parsed.type, 'data');

	const devalueUrl = pathToFileURL(path.join(ROOT, 'node_modules', 'devalue', 'index.js')).href;
	const { unflatten } = await import(devalueUrl);

	// Each entry is either null (a layout with no server load), a
	// `{ type: 'skip' }`/`{ type: 'error' }` marker, or `{ type: 'data', data:
	// <devalue-flattened array> }` for a node with a server load. The study
	// route has a single leaf load (src/routes/+page.server.ts, no
	// +layout.server.ts), so exactly one node carries our fields; find it by
	// shape rather than assuming a fixed index.
	for (const node of parsed.nodes) {
		if (!node || node.type !== 'data') continue;
		const data = unflatten(node.data);
		if (data && typeof data === 'object' && 'categories' in data) {
			return data;
		}
	}
	throw new Error(`no load node exposed 'categories' in /__data.json response:\n${raw}`);
}

describe("the study view's load exposes bookmark categories and the drawn card's bookmarked state (task 8.7)", () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;
	let cardId;
	let bookmarkedCategoryId;
	let otherCategoryId;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-bookmark-panel-load-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);

		withRawDb(dbPath, (raw) => {
			raw
				.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 1)')
				.run('Focused KB', 'https://example.test/focused.git', 'main');
			raw
				.prepare('INSERT INTO cards (id, kb_id, slug, title, theme, active) VALUES (1, 1, ?, ?, ?, 1)')
				.run('card-a', 'Card A Title', 'sql');
			cardId = 1;

			raw.prepare('INSERT INTO bookmark_categories (id, name) VALUES (1, ?)').run('Already Bookmarked');
			bookmarkedCategoryId = 1;
			raw.prepare('INSERT INTO bookmark_categories (id, name) VALUES (2, ?)').run('Not Bookmarked');
			otherCategoryId = 2;

			raw.prepare('INSERT INTO bookmarks (card_id, category_id) VALUES (?, ?)').run(cardId, bookmarkedCategoryId);
		});

		app = await startApp({
			APP_PASSWORD: TEST_PASSWORD,
			SESSION_SECRET: TEST_SESSION_SECRET,
			DATABASE_PATH: dbPath
		});
		cookie = await login(app.baseUrl);
	});

	after(async () => {
		if (app) await app.stop();
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('load returns every existing bookmark category', async () => {
		const data = await fetchPageData(app.baseUrl, cookie);
		const names = data.categories.map((c) => c.name).sort();
		assert.deepEqual(names, ['Already Bookmarked', 'Not Bookmarked']);
	});

	test("load returns only the categories the drawn card is actually bookmarked in", async () => {
		const data = await fetchPageData(app.baseUrl, cookie);
		assert.deepEqual(data.bookmarkedCategoryIds, [bookmarkedCategoryId]);
		assert.ok(
			!data.bookmarkedCategoryIds.includes(otherCategoryId),
			'a category the card was never bookmarked into must not be reported as bookmarked'
		);
	});

	test('an unauthenticated data request for / is redirected by the access guard, never exposing categories', async () => {
		// SvelteKit's data-only endpoint never answers a redirect with a real 3xx
		// (the client-side router needs to act on it in JS): it answers 200 with a
		// `{ type: 'redirect', location }` JSON envelope instead. See
		// node_modules/@sveltejs/kit/src/runtime/server/data/index.js
		// (redirect_json_response). Either way, the guard must fire before
		// `load` runs, so the body must never carry `categories`.
		const res = await fetch(`${app.baseUrl}/__data.json`);
		assert.equal(res.status, 200);
		const body = JSON.parse(await res.text());
		assert.equal(body.type, 'redirect');
		// The guard special-cases the root path: it drops `redirectTo` since '/'
		// is already the default post-login landing page (see hooks.server.ts).
		assert.equal(body.location, '/login');
	});
});

describe("the study view's createCategory action (task 8.7)", () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-bookmark-panel-create-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);

		withRawDb(dbPath, (raw) => {
			raw
				.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 1)')
				.run('Focused KB', 'https://example.test/focused.git', 'main');
			raw
				.prepare('INSERT INTO cards (id, kb_id, slug, title, theme, active) VALUES (1, 1, ?, ?, ?, 1)')
				.run('card-a', 'Card A Title', 'sql');
			raw.prepare('INSERT INTO bookmark_categories (id, name) VALUES (1, ?)').run('Existing Category');
		});

		app = await startApp({
			APP_PASSWORD: TEST_PASSWORD,
			SESSION_SECRET: TEST_SESSION_SECRET,
			DATABASE_PATH: dbPath
		});
		cookie = await login(app.baseUrl);
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
	function callStudyAction(action, formFields) {
		return fetch(`${app.baseUrl}/?/${action}`, {
			method: 'POST',
			redirect: 'manual',
			headers: { cookie, accept: 'text/html' },
			body: new URLSearchParams(formFields)
		});
	}

	function categoryCount(name) {
		return withRawDb(dbPath, (raw) =>
			raw.prepare('SELECT COUNT(*) AS n FROM bookmark_categories WHERE name = ?').get(name).n
		);
	}

	test('a blank category name answers 400, not a silent success', async () => {
		const res = await callStudyAction('createCategory', { name: '   ' });
		assert.equal(res.status, 400);
		assert.equal(categoryCount('   '), 0);
	});

	test('a name already used by another category answers 409 (handled unique-constraint violation), not a 500', async () => {
		const res = await callStudyAction('createCategory', { name: 'Existing Category' });
		assert.equal(res.status, 409);
	});

	test('a valid, unused name creates the category and answers success', async () => {
		assert.equal(categoryCount('Brand New Category'), 0, 'sanity check: must not exist yet');

		const res = await callStudyAction('createCategory', { name: '  Brand New Category  ' });
		assert.equal(res.status, 200);
		assert.equal(categoryCount('Brand New Category'), 1, 'the trimmed name must be persisted exactly once');
	});

	test('an unauthenticated attempt to create a category is redirected by the guard, never executed', async () => {
		const res = await fetch(`${app.baseUrl}/?/createCategory`, {
			method: 'POST',
			redirect: 'manual',
			headers: { accept: 'text/html' },
			body: new URLSearchParams({ name: 'Should Not Be Created' })
		});
		assert.equal(res.status, 303);
		assert.equal(categoryCount('Should Not Be Created'), 0);
	});
});

describe("the study view's addBookmarks action: saving the current card into several categories at once (task 8.7)", () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;
	let cardId;
	let alreadyBookmarkedCategoryId;
	let newCategoryId;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-bookmark-panel-add-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);

		withRawDb(dbPath, (raw) => {
			raw
				.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 1)')
				.run('Focused KB', 'https://example.test/focused.git', 'main');
			raw
				.prepare('INSERT INTO cards (id, kb_id, slug, title, theme, active) VALUES (1, 1, ?, ?, ?, 1)')
				.run('card-a', 'Card A Title', 'sql');
			cardId = 1;

			raw.prepare('INSERT INTO bookmark_categories (id, name) VALUES (1, ?)').run('Already Bookmarked');
			alreadyBookmarkedCategoryId = 1;
			raw.prepare('INSERT INTO bookmark_categories (id, name) VALUES (2, ?)').run('Not Yet Bookmarked');
			newCategoryId = 2;

			raw.prepare('INSERT INTO bookmarks (card_id, category_id) VALUES (?, ?)').run(cardId, alreadyBookmarkedCategoryId);
		});

		app = await startApp({
			APP_PASSWORD: TEST_PASSWORD,
			SESSION_SECRET: TEST_SESSION_SECRET,
			DATABASE_PATH: dbPath
		});
		cookie = await login(app.baseUrl);
	});

	after(async () => {
		if (app) await app.stop();
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	function callAddBookmarks(formFields) {
		return fetch(`${app.baseUrl}/?/addBookmarks`, {
			method: 'POST',
			redirect: 'manual',
			headers: { cookie, accept: 'text/html' },
			body: new URLSearchParams(formFields)
		});
	}

	function isBookmarked(theCardId, categoryId) {
		return (
			withRawDb(dbPath, (raw) =>
				raw
					.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE card_id = ? AND category_id = ?')
					.get(theCardId, categoryId)
			).n > 0
		);
	}

	test('a missing cardId answers 400, not a silent success', async () => {
		const res = await callAddBookmarks({ categoryId: String(newCategoryId) });
		assert.equal(res.status, 400);
	});

	test('a non-numeric cardId answers 400, not a silent success', async () => {
		const res = await callAddBookmarks({ cardId: 'not-a-number', categoryId: String(newCategoryId) });
		assert.equal(res.status, 400);
	});

	test('a non-numeric categoryId answers 400, not a silent success', async () => {
		const res = await callAddBookmarks({ cardId: String(cardId), categoryId: 'not-a-number' });
		assert.equal(res.status, 400);
	});

	test('no category selected at all answers 400, not a silent success', async () => {
		const res = await callAddBookmarks({ cardId: String(cardId) });
		assert.equal(res.status, 400);
	});

	test(
		'selecting a category the card is already bookmarked in together with a brand-new one succeeds for ' +
			'both -- the duplicate is an idempotent no-op, not a failure that blocks the rest',
		async () => {
			assert.equal(isBookmarked(cardId, newCategoryId), false, 'sanity check: not bookmarked yet');

			const params = new URLSearchParams();
			params.append('cardId', String(cardId));
			params.append('categoryId', String(alreadyBookmarkedCategoryId));
			params.append('categoryId', String(newCategoryId));

			const res = await callAddBookmarks(params);
			assert.equal(res.status, 200, 'a duplicate among several selections must not turn the whole save into a 500/failure');

			assert.equal(isBookmarked(cardId, alreadyBookmarkedCategoryId), true, 'the pre-existing bookmark must still be there');
			assert.equal(isBookmarked(cardId, newCategoryId), true, 'the new category must now be bookmarked too');
		}
	);

	test('a selection mixing a valid new category with a category id that does not exist answers 404, but still saves the valid one', async () => {
		withRawDb(dbPath, (raw) => {
			raw.prepare('INSERT INTO bookmark_categories (id, name) VALUES (3, ?)').run('Also New');
		});
		const alsoNewCategoryId = 3;
		assert.equal(isBookmarked(cardId, alsoNewCategoryId), false, 'sanity check: not bookmarked yet');

		const params = new URLSearchParams();
		params.append('cardId', String(cardId));
		params.append('categoryId', String(alsoNewCategoryId));
		params.append('categoryId', '999999');

		const res = await callAddBookmarks(params);
		assert.equal(res.status, 404, 'a missing category/card reference among the selection must be reported, not silently dropped');
		assert.equal(
			isBookmarked(cardId, alsoNewCategoryId),
			true,
			'a valid category in the same batch must still be saved despite another selection referencing nothing'
		);
	});

	test('a valid-but-nonexistent cardId answers 404 (foreign-key violation), not a 500', async () => {
		const res = await callAddBookmarks({ cardId: '999999', categoryId: String(newCategoryId) });
		assert.equal(res.status, 404);
	});

	test('an unauthenticated attempt to save bookmarks is redirected by the guard, never executed', async () => {
		const res = await fetch(`${app.baseUrl}/?/addBookmarks`, {
			method: 'POST',
			redirect: 'manual',
			headers: { accept: 'text/html' },
			body: new URLSearchParams({ cardId: String(cardId), categoryId: String(newCategoryId) })
		});
		assert.equal(res.status, 303);
	});
});

test('the ROADMAP checks off task 8.7 (bookmark panel)', () => {
	const roadmap = fs.readFileSync(path.join(ROOT, 'docs', 'ROADMAP.md'), 'utf8');
	const line = roadmap.split('\n').find((l) => /\*\*8\.7\*\*/.test(l));
	assert.ok(line, 'expected to find the "8.7" task line in docs/ROADMAP.md');
	assert.match(line, /^- \[x\]/i, 'task 8.7 must be checked off');
});
