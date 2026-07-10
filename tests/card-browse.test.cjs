// tests/card-browse.test.cjs
//
// Verifies roadmap task 11 ("Recherche, liste et navigation dans les fiches")
// at the HTTP level, against a real running instance of the app:
//   - 11.1: /browse lists only active cards belonging to a knowledge base
//     currently in focus (the same perimeter as the study view,
//     src/lib/server/study.ts), showing each card's title, theme and source,
//     and shows an explicit empty state when no card is eligible;
//   - 11.2: a keyword search (`q`) narrows the list, matching the card's
//     title, theme OR content;
//   - 11.3: `kb`, `theme` and `level` filters combine with each other and with
//     the keyword search, and the offered filter values are dropped at the
//     server boundary when they do not name something in the perimeter;
//   - 11.4: each result links to the existing single-card consultation page
//     (/cards/<id>), and the search + filters are round-tripped through the
//     URL query string so re-requesting the same URL (what the browser back
//     button / a shared link does) reproduces the same search and filtering,
//     both in the returned list and in the pre-filled form controls.
//
// Like tests/card-consultation.test.cjs, the app is started for real (Vite's
// dev server, driven programmatically) because this spans routing, load()
// functions and HTTP-level validation that cannot be observed by importing
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
// here -- this harness is intentionally identical to the other suites in this
// project (there is no shared test-helper module; each file is self-contained).
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
	const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-browse-app-copy-'));
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
	const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-browse-web-harness-'));
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

/** Every card title rendered as a list item (`<h2 class="card-item__title">`). */
function extractListedTitles(html) {
	const titles = [];
	const re = /<h2 class="[^"]*\bcard-item__title\b[^"]*">\s*<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g;
	let match;
	while ((match = re.exec(html))) {
		titles.push({ href: match[1], title: match[2] });
	}
	return titles;
}

/** The value currently selected in a `<select id="...">`, or null if only the default is picked. */
function selectedOptionValue(html, selectId) {
	const block = html.match(new RegExp(`<select id="${selectId}"[^>]*>([\\s\\S]*?)</select>`));
	assert.ok(block, `expected a <select id="${selectId}"> in the page`);
	const optionRe = /<option value="([^"]*)"[^>]*>/g;
	let match;
	while ((match = optionRe.exec(block[1]))) {
		if (/\bselected\b/.test(match[0])) return match[1];
	}
	return null;
}

/** The `value="..."` currently rendered on a text/search `<input id="...">`. */
function inputValue(html, inputId) {
	const match = html.match(new RegExp(`<input id="${inputId}"[^>]*value="([^"]*)"`));
	return match ? match[1] : null;
}

async function seedPerimeter(dbPath) {
	withRawDb(dbPath, (raw) => {
		// KB A is in focus: its active cards are the eligible perimeter.
		raw
			.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 1)')
			.run('KB Focused', 'https://example.test/focused.git', 'main');
		// KB B is NOT in focus: none of its cards must ever surface here.
		raw
			.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (2, ?, ?, ?, 0)')
			.run('KB Unfocused', 'https://example.test/unfocused.git', 'main');

		const insertCard = raw.prepare(
			`INSERT INTO cards (id, kb_id, slug, title, theme, level, source_path, content, active)
			 VALUES (@id, @kbId, @slug, @title, @theme, @level, @sourcePath, @content, @active)`
		);

		insertCard.run({
			id: 1,
			kbId: 1,
			slug: 'sql-basics',
			title: 'Great SQL Basics',
			theme: 'sql',
			level: 'beginner',
			sourcePath: 'sql/basics.md',
			content: 'Learn about JOIN and SELECT statements.',
			active: 1
		});
		insertCard.run({
			id: 2,
			kbId: 1,
			slug: 'networking-fundamentals',
			title: 'Networking Fundamentals',
			theme: 'network',
			level: 'advanced',
			sourcePath: 'network/fundamentals.md',
			content: 'Covers the TCP handshake in detail.',
			active: 1
		});
		// Inactive (soft-deleted): same KB, must be excluded from the perimeter.
		insertCard.run({
			id: 3,
			kbId: 1,
			slug: 'old-deprecated-card',
			title: 'Old Deprecated Card',
			theme: 'sql',
			level: 'beginner',
			sourcePath: 'sql/old.md',
			content: 'deprecated content',
			active: 0
		});
		// Active, but its KB is not in focus: must also be excluded.
		insertCard.run({
			id: 4,
			kbId: 2,
			slug: 'hidden-kb-card',
			title: 'Hidden KB Card',
			theme: 'python',
			level: 'beginner',
			sourcePath: 'python/hidden.md',
			content: 'python content',
			active: 1
		});
	});
}

