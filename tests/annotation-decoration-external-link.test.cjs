// tests/annotation-decoration-external-link.test.cjs
//
// Regression test for the bug fixed by "keep target/rel on external links
// through decoration": a card whose body contains an external link lost its
// `target="_blank"` (and `rel="noopener noreferrer"`) attributes as soon as the
// card also carried a resolved annotation, because
// src/lib/server/annotation-anchor.ts's `decorateAnnotatedHtml` re-sanitized the
// already-rendered body with DOMPurify's default options while
// src/lib/server/markdown.ts's canonical render explicitly allows `target` --
// only the annotated path went through this second, stricter pass, so the same
// link behaved differently depending on whether the card had annotations.
//
// This is exercised at the HTTP level, through the real running app -- the
// project's public interface -- with the same harness as
// tests/card-annotations-panel.test.cjs (isolated temp copy of the repo, a
// fresh migrated SQLite file, an OS-assigned ephemeral port). Covered:
//   - a card WITH a resolved annotation still serves its external link with
//     target="_blank" rel="noopener noreferrer" (the decoration path);
//   - a card WITHOUT any annotation also serves it (the canonical render path),
//     guarding against a regression in either direction.
//
// Run with: node --test tests/annotation-decoration-external-link.test.cjs
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
const TEST_SESSION_SECRET = 'n'.repeat(32);
const STARTUP_TIMEOUT_MS = 30 * 1000;
const SHUTDOWN_TIMEOUT_MS = 5 * 1000;

// Bootstraps Vite's dev server programmatically, pointed at a throwaway copy of
// this repo, bound to a caller-chosen port. See
// tests/access-guard-and-logout.test.cjs for the rationale of every detail --
// this harness is intentionally identical to the other HTTP suites'.
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
	const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-annot-link-app-copy-'));
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
	const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-annot-link-web-harness-'));
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
// which would otherwise keep this test process alive after the server is killed).
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

// A card body carrying both an external Markdown link and, further along, a
// plain-text quote a TextQuoteSelector annotation can anchor to. The two are
// disjoint so the annotation's <mark> decoration never nests inside the <a>,
// keeping this a clean test of whether decoration merely *passes through* the
// unrelated link's attributes rather than reformatting it.
const EXTERNAL_URL = 'https://example.test/reference';
const CARD_BODY =
	`See the [reference site](${EXTERNAL_URL}) for background. ` +
	'The mitochondria is the powerhouse of the cell.';
const QUOTE = 'powerhouse';
const START_OFFSET = CARD_BODY.indexOf(QUOTE);
const NOTE = 'Key fact to remember.';

const EXTERNAL_LINK_RE = new RegExp(
	`<a href="${EXTERNAL_URL.replace(/[.]/g, '\\.')}"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>`
);

/** Seed a KB and one active card carrying CARD_BODY, optionally with an annotation. */
function seedCard(dbPath, { cardId, slug, withAnnotation }) {
	withRawDb(dbPath, (raw) => {
		raw
			.prepare(
				'INSERT OR IGNORE INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 1)'
			)
			.run('KB One', 'https://example.test/one.git', 'main');
		raw
			.prepare(
				'INSERT INTO cards (id, kb_id, slug, title, theme, level, source_path, content, active) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 1)'
			)
			.run(cardId, slug, 'The Cell', 'biology', 'beginner', `biology/${slug}.md`, CARD_BODY);
		if (withAnnotation) {
			raw
				.prepare(
					'INSERT INTO annotations (id, card_id, note, quote, prefix, suffix, start_offset) VALUES (?, ?, ?, ?, ?, ?, ?)'
				)
				.run(cardId, cardId, NOTE, QUOTE, 'is the ', ' of the', START_OFFSET);
		}
	});
}

describe('external link target/rel survive annotation decoration', () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-annot-link-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);
		// Card 1 carries a resolved annotation (exercises decorateAnnotatedHtml);
		// card 2 has none (exercises the canonical renderCardMarkdown path only).
		seedCard(dbPath, { cardId: 1, slug: 'cell-annotated', withAnnotation: true });
		seedCard(dbPath, { cardId: 2, slug: 'cell-plain', withAnnotation: false });

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

	test('a card WITH a resolved annotation still serves its external link with target="_blank" rel="noopener noreferrer"', async () => {
		const res = await fetch(`${app.baseUrl}/cards/1`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();

		// Sanity check the decoration actually ran on this card, otherwise the
		// assertion below would not exercise decorateAnnotatedHtml at all.
		assert.match(
			html,
			/<mark class="annotation-highlight" data-annotation-id="1">powerhouse<\/mark>/,
			'expected the annotation to be resolved and highlighted for this test to be meaningful'
		);
		assert.match(
			html,
			EXTERNAL_LINK_RE,
			'the external link must keep target="_blank" and rel="noopener noreferrer" after annotation decoration'
		);
	});

	test('a card WITHOUT any annotation serves its external link with target="_blank" rel="noopener noreferrer"', async () => {
		const res = await fetch(`${app.baseUrl}/cards/2`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();

		assert.doesNotMatch(
			html,
			/<mark[^>]*data-annotation-id/,
			'this card has no annotation, so no highlight <mark> should be present'
		);
		assert.match(
			html,
			EXTERNAL_LINK_RE,
			'the external link on a non-annotated card must keep target="_blank" and rel="noopener noreferrer"'
		);
	});
});
