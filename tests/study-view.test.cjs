// tests/study-view.test.cjs
//
// Verifies tasks 8.2, 8.3, 8.4 and 8.5 of docs/ROADMAP.md (section "8. Tirage
// et vue d'étude") at the HTTP level, against a real running instance of the
// app:
//   - 8.2 a GET of the study view draws a card but records NOTHING on its own
//     (the phantom-readings fix decouples drawing from recording): a bare
//     load/preload of / never writes a reading_history row. Recording is the
//     explicit /readings "card shown" signal, covered by
//     tests/study-reading-signal.test.cjs;
//   - 8.3 the study view renders the drawn card's title, theme, level, source
//     and body, and never injects unsanitized HTML from the card body (the
//     body is rendered to sanitized HTML by the roadmap section 7 pipeline in
//     $lib/server/markdown, so a hostile <script> is stripped rather than
//     surviving); it also shows an empty state (recording nothing) when there
//     is no eligible card;
//   - 8.4 the "next card" action is a POST-redirect-GET that draws a fresh
//     card; once the card just shown has been recorded through the /readings
//     signal, that card is excluded so it does not immediately repeat;
//   - 8.5 the "more"/"less of this theme" actions adjust the submitted
//     theme's weight up/down in themePreferences, validating the theme at
//     the HTTP boundary (a missing/empty theme is a real 400, not a silent
//     success);
//   - the access guard (task 3.3) protects both the view and its actions.
//
// Like tests/access-guard-and-logout.test.cjs, the app is started for real
// (Vite's dev server, driven programmatically) because this behavior spans
// hooks.server.ts, form actions and HTTP semantics (redirect codes, status
// codes) that cannot be observed by importing modules directly. The dev
// server is pointed at a throwaway copy of the project (node_modules brought
// in via a directory junction) instead of this repo checkout, and its SQLite
// file lives under a fresh temp directory, so this suite never touches the
// real project tree and is safe to run concurrently with the rest of
// `node --test tests/`. The server binds to a port freshly probed from the
// OS rather than a hardcoded one, so concurrent runs never collide.
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
const TEST_SESSION_SECRET = 'y'.repeat(32);
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
	const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-study-app-copy-'));
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
	const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-study-web-harness-'));
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

/**
 * Post a study-view form action. `Accept: text/html` mirrors a classic
 * (no-JS) form submission -- the mode in which SvelteKit answers with the
 * real HTTP status code for a fail() result, matching the existing
 * convention in tests/access-guard-and-logout.test.cjs.
 */
function postAction(baseUrl, action, { cookie, fields = {} } = {}) {
	const headers = { accept: 'text/html' };
	if (cookie) headers.cookie = cookie;
	return fetch(`${baseUrl}/?/${action}`, {
		method: 'POST',
		redirect: 'manual',
		headers,
		body: new URLSearchParams(fields)
	});
}

/**
 * Send the "card actually shown" signal the way the real page component does
 * from `afterNavigate` (see src/routes/+page.svelte): a JSON POST to the
 * dedicated /readings endpoint naming the drawn card. load() itself records
 * nothing (phantom-readings fix), so this is what drives the recency exclusion.
 */
