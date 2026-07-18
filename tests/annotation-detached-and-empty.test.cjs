// tests/annotation-detached-and-empty.test.cjs
//
// Verifies roadmap tasks 15.9 (detached annotations after a re-sync) and 15.10
// (empty state + access-guard security) at the HTTP level, against a real
// running instance of the app -- the same harness as
// tests/card-annotations-panel.test.cjs and tests/card-consultation.test.cjs:
// an isolated temp copy of the repo (node_modules brought in via a directory
// junction), a fresh migrated SQLite file, an OS-assigned ephemeral port, and a
// node:http fetch-alike (no pooled keep-alive sockets). Covered:
//   - 15.9: an annotation whose quote/prefix/suffix no longer occur in the
//     rendered body is KEPT -- still listed by the card's `load` with its
//     ORIGINAL quote and flagged `detached`, carries NO body highlight (no
//     `<mark class="annotation-highlight">`), and remains updatable and
//     deletable;
//   - 15.10 empty state: a card with zero annotations renders the "no
//     annotations yet" affordance and never a spurious count ("(0)");
//   - 15.10 security: unauthenticated POSTs to the create/update/delete
//     annotation actions are redirected by the access guard (hooks.server.ts,
//     task 3.3) and never executed.
//
// Run with: node --test tests/annotation-detached-and-empty.test.cjs
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
const TEST_SESSION_SECRET = 'n'.repeat(32);
const STARTUP_TIMEOUT_MS = 30 * 1000;
const SHUTDOWN_TIMEOUT_MS = 5 * 1000;

// Bootstraps Vite's dev server programmatically, pointed at a throwaway copy of
// this repo, bound to a caller-chosen port. Intentionally identical to the
// other HTTP suites' harness (see tests/access-guard-and-logout.test.cjs).
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
	const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-detached-app-copy-'));
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
	const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-detached-web-harness-'));
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

// node:http-based fetch-alike (avoiding undici's pooled keep-alive sockets,
// which would keep this process alive after the server is killed). See
// tests/access-guard-and-logout.test.cjs for the full rationale.
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
		req.on('timeout', () =>
			req.destroy(new Error(`request to ${url} timed out after ${REQUEST_TIMEOUT_MS}ms`))
		);
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
 * Post a card form action the way a classic (no-JS) form submission does.
 * `Accept: text/html` makes SvelteKit answer with the real HTTP status for a
 * fail()/redirect result. `actionPath` is the full route-relative target,
 * e.g. `/cards/1?/updateAnnotation`.
 */
function postAction(baseUrl, actionPath, { cookie, fields = {} } = {}) {
	const headers = { accept: 'text/html' };
	if (cookie) headers.cookie = cookie;
	return fetch(`${baseUrl}${actionPath}`, {
		method: 'POST',
		redirect: 'manual',
		headers,
		body: new URLSearchParams(fields)
	});
}

/** Open a short-lived raw connection to seed/inspect fixtures directly. */
function withRawDb(dbPath, fn) {
	const conn = new Database(dbPath);
	try {
		return fn(conn);
	} finally {
		conn.close();
	}
}

/**
 * Fetch a route's `load` data over SvelteKit's own data-only HTTP endpoint
 * (`/__data.json`) and decode it with the same `devalue` codec SvelteKit
 * encodes it with -- the only way to observe the `annotations` list over real
 * HTTP, since the panel that renders it only mounts client-side.
 */
async function fetchAnnotations(baseUrl, dataPath, cookie) {
	const res = await fetch(`${baseUrl}${dataPath}`, { headers: { cookie } });
	assert.equal(res.status, 200, `expected the data-only request for ${dataPath} to succeed`);
	const raw = await res.text();
	const parsed = JSON.parse(raw);
	assert.equal(parsed.type, 'data');

	const devalueUrl = pathToFileURL(path.join(ROOT, 'node_modules', 'devalue', 'index.js')).href;
	const { unflatten } = await import(devalueUrl);

	for (const node of parsed.nodes) {
		if (!node || node.type !== 'data') continue;
		const data = unflatten(node.data);
		if (data && typeof data === 'object' && 'annotations' in data) {
			return data.annotations;
		}
	}
	throw new Error(`no load node exposed 'annotations' in ${dataPath} response:\n${raw}`);
}

// Card 1 body. Its plain text does NOT contain the annotated quote/prefix/suffix
// below, so the anchor cannot resolve against it: the annotation is detached.
const DETACHED_CARD_BODY = 'Photosynthesis converts light into chemical energy.';
const DETACHED_QUOTE = 'powerhouse of the cell';
const DETACHED_PREFIX = 'is the ';
const DETACHED_SUFFIX = '.';
const DETACHED_NOTE = 'Was anchored to a sentence that the re-sync removed.';

// Card 2 carries no annotations at all -- the empty-state fixture.
const EMPTY_CARD_BODY = 'A plain card that nobody has annotated.';

