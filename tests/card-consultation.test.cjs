// tests/card-consultation.test.cjs
//
// Verifies roadmap task 10.1 ("Créer la page affichant une fiche identifiée")
// at the HTTP level, against a real running instance of the app:
//   - a card is addressable by its numeric id at /cards/<id> (the target of
//     bookmark navigation, task 9.3) and renders the same metadata (title,
//     theme, level, source) and sanitized Markdown body the study view shows
//     (sections 7 and 8);
//   - a card is also addressable by its knowledge base + slug at
//     /card/<kbId>/<slug> (the target of internal card links, task 7.2),
//     including a slug containing slashes (the `[...slug]` rest param);
//   - an inactive (soft-deleted) card is still viewable through both routes,
//     so a bookmark or internal link to a deactivated card keeps resolving;
//   - an unknown id, an unknown kb+slug pair, or a structurally invalid
//     identifier (non-numeric/non-positive id, invalid kbId, empty slug)
//     answers a real 404, not a crash or a silent empty page;
//   - the access guard (task 3.3) protects both routes.
//
// Like tests/study-view.test.cjs, the app is started for real (Vite's dev
// server, driven programmatically) because this behavior spans routing,
// load() functions and HTTP semantics (404s, redirects) that cannot be
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
	const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-card-app-copy-'));
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
	const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-card-web-harness-'));
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

/** Extract the card title rendered by `<h2 class="fiche__title">`. */
function extractTitle(html) {
	// The class attribute may carry an extra Svelte scoping-hash token
	// (e.g. `class="fiche__title s-abc123"` in dev mode), so match on the
	// class name being present rather than the whole attribute value.
	const match = html.match(/<h2 class="[^"]*\bfiche__title\b[^"]*">([^<]*)<\/h2>/);
	return match ? match[1] : null;
}

