// tests/db-auto-migrate-on-boot.test.cjs
//
// Verifies the "fix(db): auto-apply drizzle migrations on first connection"
// bug fix (src/lib/server/db/index.ts):
//   - GET / used to answer a 500 ("SqliteError: no such table: cards") the
//     first time it ran against a fresh, never-migrated SQLite file (a dev
//     checkout or a freshly deployed environment where data/distil.db is
//     created on the fly), because the schema was only ever posed by the
//     separate `npm run db:migrate` script;
//   - the fix must guarantee the schema exists by the time the app answers a
//     request, applied idempotently (never breaking on an already-migrated
//     database), and WITHOUT giving the `db/index.ts` module an import-time
//     side effect (that module's own header comment states the connection
//     must stay lazily opened for the migration tooling and the rest of this
//     test suite, which build their own connection via createSqliteConnection
//     / createDb against a database they migrate themselves).
//
// This is deliberately the one suite in this project that never calls
// `npm run db:migrate` / drizzle-kit before touching the app: every other
// test file pre-migrates its database first (see tests/study-view.test.cjs,
// tests/kb-management.test.cjs, etc.), which is exactly why none of them
// would have caught this bug. Here the database path always starts out
// pointing at a file that does not exist yet, under a fresh `mkdtempSync`
// directory, so this suite never touches the real project `data/` tree and
// can run concurrently with the rest of `node --test tests/`.
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

const EXPECTED_TABLES = [
	'knowledge_bases',
	'cards',
	'theme_preferences',
	'bookmark_categories',
	'bookmarks',
	'reading_history'
].sort();

// Harness executed by `tsx` (in a fresh process each time) so it loads the
// real `src/lib/server/db/index.ts` module exactly as SvelteKit does. It
// always imports the module first and reports whether that import alone
// created the database file, then optionally queries through the lazy `db`
// singleton -- the same handle used by the rest of the app (e.g.
// src/lib/server/study.ts's listEligibleCards, whose "no such table: cards"
// failure is what this fix addresses).
const HARNESS_SOURCE = `
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

const [, , rootDir, dbPath, action] = process.argv;

const dbIndexUrl = pathToFileURL(path.join(rootDir, 'src', 'lib', 'server', 'db', 'index.ts')).href;
const dbMod = await import(dbIndexUrl);

const existsRightAfterImport = existsSync(dbPath);

function run() {
	switch (action) {
		case 'importOnly':
			return { existsRightAfterImport };
		case 'queryCards': {
			const rows = dbMod.db.select().from(dbMod.schema.cards).all();
			return { existsRightAfterImport, existsAfterQuery: existsSync(dbPath), rows };
		}
		default:
			throw new Error('unknown harness action: ' + action);
	}
}

const result = run();
process.stdout.write(JSON.stringify(result));
`;

let harnessDir;
let harnessPath;

before(() => {
	harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-db-boot-harness-'));
	harnessPath = path.join(harnessDir, 'db-boot-harness.mjs');
	fs.writeFileSync(harnessPath, HARNESS_SOURCE, 'utf8');
});

after(() => {
	if (harnessDir) fs.rmSync(harnessDir, { recursive: true, force: true });
});