// Card 3 carries one detached and one resolvable annotation side by side, to
// prove the `detached` flag actually discriminates between them rather than
// happening to be the same value for every annotation on a card.
const CONTRAST_CARD_BODY = 'Mitochondria produce energy for the cell.';
const CONTRAST_RESOLVABLE_QUOTE = 'Mitochondria';
const CONTRAST_DETACHED_QUOTE = 'nonexistent phrase';

/** Seed a KB, a card whose body no longer contains its annotation, and a bare card. */
function seedFixtures(dbPath) {
	withRawDb(dbPath, (raw) => {
		raw
			.prepare(
				'INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 1)'
			)
			.run('KB One', 'https://example.test/one.git', 'main');
		raw
			.prepare(
				'INSERT INTO cards (id, kb_id, slug, title, theme, level, source_path, content, active) VALUES (1, 1, ?, ?, ?, ?, ?, ?, 1)'
			)
			.run('photosynthesis', 'Photosynthesis', 'biology', 'beginner', 'biology/photo.md', DETACHED_CARD_BODY);
		raw
			.prepare(
				'INSERT INTO cards (id, kb_id, slug, title, theme, level, source_path, content, active) VALUES (2, 1, ?, ?, ?, ?, ?, ?, 1)'
			)
			.run('bare', 'Bare Card', 'biology', 'beginner', 'biology/bare.md', EMPTY_CARD_BODY);
		raw
			.prepare(
				'INSERT INTO annotations (id, card_id, note, quote, prefix, suffix, start_offset) VALUES (1, 1, ?, ?, ?, ?, ?)'
			)
			.run(DETACHED_NOTE, DETACHED_QUOTE, DETACHED_PREFIX, DETACHED_SUFFIX, 4);
		raw
			.prepare(
				'INSERT INTO cards (id, kb_id, slug, title, theme, level, source_path, content, active) VALUES (3, 1, ?, ?, ?, ?, ?, ?, 1)'
			)
			.run('contrast', 'Contrast Card', 'biology', 'beginner', 'biology/contrast.md', CONTRAST_CARD_BODY);
		raw
			.prepare(
				'INSERT INTO annotations (id, card_id, note, quote, prefix, suffix, start_offset) VALUES (2, 3, ?, ?, ?, ?, ?)'
			)
			.run('Detached sibling.', CONTRAST_DETACHED_QUOTE, '', '', 0);
		raw
			.prepare(
				'INSERT INTO annotations (id, card_id, note, quote, prefix, suffix, start_offset) VALUES (3, 3, ?, ?, ?, ?, ?)'
			)
			.run('Resolvable sibling.', CONTRAST_RESOLVABLE_QUOTE, '', ' produce', 0);
	});
}

/** Read an annotation's stored note directly, or null when it is gone. */
function storedNote(dbPath, id) {
	return withRawDb(
		dbPath,
		(raw) => raw.prepare('SELECT note FROM annotations WHERE id = ?').get(id)?.note ?? null
	);
}

/** Count the annotations on a card directly. */
function annotationCount(dbPath, cardId) {
	return withRawDb(
		dbPath,
		(raw) => raw.prepare('SELECT COUNT(*) AS n FROM annotations WHERE card_id = ?').get(cardId).n
	);
}