describe('a card is addressable by numeric id at /cards/<id> (task 10.1, bookmark navigation)', () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-card-by-id-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);

		withRawDb(dbPath, (raw) => {
			raw
				.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 0)')
				.run('KB One', 'https://example.test/one.git', 'main');
			raw
				.prepare(
					'INSERT INTO cards (id, kb_id, slug, title, theme, level, source_path, content, active) VALUES (10, 1, ?, ?, ?, ?, ?, ?, 1)'
				)
				.run(
					'active-card',
					'Active Card Title',
					'sql',
					'beginner',
					'sql/active-card.md',
					'Body with a <script>alert(1)</script> tag.'
				);
			raw
				.prepare(
					'INSERT INTO cards (id, kb_id, slug, title, theme, level, source_path, content, active) VALUES (11, 1, ?, ?, ?, ?, ?, ?, 0)'
				)
				.run('inactive-card', 'Inactive Card Title', 'network', 'advanced', 'network/inactive.md', 'Still here.');
			raw
				.prepare(
					'INSERT INTO cards (id, kb_id, slug, title, active) VALUES (12, 1, ?, ?, 1)'
				)
				.run('empty-card', 'Empty Card Title');
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

	test('GET /cards/<id> for an existing card renders its title, theme, level, source and sanitized body', async () => {
		const res = await fetch(`${app.baseUrl}/cards/10`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.equal(extractTitle(html), 'Active Card Title');
		assert.match(html, /sql/);
		assert.match(html, /beginner/);
		assert.match(html, /sql\/active-card\.md/);
		// Roadmap section 7's sanitized-HTML pipeline must still apply here.
		assert.doesNotMatch(html, /<script>alert\(1\)/, 'a raw <script> tag must never survive rendering');
		assert.doesNotMatch(html, /alert\(1\)/, 'the hostile script payload must be sanitized away');
		assert.match(html, /Body with a/, 'the surrounding card body text must still be rendered');
	});

	test('GET /cards/<id> for an inactive (soft-deleted) card still renders it (bookmarks must keep resolving)', async () => {
		const res = await fetch(`${app.baseUrl}/cards/11`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.equal(extractTitle(html), 'Inactive Card Title');
	});

	test('GET /cards/<id> for a card with no content shows the empty-body state', async () => {
		const res = await fetch(`${app.baseUrl}/cards/12`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.equal(extractTitle(html), 'Empty Card Title');
		assert.match(html, /This card has no content yet\./);
	});

	test('GET /cards/<id> for an id matching no card answers 404', async () => {
		const res = await fetch(`${app.baseUrl}/cards/999999`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 404);
	});

	for (const badId of ['abc', '0', '-1', '1.5', '1e3', '']) {
		test(`GET /cards/${JSON.stringify(badId)} (structurally invalid id) answers 404, not a crash`, async () => {
			const res = await fetch(`${app.baseUrl}/cards/${encodeURIComponent(badId)}`, {
				redirect: 'manual',
				headers: { cookie }
			});
			assert.equal(res.status, 404);
		});
	}
});

describe('a card is addressable by kb+slug at /card/<kbId>/<slug> (task 10.1, internal links)', () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-card-by-slug-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);

		withRawDb(dbPath, (raw) => {
			raw
				.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (2, ?, ?, ?, 0)')
				.run('KB Two', 'https://example.test/two.git', 'main');
			raw
				.prepare(
					'INSERT INTO cards (id, kb_id, slug, title, theme, level, source_path, content, active) VALUES (20, 2, ?, ?, ?, ?, ?, ?, 1)'
				)
				.run(
					'topics/intro',
					'Intro Topic Title',
					'network',
					'beginner',
					'topics/intro.md',
					'Slug with a slash body.'
				);
			raw
				.prepare(
					'INSERT INTO cards (id, kb_id, slug, title, active) VALUES (21, 2, ?, ?, 0)'
				)
				.run('deactivated', 'Deactivated Card Title');
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

	test('GET /card/<kbId>/<slug> for an existing card renders its title, theme, level and source', async () => {
		const res = await fetch(`${app.baseUrl}/card/2/topics/intro`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.equal(extractTitle(html), 'Intro Topic Title');
		assert.match(html, /network/);
		assert.match(html, /beginner/);
		assert.match(html, /topics\/intro\.md/);
		assert.match(html, /Slug with a slash body\./);
	});

	test('GET /card/<kbId>/<slug> for a deactivated card still renders it (internal links must keep resolving)', async () => {
		const res = await fetch(`${app.baseUrl}/card/2/deactivated`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.equal(extractTitle(html), 'Deactivated Card Title');
	});

	test('GET /card/<kbId>/<slug> for a slug matching no card in that kb answers 404', async () => {
		const res = await fetch(`${app.baseUrl}/card/2/does-not-exist`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 404);
	});

	test('GET /card/<kbId>/<slug> for the right slug but the wrong kb answers 404', async () => {
		const res = await fetch(`${app.baseUrl}/card/999/topics/intro`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 404);
	});

	test('GET /card/<kbId>/<slug> with a non-numeric kbId answers 404, not a crash', async () => {
		const res = await fetch(`${app.baseUrl}/card/abc/topics/intro`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 404);
	});

	test('GET /card/<kbId> with an empty slug answers 404', async () => {
		const res = await fetch(`${app.baseUrl}/card/2`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 404);
	});
});

describe('the access guard protects both card consultation routes', () => {
	let app;
	let workDir;
	let dbPath;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-card-guard-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);

		withRawDb(dbPath, (raw) => {
			raw
				.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 0)')
				.run('KB One', 'https://example.test/one.git', 'main');
			raw
				.prepare('INSERT INTO cards (id, kb_id, slug, title, active) VALUES (10, 1, ?, ?, 1)')
				.run('active-card', 'Active Card Title');
		});

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

	test('an unauthenticated GET /cards/<id> is redirected to /login with redirectTo, never rendered', async () => {
		const res = await fetch(`${app.baseUrl}/cards/10`, { redirect: 'manual' });
		assert.equal(res.status, 303);
		assert.equal(res.headers.get('location'), '/login?redirectTo=' + encodeURIComponent('/cards/10'));
	});

	test('an unauthenticated GET /card/<kbId>/<slug> is redirected to /login with redirectTo, never rendered', async () => {
		const res = await fetch(`${app.baseUrl}/card/1/active-card`, { redirect: 'manual' });
		assert.equal(res.status, 303);
		assert.equal(res.headers.get('location'), '/login?redirectTo=' + encodeURIComponent('/card/1/active-card'));
	});
});
