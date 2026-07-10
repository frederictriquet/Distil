// tests/study-reading-signal.test.cjs
//
// Verifies the "phantom readings" fix (roadmap 8.2) at the HTTP level, against
// a real running instance of the app:
//   - a GET of `/` — the exact request SvelteKit's `load` answers for a
//     hover/tap preload, a back/forward navigation, or a refresh, since none
//     of those mount the page component — draws a card but records NO
//     reading, however many times it is repeated;
//   - the dedicated `POST /readings` endpoint (the explicit "a card was
//     really shown" signal the page component sends from `afterNavigate`,
//     which only fires once the component is actually mounted) records
//     exactly one reading for the card it names;
//   - the recency exclusion (task 8.1) still works when readings are recorded
//     this way: a card just recorded via `/readings` is excluded from the
//     very next draw;
//   - `/readings` validates the id at the boundary (missing/non-integer/
//     non-positive -> 400, unknown card -> 404) and sits behind the same
//     access guard as the rest of the study view, per CLAUDE.md.
//
// Like tests/study-view.test.cjs, the app is started for real (Vite's dev
// server, driven programmatically) because this behavior spans hooks.server.ts
// and real HTTP status/redirect semantics that cannot be observed by importing
// modules directly. The dev server is pointed at a throwaway copy of the
// project (node_modules brought in via a directory junction) instead of this
// repo checkout, and its SQLite file lives under a fresh temp directory, so
// this suite never touches the real project tree and is safe to run
// concurrently with the rest of `node --test tests/`. The server binds to a
// port freshly probed from the OS rather than a hardcoded one, so concurrent
// runs never collide.
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
	const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-reading-signal-app-copy-'));
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
	const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-reading-signal-web-harness-'));
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

/** The `distil_session` Set-Cookie header from a login response. */
function extractSessionCookie(response) {
	const cookie = setCookies(response).find((c) => c.startsWith('distil_session='));
	assert.ok(cookie, 'expected a distil_session Set-Cookie header in the response');
	return cookie;
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
	return cookiePair(extractSessionCookie(res));
}

/** Extract the card title rendered by the study view's <h2 class="fiche__title">. */
function extractTitle(html) {
	const match = html.match(/<h2 class="[^"]*\bfiche__title\b[^"]*">([^<]*)<\/h2>/);
	return match ? match[1] : null;
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

function readingCount(dbPath) {
	return withRawDb(dbPath, (raw) => raw.prepare('SELECT COUNT(*) AS n FROM reading_history').get().n);
}

/**
 * Record the "card actually shown" signal the way the real page component
 * does from `afterNavigate` (see src/routes/+page.svelte): a JSON POST to the
 * dedicated endpoint naming the card that was drawn and rendered.
 */
function postReading(baseUrl, cardId, { cookie } = {}) {
	const headers = { 'content-type': 'application/json' };
	if (cookie) headers.cookie = cookie;
	// `cardId === undefined` still sends a well-formed JSON object (just
	// without the field), so a 400 in that case is specifically the "missing
	// cardId" validation branch rather than a JSON-parse failure.
	const body = JSON.stringify(cardId === undefined ? {} : { cardId });
	return fetch(`${baseUrl}/readings`, { method: 'POST', redirect: 'manual', headers, body });
}

describe('a GET of / never records a reading, however many times it is repeated (fix for phantom readings)', () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-reading-signal-load-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);

		withRawDb(dbPath, (raw) => {
			raw
				.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 1)')
				.run('Focused KB', 'https://example.test/focused.git', 'main');
			raw
				.prepare('INSERT INTO cards (id, kb_id, slug, title, theme, active) VALUES (1, 1, ?, ?, ?, 1)')
				.run('card-a', 'Card A Title', 'sql');
			raw
				.prepare('INSERT INTO cards (id, kb_id, slug, title, theme, active) VALUES (2, 1, ?, ?, ?, 1)')
				.run('card-b', 'Card B Title', 'network');
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

	test('repeated GET / draws a card each time but records nothing in reading_history', async () => {
		// GET / is exactly the request SvelteKit issues for a hover/tap preload,
		// a back/forward navigation, or a refresh: none of those mount the page
		// component, so they must never trigger a recording. Every one of these
		// still draws and renders a real card (task 8.1/8.3 must keep working).
		for (let i = 0; i < 5; i += 1) {
			const res = await fetch(`${app.baseUrl}/`, { redirect: 'manual', headers: { cookie } });
			assert.equal(res.status, 200);
			const html = await res.text();
			const title = extractTitle(html);
			assert.ok(['Card A Title', 'Card B Title'].includes(title), `unexpected title: ${title}`);
		}

		assert.equal(readingCount(dbPath), 0, 'a mere load/preload of / must never record a reading');
	});
});