describe('detached annotations and empty state on the consultation route (tasks 15.9/15.10)', () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-detached-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);
		seedFixtures(dbPath);

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

	test('a detached annotation is still listed with its original quote and flagged detached (task 15.9)', async () => {
		const annotations = await fetchAnnotations(app.baseUrl, '/cards/1/__data.json', cookie);
		assert.equal(annotations.length, 1, 'the detached annotation must not be hidden or dropped');
		assert.equal(annotations[0].id, 1);
		assert.equal(annotations[0].quote, DETACHED_QUOTE, 'it keeps its ORIGINAL quote');
		assert.equal(annotations[0].note, DETACHED_NOTE);
		assert.equal(annotations[0].detached, true, 'it must be flagged detached');
	});

	test('load flags exactly the detached annotation, not a resolvable sibling on the same card (task 15.9)', async () => {
		// The per-card panel (AnnotationsPanel.svelte) renders a "Detached" badge
		// straight off this `detached` flag once a user opens it -- client-mounted
		// interactive behaviour this HTTP-only harness cannot drive (no headless
		// browser in this stack). What IS verified end to end here is the flag the
		// panel's badge is conditioned on, seeded on a dedicated card (card 3) so
		// this stays isolated from the other fixtures' hardcoded counts: a
		// genuinely resolvable annotation must NOT be flagged alongside a detached
		// one, so this is a real discriminating check rather than a value that
		// happens to always be true.
		const annotations = await fetchAnnotations(app.baseUrl, '/cards/3/__data.json', cookie);
		assert.equal(annotations.length, 2);
		const detached = annotations.find((a) => a.quote === CONTRAST_DETACHED_QUOTE);
		const resolvable = annotations.find((a) => a.quote === CONTRAST_RESOLVABLE_QUOTE);
		assert.ok(detached && resolvable, 'both fixture annotations must be listed');
		assert.equal(detached.detached, true, 'the non-matching quote must be flagged detached');
		assert.equal(resolvable.detached, false, 'the matching quote must not be flagged detached');
	});

	test('a detached annotation carries no body highlight but keeps the entry point (task 15.9)', async () => {
		const res = await fetch(`${app.baseUrl}/cards/1`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		// Assert on the `data-annotation-id` attribute, which only a real
		// server-decorated highlight carries: the component's highlight CSS (and a
		// `<mark class="annotation-highlight">` mention in a CSS comment) also ship
		// in the dev page, so the bare class string is not proof of a rendered mark.
		assert.doesNotMatch(
			html,
			/data-annotation-id/,
			'a detached annotation must not be highlighted in the body (no location to anchor)'
		);
		// It is still counted in the panel entry point, so the note stays reachable.
		assert.match(html, /Annotations \(1\)/, 'the detached annotation is still listed in the panel');
	});

	test('a detached annotation remains updatable (task 15.9 / 15.8)', async () => {
		const updated = 'Still editable even though the anchor is gone.';
		const res = await postAction(app.baseUrl, '/cards/1?/updateAnnotation', {
			cookie,
			fields: { annotationId: '1', note: updated }
		});
		assert.equal(res.status, 200, 'updating a detached annotation must succeed');
		assert.equal(storedNote(dbPath, 1), updated, 'the update must persist');

		const annotations = await fetchAnnotations(app.baseUrl, '/cards/1/__data.json', cookie);
		assert.equal(annotations[0].note, updated);
		assert.equal(annotations[0].detached, true, 'it stays detached after an edit');
	});

	test('a card with no annotations shows the empty-state affordance and no count (task 15.10)', async () => {
		const res = await fetch(`${app.baseUrl}/cards/2`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /No annotations yet/, 'a bare card must show the empty-state affordance');
		assert.doesNotMatch(html, /Annotations \(/, 'no annotation count entry point when there are none');
		assert.doesNotMatch(html, /\(0\)/, 'no spurious "(0)" count on a card with no annotations');
	});

	test('an unauthenticated POST to annotate is redirected by the guard and never executed (task 15.10)', async () => {
		const before = annotationCount(dbPath, 1);
		const res = await fetch(`${app.baseUrl}/cards/1?/annotate`, {
			method: 'POST',
			redirect: 'manual',
			headers: { accept: 'text/html' },
			body: new URLSearchParams({
				cardId: '1',
				note: 'sneaked in',
				quote: 'Photosynthesis',
				prefix: '',
				suffix: ' converts',
				startOffset: '0'
			})
		});
		assert.equal(res.status, 303, 'the guard must redirect an unauthenticated annotate');
		assert.match(res.headers.get('location') ?? '', /\/login\?redirectTo=/, 'redirect to /login with redirectTo');
		assert.equal(annotationCount(dbPath, 1), before, 'no annotation may be created by the guarded request');
	});

	test('an unauthenticated POST to updateAnnotation is redirected by the guard and never executed (task 15.10)', async () => {
		const before = storedNote(dbPath, 1);
		const res = await fetch(`${app.baseUrl}/cards/1?/updateAnnotation`, {
			method: 'POST',
			redirect: 'manual',
			headers: { accept: 'text/html' },
			body: new URLSearchParams({ annotationId: '1', note: 'unauthorized edit' })
		});
		assert.equal(res.status, 303, 'the guard must redirect an unauthenticated update');
		assert.equal(storedNote(dbPath, 1), before, 'the note must not change on a guarded request');
	});

	test('an unauthenticated POST to deleteAnnotation is redirected by the guard and never executed (task 15.10)', async () => {
		const res = await fetch(`${app.baseUrl}/cards/1?/deleteAnnotation`, {
			method: 'POST',
			redirect: 'manual',
			headers: { accept: 'text/html' },
			body: new URLSearchParams({ annotationId: '1' })
		});
		assert.equal(res.status, 303, 'the guard must redirect an unauthenticated delete');
		assert.equal(annotationCount(dbPath, 1), 1, 'the annotation must survive a guarded delete');
	});

	test('a detached annotation remains deletable (task 15.9 / 15.8)', async () => {
		const res = await postAction(app.baseUrl, '/cards/1?/deleteAnnotation', {
			cookie,
			fields: { annotationId: '1' }
		});
		assert.equal(res.status, 200, 'deleting a detached annotation must succeed');
		assert.equal(storedNote(dbPath, 1), null, 'the annotation row must be gone after delete');

		const annotations = await fetchAnnotations(app.baseUrl, '/cards/1/__data.json', cookie);
		assert.equal(annotations.length, 0, 'the deleted annotation is no longer listed');
	});
});

test('the ROADMAP checks off tasks 15.9 and 15.10', () => {
	const roadmap = fs.readFileSync(path.join(ROOT, 'docs', 'ROADMAP.md'), 'utf8');
	for (const id of ['15.9', '15.10']) {
		const line = roadmap
			.split('\n')
			.find((l) => new RegExp(`\\*\\*${id.replace('.', '\\.')}\\*\\*`).test(l));
		assert.ok(line, `expected to find the "${id}" task line in docs/ROADMAP.md`);
		assert.match(line, /^- \[x\]/i, `task ${id} must be checked off`);
	}
});
