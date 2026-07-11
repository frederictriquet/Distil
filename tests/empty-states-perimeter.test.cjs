// tests/empty-states-perimeter.test.cjs
//
// Verifies roadmap task 12.2 ("Gerer les etats vides de maniere complete et
// coherente sur toutes les pages concernees") at the HTTP level, against a
// real running instance of the app. An empty study/browse perimeter can have
// several distinct causes, and each must produce a distinct, precise message
// (not a single generic "nothing here"):
//   - no knowledge base is configured at all (/ , /cards and /kb agree);
//   - knowledge bases exist but none is in focus (/ and /cards);
//   - a focused knowledge base exists but holds no active card yet, e.g.
//     never synced (/ and /cards);
//   - on /cards specifically, a search/filter combination matching nothing
//     is a *different* empty state from an empty perimeter, with its own
//     "reset filters" action;
//   - on /bookmarks, having no category at all is different from having
//     categories that simply hold no bookmark yet.
//
// Like tests/card-consultation.test.cjs, the app is started for real
// (Vite's dev server, driven programmatically) because which empty-state
// copy and action is picked depends on `load()` + view logic that cannot be
// observed by importing modules directly. The dev server is pointed at a
// throwaway copy of the project (node_modules brought in via a directory
// junction) instead of this repo checkout, and its SQLite file lives under a
// fresh temp directory, so this suite never touches the real project tree
// and is safe to run concurrently with the rest of `node --test tests/`. The
// server binds to a port freshly probed from the OS rather than a hardcoded
// one, so concurrent runs never collide.
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

const TEST_PASSWORD = 'correct horse battery staple';
const TEST_SESSION_SECRET = 'z'.repeat(32);
const STARTUP_TIMEOUT_MS = 30 * 1000;
const SHUTDOWN_TIMEOUT_MS = 5 * 1000;

// Bootstraps Vite's dev server programmatically, pointed at a throwaway copy
// of this repo's config, bound to a caller-chosen port. See
// tests/access-guard-and-logout.test.cjs for the rationale of every detail
// here (resolving 'vite' from inside the copy's junction-linked node_modules,
// a dedicated cacheDir, etc.) -- this harness is intentionally identical.
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
	const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-empty-states-app-copy-'));
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
	const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-empty-states-web-harness-'));
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
					resolve({
						status: res.statusCode,
						headers: {
							get: (name) => {
								const value = res.headers[name.toLowerCase()];
								return Array.isArray(value) ? value.join(', ') : (value ?? null);
							}
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
	const setCookie = res.headers.get('set-cookie');
	assert.ok(setCookie, 'expected a Set-Cookie header on a successful login');
	return cookiePair(setCookie);
}

/** Open a short-lived raw connection to seed fixtures directly. */
function withRawDb(dbPath, fn) {
	const conn = new Database(dbPath);
	try {
		return fn(conn);
	} finally {
		conn.close();
	}
}

// Distinguishing substrings shared by the study view (/) and the cards index
// (/cards) for each empty-perimeter cause (see src/routes/+page.svelte and
// src/routes/cards/+page.svelte): the wording differs by page only in its
// second half (what the action is *for*), but the first sentence naming the
// cause is identical, which is exactly the kind of cross-page consistency
// task 12.1 calls for and this suite pins down.
const NO_KB_MARKER = /you have no knowledge base yet/i;
const NO_FOCUS_MARKER = /no knowledge base is in focus/i;
const NO_ACTIVE_CARDS_MARKER = /have no active cards yet/i;

describe('no knowledge base configured at all: / , /cards and /kb agree on a precise empty state (task 12.2)', () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-empty-no-kb-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);
		// No knowledge_bases row at all.

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

	test('GET / explains no KB is configured yet and links to /kb to add one', async () => {
		const res = await fetch(`${app.baseUrl}/`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /No card to study/);
		assert.match(html, NO_KB_MARKER, 'expected the "no KB configured" cause to be named explicitly');
		assert.doesNotMatch(html, NO_FOCUS_MARKER);
		assert.doesNotMatch(html, NO_ACTIVE_CARDS_MARKER);
		assert.match(html, /href="\/kb"/, 'expected a useful action link to /kb');
	});

	test('GET /cards explains no KB is configured yet and links to /kb to add one', async () => {
		const res = await fetch(`${app.baseUrl}/cards`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /No cards available/);
		assert.match(html, NO_KB_MARKER);
		assert.doesNotMatch(html, NO_FOCUS_MARKER);
		assert.doesNotMatch(html, NO_ACTIVE_CARDS_MARKER);
		assert.match(html, /href="\/kb"/);
	});

	test('GET /kb shows its own "no knowledge base yet" empty state', async () => {
		const res = await fetch(`${app.baseUrl}/kb`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /no knowledge base yet/i);
	});
});