function postReading(baseUrl, cardId, { cookie } = {}) {
	const headers = { 'content-type': 'application/json' };
	if (cookie) headers.cookie = cookie;
	return fetch(`${baseUrl}/readings`, {
		method: 'POST',
		redirect: 'manual',
		headers,
		body: JSON.stringify(cardId === undefined ? {} : { cardId })
	});
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

/** Extract the card title rendered by the study view's <h2 class="fiche__title">. */
function extractTitle(html) {
	// The class attribute may carry an extra Svelte scoping-hash token
	// (e.g. `class="fiche__title s-abc123"` in dev mode), so match on the
	// class name being present rather than the whole attribute value.
	const match = html.match(/<h2 class="[^"]*\bfiche__title\b[^"]*">([^<]*)<\/h2>/);
	return match ? match[1] : null;
}

describe('the study view draws, records and renders a card safely (tasks 8.2 & 8.3)', () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-study-view-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);

		withRawDb(dbPath, (raw) => {
			raw
				.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 1)')
				.run('Focused KB', 'https://example.test/focused.git', 'main');
			raw
				.prepare(
					'INSERT INTO cards (id, kb_id, slug, title, theme, level, source_path, content, active) VALUES (1, 1, ?, ?, ?, ?, ?, ?, 1)'
				)
				.run(
					'card-a',
					'Card A Title',
					'sql',
					'beginner',
					'sql/card-a.md',
					'Some body text with a <script>alert(1)</script> tag inside it.'
				);
			raw
				.prepare(
					'INSERT INTO cards (id, kb_id, slug, title, theme, level, source_path, content, active) VALUES (2, 1, ?, ?, ?, ?, ?, ?, 1)'
				)
				.run('card-b', 'Card B Title', 'network', 'advanced', 'network/card-b.md', 'Card B body.');
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

	test('GET / renders the drawn card\'s title, theme, level and source, and records nothing on its own', async () => {
		const res = await fetch(`${app.baseUrl}/`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		const title = extractTitle(html);
		assert.ok(['Card A Title', 'Card B Title'].includes(title), `unexpected title: ${title}`);
		if (title === 'Card A Title') {
			assert.match(html, /sql/);
			assert.match(html, /beginner/);
			assert.match(html, /sql\/card-a\.md/);
		} else {
			assert.match(html, /network/);
			assert.match(html, /advanced/);
			assert.match(html, /network\/card-b\.md/);
		}

		// The draw happens in load(), but recording is decoupled from it (the
		// phantom-readings fix): a bare GET/preload of / must never write a row.
		// Recording is the explicit /readings signal sent once the card is
		// mounted, covered by tests/study-reading-signal.test.cjs.
		const count = withRawDb(dbPath, (raw) => raw.prepare('SELECT COUNT(*) AS n FROM reading_history').get().n);
		assert.equal(count, 0, 'a mere load of / must not record a reading');
	});

	test('a card body containing HTML is rendered as sanitized HTML, never as raw unsanitized HTML', async () => {
		// Keep drawing until card A (the one with the <script> body) comes up;
		// the "next" action (task 8.4) is exactly the mechanism the real view
		// uses to do this, so this also doubly-exercises task 8.4.
		let html = await (await fetch(`${app.baseUrl}/`, { redirect: 'manual', headers: { cookie } })).text();
		for (let i = 0; i < 10 && !html.includes('Card A Title'); i += 1) {
			await postAction(app.baseUrl, 'next', { cookie });
			html = await (await fetch(`${app.baseUrl}/`, { redirect: 'manual', headers: { cookie } })).text();
		}
		assert.ok(html.includes('Card A Title'), 'expected card A to come up within a handful of "next" draws');
		// Roadmap section 7 renders the markdown body to sanitized HTML through
		// $lib/server/markdown before it reaches the view. The hostile <script>
		// must therefore be stripped by DOMPurify: neither the raw tag nor its
		// payload may survive, and the surrounding body text is still shown.
		assert.doesNotMatch(html, /<script>alert\(1\)/, 'a raw <script> tag must never survive rendering');
		assert.doesNotMatch(html, /alert\(1\)/, 'the hostile script payload must be sanitized away');
		assert.match(html, /Some body text with a/, 'the surrounding card body text must still be rendered');
	});
});

describe('the "next card" action excludes the card just shown (task 8.4)', () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-study-next-'));
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

	test('next redraws to a real 303 redirect, and the following GET always shows the other card (never an immediate repeat)', async () => {
		const firstHtml = await (await fetch(`${app.baseUrl}/`, { redirect: 'manual', headers: { cookie } })).text();
		const firstTitle = extractTitle(firstHtml);
		assert.ok(TITLE_TO_ID[firstTitle], `unexpected title: ${firstTitle}`);

		// The real client records the card as shown via the /readings signal once
		// it is mounted; load() itself records nothing (phantom-readings fix), so
		// we send the same signal here to drive the recency exclusion below.
		assert.equal((await postReading(app.baseUrl, TITLE_TO_ID[firstTitle], { cookie })).status, 204);

		const nextRes = await postAction(app.baseUrl, 'next', { cookie });
		assert.equal(nextRes.status, 303);
		assert.equal(nextRes.headers.get('location'), '/');

		// The "next" POST-redirect-GET draws but records nothing on its own: only
		// the explicit /readings signal above added a row.
		const countAfterNext = withRawDb(dbPath, (raw) => raw.prepare('SELECT COUNT(*) AS n FROM reading_history').get().n);
		assert.equal(countAfterNext, 1);

		const secondHtml = await (await fetch(`${app.baseUrl}/`, { redirect: 'manual', headers: { cookie } })).text();
		const secondTitle = extractTitle(secondHtml);
		assert.notEqual(secondTitle, firstTitle, 'the pool has only 2 cards, so "next" must never repeat the one just shown');

		// The second draw is a bare load too: it must not record a reading on its own.
		const countAfterSecondGet = withRawDb(dbPath, (raw) => raw.prepare('SELECT COUNT(*) AS n FROM reading_history').get().n);
		assert.equal(countAfterSecondGet, 1, 'the second draw must not record a reading on its own');
	});
});