/** Run one harness action, out-of-process via tsx, against the given (possibly not-yet-existing) database path. */
function runHarness(databasePath, action) {
	const result = spawnSync(process.execPath, [TSX_CLI, harnessPath, ROOT, databasePath, action], {
		cwd: ROOT,
		encoding: 'utf8',
		timeout: 30 * 1000,
		// The harness imports the real db/index.ts module, which resolves its
		// database path from DATABASE_PATH via resolveDatabasePath() -- exactly
		// like the running app -- rather than taking `databasePath` directly.
		env: { ...process.env, DATABASE_PATH: databasePath }
	});

	if (result.error) {
		throw new Error(`running db-boot harness action "${action}" failed to spawn: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`db-boot harness action "${action}" exited with ${result.status}:\n${result.stdout}\n${result.stderr}`);
	}
	return JSON.parse(result.stdout.trim());
}

describe('importing src/lib/server/db/index.ts stays lazy (no side effect at import time)', () => {
	let workDir;
	let dbPath;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-db-boot-import-'));
		dbPath = path.join(workDir, 'nested', 'never-touched.db');
	});

	after(() => {
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('merely importing the module does not create the database file', () => {
		const result = runHarness(dbPath, 'importOnly');
		assert.equal(result.existsRightAfterImport, false, 'importing db/index.ts must not open/create the database file');
		assert.equal(fs.existsSync(dbPath), false, 'the database file must still not exist on disk after the import-only run');
	});
});

describe('the first query through the lazy `db` singleton auto-applies migrations against a never-migrated database', () => {
	let workDir;
	let dbPath;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-db-boot-query-'));
		dbPath = path.join(workDir, 'app.db');
	});

	after(() => {
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('a query against `db` succeeds instead of throwing "no such table: cards", and creates the schema on demand', () => {
		assert.equal(fs.existsSync(dbPath), false, 'sanity check: the database file must not exist yet');

		const result = runHarness(dbPath, 'queryCards');

		assert.equal(result.existsRightAfterImport, false, 'the import itself must still not have created the file');
		assert.deepEqual(result.rows, [], 'a fresh database has no cards, but the query must not throw');
		assert.ok(result.existsAfterQuery, 'the first real query must have created the database file on demand');

		const raw = new Database(dbPath);
		try {
			const tables = raw
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
				.all()
				.map((row) => row.name)
				.filter((name) => name !== '__drizzle_migrations')
				.sort();
			assert.deepEqual(tables, EXPECTED_TABLES, 'the full schema must exist after the first query, not just `cards`');
		} finally {
			raw.close();
		}
	});

	test('a second, later process querying the now-already-migrated database is unaffected (idempotent)', () => {
		// The database file from the previous test is already fully migrated.
		// A brand new process (a fresh `db` singleton, exactly like a second
		// request in a running server) must be able to query it again without
		// drizzle's migrator erroring out on migrations it already applied.
		const result = runHarness(dbPath, 'queryCards');
		assert.deepEqual(result.rows, [], 'querying an already-migrated database again must still succeed');
	});
});

// --- HTTP-level: the actual reported bug (GET / -> 500) ---------------------

const TEST_PASSWORD = 'correct horse battery staple';
const TEST_SESSION_SECRET = 'z'.repeat(32);
const STARTUP_TIMEOUT_MS = 30 * 1000;
const SHUTDOWN_TIMEOUT_MS = 5 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;

// Boots Vite's dev server programmatically, pointed at a throwaway copy of
// the project, bound to a caller-chosen port. Mirrors the harness in
// tests/study-view.test.cjs / tests/access-guard-and-logout.test.cjs.
const WEB_HARNESS_SOURCE = `
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

const APP_COPY_FILES = ['package.json', 'svelte.config.js', 'vite.config.ts', 'tsconfig.json'];
// `drizzle/` (the migrationsFolder the fix reads via MIGRATIONS_FOLDER =
// join(process.cwd(), 'drizzle') in src/lib/server/db/index.ts) must be
// copied alongside src/ -- without it, the isolated app copy has no
// migrations to apply regardless of whether the fix under test works.
const APP_COPY_DIRS = ['src', 'static', 'drizzle'];

/** Materialize a throwaway copy of the project for Vite to run against. */
function buildIsolatedAppCopy() {
	const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-db-boot-app-copy-'));
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
	const harnessDirLocal = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-db-boot-web-harness-'));
	const harnessPathLocal = path.join(harnessDirLocal, 'web-harness.mjs');
	fs.writeFileSync(harnessPathLocal, WEB_HARNESS_SOURCE, 'utf8');

	const child = spawn(process.execPath, [TSX_CLI, harnessPathLocal, appDir, String(port)], {
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
			fs.rmSync(harnessDirLocal, { recursive: true, force: true });
			fs.rmSync(path.join(appDir, 'node_modules'), { force: true });
			fs.rmSync(appDir, { recursive: true, force: true });
		}
	};
}

// See tests/access-guard-and-logout.test.cjs for the rationale of this
// node:http-based fetch-alike (avoids undici's pooled keep-alive sockets,
// which would otherwise keep this test process alive after the server under
// test is killed), and for handling the socket 'timeout'/'error' events so a
// hung/broken request reports its real cause instead of hanging the suite.
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
	const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('distil_session='));
	assert.ok(setCookie, 'expected a distil_session Set-Cookie header from a successful login');
	return cookiePair(setCookie);
}

describe('GET / on a fresh, never-migrated database renders normally instead of a 500', () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-db-boot-http-'));
		// Deliberately never migrated (no drizzle-kit / npm run db:migrate call)
		// and the file does not exist yet -- this reproduces the exact reported
		// scenario: a dev/deploy environment where data/distil.db is created on
		// the fly and the schema has never been applied.
		dbPath = path.join(workDir, 'data', 'distil.db');
		assert.equal(fs.existsSync(dbPath), false, 'sanity check: the database file must not pre-exist');

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

	test('GET / answers 200 and renders the empty state (no KB / no card), never a 500', async () => {
		const res = await fetch(`${app.baseUrl}/`, { redirect: 'manual', headers: { cookie } });
		const body = await res.text();
		assert.equal(
			res.status,
			200,
			`expected a 200, got ${res.status} -- this is the reported "no such table: cards" 500 if it regresses:\n${body}`
		);
		assert.match(body, /No card to study/, 'a fresh, empty database has no eligible card, so the empty state must render');
	});

	test('the request itself created the database file and applied the full schema on demand', () => {
		assert.ok(fs.existsSync(dbPath), 'the app must have created the database file by the time it served the request');

		const raw = new Database(dbPath);
		try {
			const tables = raw
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
				.all()
				.map((row) => row.name)
				.filter((name) => name !== '__drizzle_migrations')
				.sort();
			assert.deepEqual(tables, EXPECTED_TABLES);
		} finally {
			raw.close();
		}
	});

	test('a second GET / against the now-migrated database still answers 200 (idempotent, no crash on re-entry)', async () => {
		const res = await fetch(`${app.baseUrl}/`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const body = await res.text();
		assert.match(body, /No card to study/);
	});
});
