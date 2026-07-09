// tests/access-guard-and-logout.test.cjs
//
// Verifies the remaining "sveltekit-action-contract" backlog work end to end
// against a real running instance of the app:
//   - the access guard (src/hooks.server.ts) preserves the originally
//     requested URL (path + query) through a `redirectTo` param when
//     bouncing an unauthenticated request to /login, and the login page
//     reads it, renders it, and honors it after a successful login
//     (both for a classic no-JS submission and a use:enhance one);
//   - `redirectTo` is validated as a same-origin internal path: an
//     external/malformed value always falls back to "/" rather than being
//     followed (open-redirect protection), both at submit time and in the
//     login page's own load() when it bounces an already-authenticated
//     visitor away from /login;
//   - logout lives on its own dedicated route (not a hooks.server.ts
//     interception of a "/login?/logout" form action), clears the session
//     cookie and redirects to /login;
//   - (consolidating the pre-existing rule) the KB mutating actions answer
//     with a real HTTP 400 for an invalid/missing id and 404 for an unknown
//     one -- never a silent success -- and the access guard covers those
//     action endpoints too.
//
// The app is started for real (Vite's dev server, driven programmatically)
// because this behavior lives across hooks.server.ts, form actions and HTTP
// semantics (redirect codes, Set-Cookie, content negotiation) that cannot be
// observed by importing modules directly, unlike tests/kb-management.test.cjs.
// Vite (and the SvelteKit plugin's own `svelte-kit sync`) write cache/build
// state into the project root they are pointed at, so the dev server is
// pointed at a throwaway copy of the project (src/, static/ and the config
// files, with node_modules brought in via a directory junction rather than
// copied) instead of this repo checkout -- this suite never writes into the
// real project tree (no node_modules/.vite, no .svelte-kit) and is safe to
// run concurrently with the rest of `node --test tests/`. All of its mutable
// state (the SQLite file) is likewise redirected through DATABASE_PATH to a
// fresh temp directory. The server binds to a port freshly probed from the
// OS (never a hardcoded one), so concurrent runs never collide either.
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
const TSX_CLI = require.resolve('tsx/cli');
const DRIZZLE_KIT_CLI = path.join(ROOT, 'node_modules', 'drizzle-kit', 'bin.cjs');

const TEST_PASSWORD = 'correct horse battery staple';
const TEST_SESSION_SECRET = 'x'.repeat(32);
const STARTUP_TIMEOUT_MS = 30 * 1000;
const SHUTDOWN_TIMEOUT_MS = 5 * 1000;

// Bootstraps Vite's dev server programmatically (the same engine `npm run dev`
// uses), pointed at a throwaway copy of this repo's vite.config.ts/
// svelte.config.js (see buildIsolatedAppCopy below), bound to a caller-chosen
// port. Importing 'vite' by its resolved entry file (rather than a bare
// `import 'vite'`) is required because this script itself lives under a
// throwaway os.tmpdir() directory with no node_modules of its own; resolving
// bare specifiers from *within* node_modules/vite (reached through the
// junction-linked node_modules, which does have access to the repo's hoisted
// dependencies) sidesteps that entirely.
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
	// node_modules under rootDir is a junction to the real repo's node_modules
	// (see buildIsolatedAppCopy), so Vite's default node_modules/.vite cache
	// location would resolve straight back into the shared checkout; pointing
	// cacheDir outside of node_modules keeps every write inside this temp copy.
	cacheDir: path.join(rootDir, '.vite-cache'),
	server: { port, host: '127.0.0.1', strictPort: true },
	logLevel: 'error'
});