describe('"more"/"less of this theme" adjust the theme weight, validated at the boundary (task 8.5)', () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-study-weight-actions-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);

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

	function currentWeight(theme) {
		return withRawDb(dbPath, (raw) => {
			const row = raw.prepare('SELECT weight FROM theme_preferences WHERE theme = ?').get(theme);
			return row ? row.weight : null;
		});
	}

	test('"more" with an empty theme answers a real 400, not a silent success', async () => {
		const res = await postAction(app.baseUrl, 'more', { cookie, fields: { theme: '' } });
		assert.equal(res.status, 400);
	});

	test('"more" with a missing theme field answers a real 400, not a silent success', async () => {
		const res = await postAction(app.baseUrl, 'more', { cookie, fields: {} });
		assert.equal(res.status, 400);
	});

	test('"more" with a valid theme redirects (303 to /) and increases that theme\'s weight', async () => {
		assert.equal(currentWeight('sql'), null, 'sanity check: no preference row yet for this theme');
		const res = await postAction(app.baseUrl, 'more', { cookie, fields: { theme: 'sql' } });
		assert.equal(res.status, 303);
		assert.equal(res.headers.get('location'), '/');
		const afterMore = currentWeight('sql');
		assert.ok(afterMore > 0, 'weight must be a real positive number after the row is created');
	});

	test('"less" with the same theme redirects (303 to /) and decreases that theme\'s weight below the previous value', async () => {
		const beforeLess = currentWeight('sql');
		const res = await postAction(app.baseUrl, 'less', { cookie, fields: { theme: 'sql' } });
		assert.equal(res.status, 303);
		assert.equal(res.headers.get('location'), '/');
		const afterLess = currentWeight('sql');
		assert.ok(afterLess < beforeLess, `expected the weight to decrease (was ${beforeLess}, now ${afterLess})`);
		assert.ok(afterLess > 0, 'the weight must never drop to zero or below');
	});

	test('"less" with an empty theme answers a real 400, not a silent success', async () => {
		const res = await postAction(app.baseUrl, 'less', { cookie, fields: { theme: '' } });
		assert.equal(res.status, 400);
	});
});

describe('the access guard protects the study view and its actions', () => {
	let app;
	let workDir;
	let dbPath;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-study-guard-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);
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

	test('an unauthenticated GET / is redirected to /login (no redirectTo needed for the app home)', async () => {
		const res = await fetch(`${app.baseUrl}/`, { redirect: 'manual' });
		assert.equal(res.status, 303);
		assert.equal(res.headers.get('location'), '/login');
	});

	test('an unauthenticated "next" action is redirected by the guard, never executed', async () => {
		const res = await postAction(app.baseUrl, 'next');
		assert.equal(res.status, 303);
		assert.equal(res.headers.get('location'), '/login?redirectTo=' + encodeURIComponent('/?/next'));

		const count = withRawDb(dbPath, (raw) => raw.prepare('SELECT COUNT(*) AS n FROM reading_history').get().n);
		assert.equal(count, 0, 'an unauthenticated "next" must never record a reading');
	});

	test('an unauthenticated "more" action is redirected by the guard, never executed', async () => {
		const res = await postAction(app.baseUrl, 'more', { fields: { theme: 'sql' } });
		assert.equal(res.status, 303);
		assert.equal(res.headers.get('location'), '/login?redirectTo=' + encodeURIComponent('/?/more'));

		const row = withRawDb(dbPath, (raw) => raw.prepare('SELECT weight FROM theme_preferences WHERE theme = ?').get('sql'));
		assert.equal(row, undefined, 'an unauthenticated "more" must never adjust a theme weight');
	});
});

describe('no eligible card shows the empty state and records nothing (tasks 8.1 & 8.3)', () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-study-empty-view-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);
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

	test('GET / shows the "no card" empty state and records no reading when nothing is eligible', async () => {
		const res = await fetch(`${app.baseUrl}/`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /No card to study/);

		const count = withRawDb(dbPath, (raw) => raw.prepare('SELECT COUNT(*) AS n FROM reading_history').get().n);
		assert.equal(count, 0);
	});
});
