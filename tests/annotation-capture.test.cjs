// tests/annotation-capture.test.cjs
//
// Verifies roadmap 15.4 (the card-body annotation capture UI) and 15.5 (the
// shared `annotate` save action) at the HTTP level against a real running
// instance of the app -- the same harness as tests/study-bookmark-panel.test.cjs
// and tests/card-consultation.test.cjs (isolated temp app copy with a
// node_modules junction, ephemeral port, fresh migrated DB, a node:http
// fetch-alike, spawnSync error/timeout handling):
//   - the `annotate` named action is wired into every card route (the study
//     view `/` and both consultation routes) via the shared handler in
//     src/lib/server/card-actions.ts; a valid submission persists an annotation,
//     an empty note answers 400, a malformed/empty quote answers 400, a
//     nonexistent card id answers 404 (handled foreign-key path, never a 500),
//     and an unauthenticated POST is redirected by the access guard;
//   - a rendered card page carries the capture UI markup (the client-only popup
//     mounts on selection, but its always-rendered root is present in the HTML).
//
// The actual text selection + popup interaction is client-runtime behaviour that
// cannot be driven meaningfully from Node, so it is not exercised here.
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
const TEST_SESSION_SECRET = 'b'.repeat(32);
const STARTUP_TIMEOUT_MS = 30 * 1000;
const SHUTDOWN_TIMEOUT_MS = 5 * 1000;

// Bootstraps Vite's dev server programmatically, pointed at a throwaway copy of
// this repo, bound to a caller-chosen port -- identical to the harness in
// tests/study-bookmark-panel.test.cjs (see there for the rationale of each
// detail).
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
	const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-annotation-capture-app-copy-'));
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
	const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-annotation-capture-web-harness-'));
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

// A node:http-based fetch-alike (avoiding undici's pooled keep-alive sockets,
// which would otherwise keep this test process alive after the server under
// test is killed) -- see tests/study-bookmark-panel.test.cjs.
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

const VALID_ANCHOR = {
	quote: 'powerhouse of the cell',
	prefix: 'is the ',
	suffix: '.',
	startOffset: '24'
};

describe('the shared annotate action creates card annotations (tasks 15.4/15.5)', () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-annotation-capture-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);

		withRawDb(dbPath, (raw) => {
			raw
				.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 1)')
				.run('Focused KB', 'https://example.test/focused.git', 'main');
			raw
				.prepare(
					'INSERT INTO cards (id, kb_id, slug, title, theme, source_path, content, active) VALUES (1, 1, ?, ?, ?, ?, ?, 1)'
				)
				.run('card-a', 'Card A Title', 'sql', 'card-a.md', 'The mitochondria is the powerhouse of the cell.');
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
	 * `Accept: text/html` mirrors a classic (no-JS) form submission, in which mode
	 * SvelteKit answers with the real HTTP status code for a fail()/success result
	 * (see tests/study-bookmark-panel.test.cjs); without it the results are all
	 * wrapped in a 200 JSON envelope instead. `routePath` is the card route the
	 * action is bound to (the study view or a consultation page).
	 */
	function callAnnotate(routePath, formFields) {
		return fetch(`${app.baseUrl}${routePath}?/annotate`, {
			method: 'POST',
			redirect: 'manual',
			headers: { cookie, accept: 'text/html' },
			body: new URLSearchParams(formFields)
		});
	}

	function annotationsForCard(cardId) {
		return withRawDb(dbPath, (raw) =>
			raw.prepare('SELECT * FROM annotations WHERE card_id = ? ORDER BY id').all(cardId)
		);
	}

	function annotationCount() {
		return withRawDb(dbPath, (raw) => raw.prepare('SELECT COUNT(*) AS n FROM annotations').get().n);
	}

	test('a valid save on the study route (/) persists the annotation with its anchor', async () => {
		const before = annotationCount();
		const res = await callAnnotate('/', {
			cardId: '1',
			note: 'A note from the study view.',
			...VALID_ANCHOR
		});
		assert.equal(res.status, 200);
		assert.equal(annotationCount(), before + 1);

		const rows = annotationsForCard(1);
		const row = rows[rows.length - 1];
		assert.equal(row.note, 'A note from the study view.');
		assert.equal(row.quote, VALID_ANCHOR.quote);
		assert.equal(row.prefix, VALID_ANCHOR.prefix);
		assert.equal(row.suffix, VALID_ANCHOR.suffix);
		assert.equal(row.start_offset, Number(VALID_ANCHOR.startOffset));
	});

	test('a valid save on a consultation route (/cards/<id>) persists the annotation too', async () => {
		const before = annotationCount();
		const res = await callAnnotate('/cards/1', {
			cardId: '1',
			note: 'A note from the consultation view.',
			...VALID_ANCHOR
		});
		assert.equal(res.status, 200);
		assert.equal(annotationCount(), before + 1);

		const rows = annotationsForCard(1);
		assert.ok(
			rows.some((r) => r.note === 'A note from the consultation view.'),
			'the consultation-view annotation must be persisted'
		);
	});

	test('an empty note answers 400, not a silent success', async () => {
		const before = annotationCount();
		const res = await callAnnotate('/', { cardId: '1', note: '   ', ...VALID_ANCHOR });
		assert.equal(res.status, 400);
		assert.equal(annotationCount(), before, 'no annotation must be created for an empty note');
	});

	test('a malformed (empty) quote answers 400, not a silent success', async () => {
		const before = annotationCount();
		const res = await callAnnotate('/', {
			cardId: '1',
			note: 'A valid note.',
			quote: '',
			prefix: 'is the ',
			suffix: '.',
			startOffset: '24'
		});
		assert.equal(res.status, 400);
		assert.equal(annotationCount(), before, 'no annotation must be created for a malformed anchor');
	});

	test('a valid-but-nonexistent cardId answers 404 (foreign-key violation), not a 500', async () => {
		const before = annotationCount();
		const res = await callAnnotate('/', { cardId: '999999', note: 'Orphan note.', ...VALID_ANCHOR });
		assert.equal(res.status, 404);
		assert.equal(annotationCount(), before, 'no annotation must be created for a missing card');
	});

	test('an unauthenticated attempt to annotate is redirected by the guard, never executed', async () => {
		const before = annotationCount();
		const res = await fetch(`${app.baseUrl}/?/annotate`, {
			method: 'POST',
			redirect: 'manual',
			headers: { accept: 'text/html' },
			body: new URLSearchParams({ cardId: '1', note: 'Should not be created.', ...VALID_ANCHOR })
		});
		assert.equal(res.status, 303);
		assert.equal(annotationCount(), before, 'the guard must fire before the action runs');
	});

	test('a rendered card page carries the annotation capture UI markup', async () => {
		const res = await fetch(`${app.baseUrl}/cards/1`, { headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /data-annotation-capture/, 'expected the capture UI root in the rendered page');
	});
});

test('the ROADMAP checks off tasks 15.4 and 15.5 (annotation capture + save action)', () => {
	const roadmap = fs.readFileSync(path.join(ROOT, 'docs', 'ROADMAP.md'), 'utf8');
	const lines = roadmap.split('\n');
	for (const id of ['15\\.4', '15\\.5']) {
		const line = lines.find((l) => new RegExp(`\\*\\*${id}\\*\\*`).test(l));
		assert.ok(line, `expected to find the "${id}" task line in docs/ROADMAP.md`);
		assert.match(line, /^- \[x\]/i, `task ${id} must be checked off`);
	}
});
