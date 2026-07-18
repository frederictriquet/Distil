// tests/annotations-page.test.cjs
//
// Verifies roadmap task 15.12 of docs/ROADMAP.md ("section 15. Annotations sur
// les fiches") at the HTTP level, against a real running instance of the app:
//   - the global /annotations page lists every annotation across all cards,
//     each showing its note, its original quoted span and the card it belongs
//     to (title), with a working link to that card's consultation page
//     (/cards/<id>);
//   - a note can be edited from the page and the change persists (verified via
//     the database), while an edit with a blank note answers 400 and an edit of
//     an unknown annotation id answers 404 (never a silent ok);
//   - an annotation can be deleted from the page and is actually removed, while
//     deleting an unknown id answers 404;
//   - the empty state ("No annotations yet") renders when there are no
//     annotations at all;
//   - the access guard (task 3.3) protects the route: an unauthenticated GET
//     /annotations and unauthenticated edit/delete POSTs are redirected to the
//     login page, never executed.
//
// Like tests/card-consultation.test.cjs, the app is started for real (Vite's
// dev server, driven programmatically) because this behavior spans routing,
// load() functions, the +page.server actions and HTTP semantics (400/404,
// redirects) that cannot be observed by importing modules directly. The dev
// server is pointed at a throwaway copy of the project (node_modules brought in
// via a directory junction) instead of this repo checkout, and its SQLite file
// lives under a fresh temp directory, so this suite never touches the real
// project tree and is safe to run concurrently with the rest of `node --test
// tests/`. The server binds to a port freshly probed from the OS rather than a
// hardcoded one, so concurrent runs never collide.
//
// Run with: node --test tests/annotations-page.test.cjs
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
const TEST_SESSION_SECRET = 'a'.repeat(32);
const STARTUP_TIMEOUT_MS = 30 * 1000;
const SHUTDOWN_TIMEOUT_MS = 5 * 1000;

// Bootstraps Vite's dev server programmatically, pointed at a throwaway copy of
// this repo's config, bound to a caller-chosen port. See
// tests/access-guard-and-logout.test.cjs for the rationale of every detail here
// (resolving 'vite' from inside the copy's junction-linked node_modules, a
// dedicated cacheDir, etc.) -- this harness is intentionally identical to the
// one in tests/card-consultation.test.cjs.
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
	const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-annotations-page-app-copy-'));
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
	const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-annotations-page-web-harness-'));
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

/**
 * Post an /annotations form action the way a classic (no-JS) form submission
 * does. `Accept: text/html` makes SvelteKit answer with the real HTTP status
 * for a fail()/redirect result (same convention as
 * tests/card-consultation.test.cjs). `action` is the action name, e.g.
 * `updateAnnotation`.
 */
function postAction(baseUrl, action, { cookie, fields = {} } = {}) {
	const headers = { accept: 'text/html' };
	if (cookie) headers.cookie = cookie;
	return fetch(`${baseUrl}/annotations?/${action}`, {
		method: 'POST',
		redirect: 'manual',
		headers,
		body: new URLSearchParams(fields)
	});
}

/** Open a short-lived raw connection to seed fixtures / assert persistence directly. */
function withRawDb(dbPath, fn) {
	const conn = new Database(dbPath);
	try {
		return fn(conn);
	} finally {
		conn.close();
	}
}