describe('the dedicated /readings signal records exactly one reading for the card actually shown', () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-reading-signal-record-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);

		withRawDb(dbPath, (raw) => {
			raw
				.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 1)')
				.run('Focused KB', 'https://example.test/focused.git', 'main');
			// A single eligible card makes the id the /readings signal must name
			// (data.card.id in the real client) known ahead of time.
			raw
				.prepare('INSERT INTO cards (id, kb_id, slug, title, theme, active) VALUES (1, 1, ?, ?, ?, 1)')
				.run('card-a', 'Card A Title', 'sql');
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

	test('GET / (draw only) followed by POST /readings (the "shown" signal) records exactly one reading for that card', async () => {
		const getRes = await fetch(`${app.baseUrl}/`, { redirect: 'manual', headers: { cookie } });
		assert.equal(getRes.status, 200);
		assert.equal(extractTitle(await getRes.text()), 'Card A Title');
		assert.equal(readingCount(dbPath), 0, 'the load itself must not have recorded anything yet');

		const postRes = await postReading(app.baseUrl, 1, { cookie });
		assert.equal(postRes.status, 204);

		assert.equal(readingCount(dbPath), 1, 'exactly one reading must be recorded once the card is actually shown');
		const row = withRawDb(dbPath, (raw) => raw.prepare('SELECT card_id AS cardId FROM reading_history').get());
		assert.equal(row.cardId, 1);
	});

	test('/readings rejects a missing cardId with a real 400, and records nothing', async () => {
		const before = readingCount(dbPath);
		const res = await postReading(app.baseUrl, undefined, { cookie });
		assert.equal(res.status, 400);
		assert.equal(readingCount(dbPath), before, 'a rejected signal must not add a reading');
	});

	test('/readings rejects a non-positive-integer cardId with a real 400, and records nothing', async () => {
		const before = readingCount(dbPath);
		for (const bad of [0, -1, 1.5, 'not-a-number']) {
			const res = await postReading(app.baseUrl, bad, { cookie });
			assert.equal(res.status, 400, `expected 400 for cardId=${JSON.stringify(bad)}`);
		}
		assert.equal(readingCount(dbPath), before, 'a rejected signal must not add a reading');
	});

	test('/readings answers a real 404 for a card id that does not exist, and records nothing', async () => {
		const before = readingCount(dbPath);
		const res = await postReading(app.baseUrl, 999999, { cookie });
		assert.equal(res.status, 404);
		assert.equal(readingCount(dbPath), before, 'a rejected signal must not add a reading');
	});

	test('an unauthenticated POST /readings is redirected by the access guard, never executed', async () => {
		const before = readingCount(dbPath);
		const res = await postReading(app.baseUrl, 1);
		assert.equal(res.status, 303);
		assert.equal(res.headers.get('location'), '/login?redirectTo=' + encodeURIComponent('/readings'));
		assert.equal(readingCount(dbPath), before, 'an unauthenticated signal must never record a reading');
	});
});

describe('the recency exclusion (task 8.1) keeps working on readings recorded through the /readings signal', () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-reading-signal-recency-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);

		withRawDb(dbPath, (raw) => {
			raw
				.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 1)')
				.run('Focused KB', 'https://example.test/focused.git', 'main');
			raw
				.prepare('INSERT INTO cards (id, kb_id, slug, title, theme, active) VALUES (1, 1, ?, ?, ?, 1)')
				.run('card-a', 'Card A Title', 'sql');
			raw
				.prepare('INSERT INTO cards (id, kb_id, slug, title, theme, active) VALUES (2, 1, ?, ?, ?, 1)')
				.run('card-b', 'Card B Title', 'network');
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

	const TITLE_TO_ID = { 'Card A Title': 1, 'Card B Title': 2 };

	test('a card recorded via /readings is excluded from the very next draw', async () => {
		const firstHtml = await (await fetch(`${app.baseUrl}/`, { redirect: 'manual', headers: { cookie } })).text();
		const firstTitle = extractTitle(firstHtml);
		assert.ok(TITLE_TO_ID[firstTitle], `unexpected title: ${firstTitle}`);

		// This is the real "shown" signal the client sends once that card is
		// actually mounted -- not the load() call, which never records.
		const postRes = await postReading(app.baseUrl, TITLE_TO_ID[firstTitle], { cookie });
		assert.equal(postRes.status, 204);
		assert.equal(readingCount(dbPath), 1);

		const secondHtml = await (await fetch(`${app.baseUrl}/`, { redirect: 'manual', headers: { cookie } })).text();
		const secondTitle = extractTitle(secondHtml);
		assert.notEqual(
			secondTitle,
			firstTitle,
			'the pool has only 2 cards, so the card just recorded as shown must not be drawn again immediately'
		);

		// The second (unrecorded) draw must still not have added a row on its own.
		assert.equal(readingCount(dbPath), 1);
	});
});