await server.listen();
process.stdout.write('READY\\n');
`;

/** Run the project's migration (task 2.3) against an isolated database file. */
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

/**
 * Files/directories the SvelteKit dev server needs to actually run the app,
 * copied verbatim; node_modules is linked in rather than copied (there is no
 * portable, dependency-free way to re-run `npm install` here, and CLAUDE.md
 * requires isolated tests never to depend on a network install anyway).
 */
const APP_COPY_FILES = ['package.json', 'svelte.config.js', 'vite.config.ts', 'tsconfig.json'];
const APP_COPY_DIRS = ['src', 'static'];

/**
 * Materialize a throwaway copy of the project that Vite can be pointed at
 * instead of this repo checkout, so the dev server's own cache/build state
 * (node_modules/.vite, .svelte-kit) is written into a temp directory rather
 * than the shared working tree. node_modules is brought in via
 * fs.symlinkSync(..., 'junction') -- a directory junction needs no elevated
 * privileges on Windows (unlike a regular directory symlink) and the 'junction'
 * type argument is simply ignored on POSIX, so this is portable everywhere.
 */
function buildIsolatedAppCopy() {
	const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-app-copy-'));
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

/**
 * Start the real app (via the Vite dev server harness above) with the given
 * environment, and resolve once it reports readiness. Rejects (rather than
 * hanging) on a spawn error, an early exit, or a startup timeout, always
 * including the captured stderr so a real failure is diagnosable.
 */
async function startApp(env) {
	const port = await getEphemeralPort();
	const appDir = buildIsolatedAppCopy();
	const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-web-harness-'));
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
				// 'exit' fires as soon as the process terminates, but its stdio
				// pipes (piped into stdoutBuf/stderrBuf above) can still be
				// draining at that point; waiting for 'close' instead means those
				// pipe sockets are fully torn down before this resolves, so no
				// handle is left open to keep the test process alive afterwards.
				child.once('close', () => {
					clearTimeout(timer);
					resolve();
				});
			});
			// Belt-and-braces: on some platforms the stdout/stderr pipe sockets
			// stay registered as active libuv handles for a beat past 'close',
			// which is enough to keep this whole test process from exiting on
			// its own. Explicitly destroying them frees those handles right away
			// instead of leaving the process to hang until an external timeout.
			child.stdout?.destroy();
			child.stderr?.destroy();
			fs.rmSync(harnessDir, { recursive: true, force: true });
			// The node_modules entry is a junction to the real node_modules, not a
			// copy: rm it non-recursively first so `recursive: true` below never
			// walks into (and never risks touching) the shared dependency tree.
			fs.rmSync(path.join(appDir, 'node_modules'), { force: true });
			fs.rmSync(appDir, { recursive: true, force: true });
		}
	};
}

const REQUEST_TIMEOUT_MS = 10 * 1000;

// Node's built-in global `fetch` (undici) pools keep-alive sockets per origin
// and exposes no portable, dependency-free way to close that pool from
// userland. Since the dev server under test is killed at the very end of the
// run, an unclosed pool leaves dangling socket handles that block the test
// process from exiting on its own once the suite is otherwise done -- it
// would then only terminate via an external `node --test` timeout, which
// masks the real pass/fail outcome. This `fetch`-shaped wrapper is built on
// `node:http` instead, with `agent: false` forcing a plain, unpooled socket
// per request that is always torn down once its response ends. It never
// follows redirects, matching every callers' `redirect: 'manual'` intent.
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
						},
						async json() {
							return JSON.parse(rawBody);
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

/** All `Set-Cookie` values from a fetch Response, tolerating older Node fetch. */
function setCookies(response) {
	return typeof response.headers.getSetCookie === 'function'
		? response.headers.getSetCookie()
		: [response.headers.get('set-cookie')].filter(Boolean);
}

/** The `distil_session` Set-Cookie header from a login/logout response. */
function extractSessionCookie(response) {
	const cookie = setCookies(response).find((c) => c.startsWith('distil_session='));
	assert.ok(cookie, 'expected a distil_session Set-Cookie header in the response');
	return cookie;
}

/** The `name=value` pair only, suitable for a subsequent request's Cookie header. */
function cookiePair(setCookieHeader) {
	return setCookieHeader.split(';')[0];
}

/** POST a classic (no-JS) login submission: password + optional redirectTo. */
function submitLogin(baseUrl, { password = TEST_PASSWORD, redirectTo } = {}) {
	const body = new URLSearchParams({ password });
	if (redirectTo !== undefined) body.set('redirectTo', redirectTo);
	return fetch(`${baseUrl}/login`, { method: 'POST', redirect: 'manual', body });
}

describe('sveltekit-action-contract: access guard, login redirect, open-redirect protection, dedicated logout', () => {
	let app;
	let workDir;
	let dbPath;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-action-contract-'));
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

	describe('part A: the access guard preserves the requested URL through /login and back', () => {
		test('an unauthenticated request to a protected page is redirected to /login with redirectTo set to the original path + query', async () => {
			const res = await fetch(`${app.baseUrl}/kb?tab=active`, { redirect: 'manual' });
			assert.equal(res.status, 303);
			assert.equal(res.headers.get('location'), '/login?redirectTo=' + encodeURIComponent('/kb?tab=active'));
		});

		test('the login page reads redirectTo from the query string and renders it as a hidden form field', async () => {
			const res = await fetch(`${app.baseUrl}/login?redirectTo=${encodeURIComponent('/kb?tab=active')}`, {
				redirect: 'manual'
			});
			assert.equal(res.status, 200);
			const html = await res.text();
			const match = html.match(/name="redirectTo"\s+value="([^"]*)"/);
			assert.ok(match, 'expected a hidden redirectTo field on the login form');
			assert.equal(match[1], '/kb?tab=active');
		});

		test('a classic (no-JS) login submission gets a real 303 redirect back to the originally requested page, with the session cookie set', async () => {
			const res = await submitLogin(app.baseUrl, { redirectTo: '/kb?tab=active' });
			assert.equal(res.status, 303, 'a classic form POST must get a real HTTP redirect, not a JSON envelope');
			assert.equal(res.headers.get('location'), '/kb?tab=active');
			assert.match(extractSessionCookie(res), /^distil_session=[^;]+/);
		});

		test('a progressively-enhanced (use:enhance) login submission still redirects to the originally requested page', async () => {
			const res = await fetch(`${app.baseUrl}/login`, {
				method: 'POST',
				redirect: 'manual',
				headers: { 'x-sveltekit-action': 'true' },
				body: new URLSearchParams({ password: TEST_PASSWORD, redirectTo: '/kb' })
			});
			assert.equal(res.status, 200, 'an enhanced action submission carries its redirect as a JSON envelope, not a raw 303');
			assert.deepEqual(await res.json(), { type: 'redirect', status: 303, location: '/kb' });
		});

		test('a successful login with no redirectTo at all lands on the app home', async () => {
			const res = await submitLogin(app.baseUrl, {});
			assert.equal(res.status, 303);
			assert.equal(res.headers.get('location'), '/');
		});
	});

	describe('part A (security): redirectTo is validated as a same-origin internal path', () => {
		const maliciousRedirects = ['https://evil.example/steal', '//evil.example/steal', '/\\evil.example'];

		for (const malicious of maliciousRedirects) {
			test(`a login submission with redirectTo=${JSON.stringify(malicious)} falls back to "/" instead of following it`, async () => {
				const res = await submitLogin(app.baseUrl, { redirectTo: malicious });
				assert.equal(res.status, 303);
				assert.equal(res.headers.get('location'), '/', `must never redirect off-origin to ${malicious}`);
			});
		}

		test('the login page itself renders "/" as the hidden redirectTo field when given a malicious value', async () => {
			const res = await fetch(`${app.baseUrl}/login?redirectTo=${encodeURIComponent('https://evil.example')}`, {
				redirect: 'manual'
			});
			assert.equal(res.status, 200);
			const html = await res.text();
			const match = html.match(/name="redirectTo"\s+value="([^"]*)"/);
			assert.ok(match);
			assert.equal(match[1], '/');
		});

		test('load() redirects an already-authenticated visitor away from /login, and also falls back to "/" for a malicious redirectTo', async () => {
			const loginRes = await submitLogin(app.baseUrl, {});
			const cookie = cookiePair(extractSessionCookie(loginRes));

			const res = await fetch(`${app.baseUrl}/login?redirectTo=${encodeURIComponent('https://evil.example')}`, {
				redirect: 'manual',
				headers: { cookie }
			});
			assert.equal(res.status, 303);
			assert.equal(res.headers.get('location'), '/');
		});

		test('load() honors a valid redirectTo when bouncing an already-authenticated visitor away from /login', async () => {
			const loginRes = await submitLogin(app.baseUrl, {});
			const cookie = cookiePair(extractSessionCookie(loginRes));

			const res = await fetch(`${app.baseUrl}/login?redirectTo=${encodeURIComponent('/kb')}`, {
				redirect: 'manual',
				headers: { cookie }
			});
			assert.equal(res.status, 303);
			assert.equal(res.headers.get('location'), '/kb');
		});
	});

	describe('part B: logout lives on a dedicated route', () => {
		test('the session cookie authenticates a protected page before logout (sanity check)', async () => {
			const loginRes = await submitLogin(app.baseUrl, {});
			const cookie = cookiePair(extractSessionCookie(loginRes));
			const res = await fetch(`${app.baseUrl}/kb`, { redirect: 'manual', headers: { cookie } });
			assert.equal(res.status, 200);
		});

		test('POST /logout clears the session cookie and redirects (303) to /login', async () => {
			const loginRes = await submitLogin(app.baseUrl, {});
			const cookie = cookiePair(extractSessionCookie(loginRes));

			const res = await fetch(`${app.baseUrl}/logout`, { method: 'POST', redirect: 'manual', headers: { cookie } });

			assert.equal(res.status, 303);
			assert.equal(res.headers.get('location'), '/login');

			const cleared = extractSessionCookie(res);
			assert.match(cleared, /^distil_session=;/, 'expected the cookie value to be cleared');
			assert.match(cleared, /max-age=0/i, 'expected the cookie to be expired immediately');
		});

		test('the old /login?/logout interception is gone: that path now 404s instead of logging out', async () => {
			const loginRes = await submitLogin(app.baseUrl, {});
			const cookie = cookiePair(extractSessionCookie(loginRes));

			const res = await fetch(`${app.baseUrl}/login?/logout`, {
				method: 'POST',
				redirect: 'manual',
				headers: { cookie },
				body: new URLSearchParams()
			});

			// /login only ever declares a `default` action (enforced by
			// tests/action-route-contract-static.test.cjs), so there is no
			// "logout" action left for SvelteKit to dispatch to here.
			assert.equal(res.status, 404);
		});
	});

	describe('consolidating: KB mutating actions answer coherent HTTP statuses for invalid/missing ids', () => {
		let cookie;

		before(async () => {
			const loginRes = await submitLogin(app.baseUrl, {});
			cookie = cookiePair(extractSessionCookie(loginRes));
		});

		/**
		 * `Accept: text/html` mirrors a classic (no-JS) form submission, which is
		 * the mode in which SvelteKit answers with the *real* HTTP status code for
		 * a fail() result; without it, fail()/success results are all wrapped in a
		 * 200 JSON envelope for progressive-enhancement clients to unpack client-side.
		 */
		function callKbAction(action, formFields) {
			return fetch(`${app.baseUrl}/kb?/${action}`, {
				method: 'POST',
				redirect: 'manual',
				headers: { cookie, accept: 'text/html' },
				body: new URLSearchParams(formFields)
			});
		}

		test('toggleFocus with a non-numeric id answers 400, not a silent success', async () => {
			assert.equal((await callKbAction('toggleFocus', { id: 'not-a-number' })).status, 400);
		});

		test('toggleFocus for an id that does not exist answers 404, not a silent success', async () => {
			assert.equal((await callKbAction('toggleFocus', { id: '999999' })).status, 404);
		});

		test('delete with a missing id answers 400, not a silent success', async () => {
			assert.equal((await callKbAction('delete', {})).status, 400);
		});

		test('delete for an id that does not exist answers 404, not a silent success', async () => {
			assert.equal((await callKbAction('delete', { id: '999999' })).status, 404);
		});

		test('an unauthenticated attempt to call a mutating action is redirected by the guard, never executed', async () => {
			const res = await fetch(`${app.baseUrl}/kb?/delete`, {
				method: 'POST',
				redirect: 'manual',
				headers: { accept: 'text/html' },
				body: new URLSearchParams({ id: '999999' })
			});
			assert.equal(res.status, 303);
			assert.equal(res.headers.get('location'), '/login?redirectTo=' + encodeURIComponent('/kb?/delete'));
		});
	});
});