describe('cards index at /browse: perimeter, search, filters and navigation (roadmap 11)', () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-browse-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);
		await seedPerimeter(dbPath);

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

	test('an unauthenticated request to /browse is redirected by the access guard (task 3.3 covers new routes)', async () => {
		const res = await fetch(`${app.baseUrl}/browse`, { redirect: 'manual' });
		assert.equal(res.status, 303);
		assert.match(res.headers.get('location'), /^\/login/);
	});

	test('11.1: GET /browse lists only active cards of focused KBs, with title, theme and source', async () => {
		const res = await fetch(`${app.baseUrl}/browse`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		const titles = extractListedTitles(html).map((t) => t.title);

		assert.deepEqual(
			titles.sort(),
			['Great SQL Basics', 'Networking Fundamentals'].sort(),
			'only the active cards of the focused KB must be listed'
		);
		assert.doesNotMatch(html, /Old Deprecated Card/, 'an inactive card must never appear in the list');
		assert.doesNotMatch(html, /Hidden KB Card/, 'a card whose KB is not in focus must never appear in the list');

		// Theme and source are shown per card.
		assert.match(html, /sql/);
		assert.match(html, /sql\/basics\.md/);
		assert.match(html, /network/);
		assert.match(html, /network\/fundamentals\.md/);
	});

	test('11.4: each listed card links to the existing single-card consultation page', async () => {
		const res = await fetch(`${app.baseUrl}/browse`, { redirect: 'manual', headers: { cookie } });
		const html = await res.text();
		const byTitle = Object.fromEntries(extractListedTitles(html).map((t) => [t.title, t.href]));

		assert.equal(byTitle['Great SQL Basics'], '/cards/1');
		assert.equal(byTitle['Networking Fundamentals'], '/cards/2');
	});

	test('11.2: keyword search matches the title', async () => {
		const res = await fetch(`${app.baseUrl}/browse?${new URLSearchParams({ q: 'SQL Basics' })}`, {
			redirect: 'manual',
			headers: { cookie }
		});
		assert.equal(res.status, 200);
		const html = await res.text();
		const titles = extractListedTitles(html).map((t) => t.title);
		assert.deepEqual(titles, ['Great SQL Basics']);
	});

	test('11.2: keyword search matches the theme', async () => {
		const res = await fetch(`${app.baseUrl}/browse?${new URLSearchParams({ q: 'network' })}`, {
			redirect: 'manual',
			headers: { cookie }
		});
		const html = await res.text();
		const titles = extractListedTitles(html).map((t) => t.title);
		assert.deepEqual(titles, ['Networking Fundamentals']);
	});

	test('11.2: keyword search matches the content even when title and theme do not', async () => {
		const res = await fetch(`${app.baseUrl}/browse?${new URLSearchParams({ q: 'handshake' })}`, {
			redirect: 'manual',
			headers: { cookie }
		});
		const html = await res.text();
		const titles = extractListedTitles(html).map((t) => t.title);
		assert.deepEqual(titles, ['Networking Fundamentals']);
	});

	test('11.2: a keyword search matching nothing in the perimeter shows the "no match" empty state, not an error', async () => {
		const res = await fetch(`${app.baseUrl}/browse?${new URLSearchParams({ q: 'nonexistent-xyz' })}`, {
			redirect: 'manual',
			headers: { cookie }
		});
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.deepEqual(extractListedTitles(html), []);
		assert.match(html, /No cards match/);
	});

	test('11.3: theme + level filters combine and exclude a same-theme/level card outside the perimeter (inactive)', async () => {
		const res = await fetch(`${app.baseUrl}/browse?${new URLSearchParams({ theme: 'sql', level: 'beginner' })}`, {
			redirect: 'manual',
			headers: { cookie }
		});
		const html = await res.text();
		const titles = extractListedTitles(html).map((t) => t.title);
		// "Old Deprecated Card" shares theme=sql/level=beginner but is inactive.
		assert.deepEqual(titles, ['Great SQL Basics']);
	});

	test('11.3: KB filter combines with the keyword search', async () => {
		const res = await fetch(`${app.baseUrl}/browse?${new URLSearchParams({ kb: '1', q: 'network' })}`, {
			redirect: 'manual',
			headers: { cookie }
		});
		const html = await res.text();
		const titles = extractListedTitles(html).map((t) => t.title);
		assert.deepEqual(titles, ['Networking Fundamentals']);
	});

	test('11.3: a filter combination matching nothing shows the empty state', async () => {
		const res = await fetch(`${app.baseUrl}/browse?${new URLSearchParams({ theme: 'sql', level: 'advanced' })}`, {
			redirect: 'manual',
			headers: { cookie }
		});
		const html = await res.text();
		assert.deepEqual(extractListedTitles(html), []);
		assert.match(html, /No cards match/);
	});

	test('11.3: the offered filter values reflect only the in-scope data (unfocused KB and its theme are absent)', async () => {
		const res = await fetch(`${app.baseUrl}/browse`, { redirect: 'manual', headers: { cookie } });
		const html = await res.text();

		assert.match(html, /KB Focused/);
		assert.doesNotMatch(html, /KB Unfocused/, 'a KB not in focus must not be offered as a filter option');
		assert.doesNotMatch(html, />python</, 'a theme only present outside the perimeter must not be offered');
	});

	test('11.3: an out-of-scope or malformed filter value is dropped at the server boundary instead of erroring', async () => {
		const res = await fetch(
			`${app.baseUrl}/browse?${new URLSearchParams({ kb: 'not-a-number', theme: 'does-not-exist', level: 'also-bogus' })}`,
			{ redirect: 'manual', headers: { cookie } }
		);
		assert.equal(res.status, 200, 'a malformed filter value must never crash the request');
		const html = await res.text();
		const titles = extractListedTitles(html).map((t) => t.title).sort();
		// Since every candidate filter was invalid, the full in-scope perimeter is shown untouched.
		assert.deepEqual(titles, ['Great SQL Basics', 'Networking Fundamentals'].sort());
	});

	test('11.3: an out-of-scope KB id (belongs to the unfocused KB) is dropped, not applied', async () => {
		const res = await fetch(`${app.baseUrl}/browse?${new URLSearchParams({ kb: '2' })}`, {
			redirect: 'manual',
			headers: { cookie }
		});
		assert.equal(res.status, 200);
		const html = await res.text();
		const titles = extractListedTitles(html).map((t) => t.title).sort();
		assert.deepEqual(titles, ['Great SQL Basics', 'Networking Fundamentals'].sort());
	});

	test('11.4: the search box and filter selects reflect the query params on the resulting page (URL round-trip)', async () => {
		const query = new URLSearchParams({ q: 'SQL', kb: '1', theme: 'sql', level: 'beginner' });
		const res = await fetch(`${app.baseUrl}/browse?${query}`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();

		assert.equal(inputValue(html, 'cards-q'), 'SQL');
		assert.equal(selectedOptionValue(html, 'cards-kb'), '1');
		assert.equal(selectedOptionValue(html, 'cards-theme'), 'sql');
		assert.equal(selectedOptionValue(html, 'cards-level'), 'beginner');
	});

	test('11.4: re-requesting a bare /browse (as after a full reset) shows no filter pre-selected', async () => {
		const res = await fetch(`${app.baseUrl}/browse`, { redirect: 'manual', headers: { cookie } });
		const html = await res.text();

		assert.equal(inputValue(html, 'cards-q'), '');
		assert.equal(selectedOptionValue(html, 'cards-kb'), null);
		assert.equal(selectedOptionValue(html, 'cards-theme'), null);
		assert.equal(selectedOptionValue(html, 'cards-level'), null);
	});
});

describe('cards index at /browse: empty perimeter (task 11.1)', () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-browse-empty-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);

		withRawDb(dbPath, (raw) => {
			// A KB with an active card, but NOT in focus: the perimeter is empty.
			raw
				.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 0)')
				.run('KB Unfocused', 'https://example.test/unfocused.git', 'main');
			raw
				.prepare(
					'INSERT INTO cards (id, kb_id, slug, title, active) VALUES (1, 1, ?, ?, 1)'
				)
				.run('lonely-card', 'Lonely Card');
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

	test('GET /browse shows the "no cards available" empty state, not an error, when no card is eligible', async () => {
		const res = await fetch(`${app.baseUrl}/browse`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /No cards available/);
		assert.doesNotMatch(html, /Lonely Card/, 'a card outside the perimeter must never be listed');
	});
});