describe('the global /annotations page lists, edits and deletes annotations (task 15.12)', () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-annotations-page-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);

		// Seed a KB, two cards, and one annotation on each: the page must gather
		// annotations across cards, each carrying its owning card's identity.
		withRawDb(dbPath, (raw) => {
			raw
				.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 0)')
				.run('KB One', 'https://example.test/one.git', 'main');
			raw
				.prepare('INSERT INTO cards (id, kb_id, slug, title, active) VALUES (30, 1, ?, ?, 1)')
				.run('binary-search', 'Binary Search');
			raw
				.prepare('INSERT INTO cards (id, kb_id, slug, title, active) VALUES (31, 1, ?, ?, 1)')
				.run('merge-sort', 'Merge Sort');
			raw
				.prepare(
					'INSERT INTO annotations (id, card_id, note, quote, prefix, suffix, start_offset) VALUES (100, 30, ?, ?, ?, ?, ?)'
				)
				.run('Note about the pivot', 'the pivot element', 'choose ', ' carefully', 7);
			raw
				.prepare(
					'INSERT INTO annotations (id, card_id, note, quote, prefix, suffix, start_offset) VALUES (101, 31, ?, ?, ?, ?, ?)'
				)
				.run('Note about merging', 'merge the halves', 'then ', ' back together', 5);
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

	test('GET /annotations lists every annotation with its note, quote, owning card and a link to the card', async () => {
		const res = await fetch(`${app.baseUrl}/annotations`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();

		// Both annotations' notes and quotes appear.
		assert.match(html, /Note about the pivot/, 'the first annotation note must be listed');
		assert.match(html, /the pivot element/, 'the first annotation quote must be listed');
		assert.match(html, /Note about merging/, 'the second annotation note must be listed');
		assert.match(html, /merge the halves/, 'the second annotation quote must be listed');

		// Each annotation shows which card it belongs to, and links to that card.
		assert.match(html, /Binary Search/, 'the first annotation must show its owning card title');
		assert.match(html, /Merge Sort/, 'the second annotation must show its owning card title');
		assert.match(html, /href="\/cards\/30"/, 'the first annotation must link to its card at /cards/30');
		assert.match(html, /href="\/cards\/31"/, 'the second annotation must link to its card at /cards/31');
	});

	test('editing a note persists the change (verified via the database)', async () => {
		const res = await postAction(app.baseUrl, 'updateAnnotation', {
			cookie,
			fields: { annotationId: '100', note: 'Rewritten note about the pivot' }
		});
		assert.equal(res.status, 200, 'a valid note edit must succeed');

		const stored = withRawDb(dbPath, (raw) =>
			raw.prepare('SELECT note FROM annotations WHERE id = ?').get(100)
		);
		assert.equal(stored.note, 'Rewritten note about the pivot', 'the edited note must be persisted');
	});

	test('editing a note to a blank value answers 400, not a silent success', async () => {
		const res = await postAction(app.baseUrl, 'updateAnnotation', {
			cookie,
			fields: { annotationId: '100', note: '   ' }
		});
		assert.equal(res.status, 400);

		const stored = withRawDb(dbPath, (raw) =>
			raw.prepare('SELECT note FROM annotations WHERE id = ?').get(100)
		);
		assert.equal(stored.note, 'Rewritten note about the pivot', 'a rejected edit must not overwrite the note');
	});

	test('editing an annotation id that matches nothing answers 404, not a silent success', async () => {
		const res = await postAction(app.baseUrl, 'updateAnnotation', {
			cookie,
			fields: { annotationId: '999999', note: 'Ghost note' }
		});
		assert.equal(res.status, 404);
	});

	test('editing with a non-numeric annotation id answers 400, not a crash', async () => {
		const res = await postAction(app.baseUrl, 'updateAnnotation', {
			cookie,
			fields: { annotationId: 'not-a-number', note: 'Whatever' }
		});
		assert.equal(res.status, 400);
	});

	test('deleting an annotation id that matches nothing answers 404, not a silent success', async () => {
		const res = await postAction(app.baseUrl, 'deleteAnnotation', {
			cookie,
			fields: { annotationId: '999999' }
		});
		assert.equal(res.status, 404);
	});

	test('deleting an annotation removes it (verified via the database)', async () => {
		const res = await postAction(app.baseUrl, 'deleteAnnotation', {
			cookie,
			fields: { annotationId: '101' }
		});
		assert.equal(res.status, 200, 'deleting an existing annotation must succeed');

		const remaining = withRawDb(dbPath, (raw) =>
			raw.prepare('SELECT COUNT(*) AS n FROM annotations WHERE id = ?').get(101).n
		);
		assert.equal(remaining, 0, 'the deleted annotation must be gone from the database');

		// The list page must no longer show the removed annotation.
		const listRes = await fetch(`${app.baseUrl}/annotations`, { redirect: 'manual', headers: { cookie } });
		const html = await listRes.text();
		assert.doesNotMatch(html, /Note about merging/, 'the deleted annotation must no longer be listed');
		assert.match(html, /Rewritten note about the pivot/, 'the surviving annotation must still be listed');
	});
});

describe('the /annotations page empty state and access guard (task 15.12)', () => {
	let app;
	let workDir;
	let dbPath;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-annotations-page-guard-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);
		// No cards, no annotations at all: the page must show its empty state.

		app = await startApp({
			APP_PASSWORD: TEST_PASSWORD,
			SESSION_SECRET: TEST_SESSION_SECRET,
			DATABASE_PATH: dbPath
		});
	});

	after(async () => {
		if (app) await app.stop();
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('GET /annotations with no annotations at all renders the empty state', async () => {
		const cookie = await login(app.baseUrl);
		const res = await fetch(`${app.baseUrl}/annotations`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /No annotations yet/, 'the empty state must render when there are no annotations');
	});

	test('an unauthenticated GET /annotations is redirected to /login with redirectTo, never rendered', async () => {
		const res = await fetch(`${app.baseUrl}/annotations`, { redirect: 'manual' });
		assert.equal(res.status, 303);
		assert.equal(res.headers.get('location'), '/login?redirectTo=' + encodeURIComponent('/annotations'));
	});

	test('an unauthenticated edit POST is redirected by the guard, never executed', async () => {
		const res = await postAction(app.baseUrl, 'updateAnnotation', {
			fields: { annotationId: '1', note: 'Should not run' }
		});
		assert.equal(res.status, 303);
		assert.equal(
			res.headers.get('location'),
			'/login?redirectTo=' + encodeURIComponent('/annotations?/updateAnnotation')
		);
	});

	test('an unauthenticated delete POST is redirected by the guard, never executed', async () => {
		const res = await postAction(app.baseUrl, 'deleteAnnotation', {
			fields: { annotationId: '1' }
		});
		assert.equal(res.status, 303);
		assert.equal(
			res.headers.get('location'),
			'/login?redirectTo=' + encodeURIComponent('/annotations?/deleteAnnotation')
		);
	});
});

test('the ROADMAP checks off task 15.12 (global annotations page)', () => {
	const roadmap = fs.readFileSync(path.join(ROOT, 'docs', 'ROADMAP.md'), 'utf8');
	const line = roadmap.split('\n').find((l) => /\*\*15\.12\*\*/.test(l));
	assert.ok(line, 'expected to find the "15.12" task line in docs/ROADMAP.md');
	assert.match(line, /^- \[x\]/i, 'task 15.12 must be checked off');
});