describe('knowledge bases exist but none is in focus: / and /cards name that specific cause (task 12.2)', () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-empty-no-focus-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);

		withRawDb(dbPath, (raw) => {
			// A KB with an active card, but NOT in focus: proves the empty state is
			// really about focus, not about a missing card.
			raw
				.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 0)')
				.run('Unfocused KB', 'https://example.test/unfocused.git', 'main');
			raw
				.prepare('INSERT INTO cards (id, kb_id, slug, title, active) VALUES (1, 1, ?, ?, 1)')
				.run('out-of-focus-card', 'Out Of Focus Card');
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

	test('GET / explains no KB is in focus (distinct from "no KB configured") and links to /kb', async () => {
		const res = await fetch(`${app.baseUrl}/`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /No card to study/);
		assert.match(html, NO_FOCUS_MARKER, 'expected the "no KB in focus" cause to be named explicitly');
		assert.doesNotMatch(html, NO_KB_MARKER, 'must not be confused with the "no KB at all" empty state');
		assert.doesNotMatch(html, NO_ACTIVE_CARDS_MARKER);
		assert.doesNotMatch(html, /Out Of Focus Card/, 'a card outside the focused perimeter must never be drawn');
		assert.match(html, /href="\/kb"/, 'expected a useful action link to /kb to manage focus');
	});

	test('GET /cards explains no KB is in focus (distinct from "no KB configured") and links to /kb', async () => {
		const res = await fetch(`${app.baseUrl}/cards`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /No cards available/);
		assert.match(html, NO_FOCUS_MARKER);
		assert.doesNotMatch(html, NO_KB_MARKER);
		assert.doesNotMatch(html, NO_ACTIVE_CARDS_MARKER);
		assert.doesNotMatch(html, /Out Of Focus Card/, 'a card outside the focused perimeter must never be listed');
		assert.match(html, /href="\/kb"/);
	});
});

describe('a focused knowledge base has no active card yet: / and /cards name that specific cause (task 12.2)', () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-empty-no-active-cards-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);

		withRawDb(dbPath, (raw) => {
			// A focused KB, but its only card was deactivated (e.g. every file left
			// the repo on the last sync): the perimeter is focused yet still empty.
			raw
				.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 1)')
				.run('Focused KB', 'https://example.test/focused.git', 'main');
			raw
				.prepare('INSERT INTO cards (id, kb_id, slug, title, active) VALUES (1, 1, ?, ?, 0)')
				.run('deactivated-only-card', 'Deactivated Only Card');
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

	test('GET / explains the focused perimeter has no active card yet and suggests syncing', async () => {
		const res = await fetch(`${app.baseUrl}/`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /No card to study/);
		assert.match(html, NO_ACTIVE_CARDS_MARKER, 'expected the "no active card yet" cause to be named explicitly');
		assert.doesNotMatch(html, NO_KB_MARKER);
		assert.doesNotMatch(html, NO_FOCUS_MARKER);
		assert.doesNotMatch(html, /Deactivated Only Card/, 'an inactive card must never be drawn for study');
		assert.match(html, /href="\/kb"/, 'expected a useful action link to /kb to sync');
	});

	test('GET /cards explains the focused perimeter has no active card yet and suggests syncing', async () => {
		const res = await fetch(`${app.baseUrl}/cards`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /No cards available/);
		assert.match(html, NO_ACTIVE_CARDS_MARKER);
		assert.doesNotMatch(html, NO_KB_MARKER);
		assert.doesNotMatch(html, NO_FOCUS_MARKER);
		assert.doesNotMatch(html, /Deactivated Only Card/, 'an inactive card must never be listed');
		assert.match(html, /href="\/kb"/);
	});
});

describe('/cards: a search/filter matching nothing is a distinct empty state from an empty perimeter (task 12.2)', () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-empty-no-match-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);

		withRawDb(dbPath, (raw) => {
			// A non-empty, focused perimeter: the search below must find nothing
			// despite eligible cards existing, so the empty state must be the
			// "no match" one, not any perimeter-empty one.
			raw
				.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 1)')
				.run('Focused KB', 'https://example.test/focused.git', 'main');
			raw
				.prepare(
					'INSERT INTO cards (id, kb_id, slug, title, content, active) VALUES (1, 1, ?, ?, ?, 1)'
				)
				.run('findable-card', 'Findable Card', 'Body about databases.');
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

	test('GET /cards?q=<no match> shows the "no match" empty state with a reset-filters action, not a perimeter-empty one', async () => {
		const res = await fetch(`${app.baseUrl}/cards?q=${encodeURIComponent('zzz-no-such-term-zzz')}`, {
			redirect: 'manual',
			headers: { cookie }
		});
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /No cards match/);
		assert.doesNotMatch(html, /No cards available/, 'a "no match" search must not be reported as an empty perimeter');
		assert.doesNotMatch(html, NO_KB_MARKER);
		assert.doesNotMatch(html, NO_FOCUS_MARKER);
		assert.doesNotMatch(html, NO_ACTIVE_CARDS_MARKER);
		assert.doesNotMatch(html, /Findable Card/);
		assert.match(html, /href="\/cards"/, 'expected a useful "reset filters" action back to the unfiltered list');
	});

	test('GET /cards with no filter shows the matching card, confirming the previous case was genuinely "no match"', async () => {
		const res = await fetch(`${app.baseUrl}/cards`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /Findable Card/);
		assert.doesNotMatch(html, /No cards match/);
		assert.doesNotMatch(html, /No cards available/);
	});
});

describe('/bookmarks: no category at all is distinct from categories that simply hold no bookmark (task 12.2)', () => {
	let appNoCategories;
	let workDirNoCategories;

	let appWithEmptyCategory;
	let workDirWithEmptyCategory;

	before(async () => {
		workDirNoCategories = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-empty-no-categories-'));
		const dbPathNoCategories = path.join(workDirNoCategories, 'app.db');
		runMigrate(dbPathNoCategories);
		// No bookmark_categories row at all.
		appNoCategories = await startApp({
			APP_PASSWORD: TEST_PASSWORD,
			SESSION_SECRET: TEST_SESSION_SECRET,
			DATABASE_PATH: dbPathNoCategories
		});

		workDirWithEmptyCategory = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-empty-empty-category-'));
		const dbPathWithEmptyCategory = path.join(workDirWithEmptyCategory, 'app.db');
		runMigrate(dbPathWithEmptyCategory);
		withRawDb(dbPathWithEmptyCategory, (raw) => {
			raw.prepare('INSERT INTO bookmark_categories (id, name) VALUES (1, ?)').run('Empty Category');
		});
		appWithEmptyCategory = await startApp({
			APP_PASSWORD: TEST_PASSWORD,
			SESSION_SECRET: TEST_SESSION_SECRET,
			DATABASE_PATH: dbPathWithEmptyCategory
		});
	});

	after(async () => {
		if (appNoCategories) await appNoCategories.stop();
		if (workDirNoCategories) fs.rmSync(workDirNoCategories, { recursive: true, force: true });
		if (appWithEmptyCategory) await appWithEmptyCategory.stop();
		if (workDirWithEmptyCategory) fs.rmSync(workDirWithEmptyCategory, { recursive: true, force: true });
	});

	test('GET /bookmarks with no category at all shows the "no categories yet" empty state', async () => {
		const cookie = await login(appNoCategories.baseUrl);
		const res = await fetch(`${appNoCategories.baseUrl}/bookmarks`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /No categories yet/);
		assert.doesNotMatch(html, /No bookmarks yet/, 'must not be confused with the "has categories, no bookmarks" state');
	});

	test('GET /bookmarks with a category but no bookmark shows the "no bookmarks yet" empty state', async () => {
		const cookie = await login(appWithEmptyCategory.baseUrl);
		const res = await fetch(`${appWithEmptyCategory.baseUrl}/bookmarks`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /Empty Category/, 'the existing category must still be listed');
		assert.match(html, /No bookmarks yet/);
		assert.doesNotMatch(html, /No categories yet/, 'must not be confused with the "no category at all" state');
	});
});
