// Verifies docs/ROADMAP.md section 3 "Authentification" (tasks 3.1, 3.2, 3.3):
// single-user session cookie + password verification, the /login page, and
// the hooks.server.ts access guard.
//
// These are black-box tests against the real built adapter-node server
// (spawned with `node build` on an OS-allocated ephemeral port, per the
// concurrent-safe-tests rule in CLAUDE.md): they drive the app over plain
// HTTP with APP_PASSWORD/SESSION_SECRET set in the child's environment, and
// never import src/lib/server/auth.ts directly, so the tests encode the
// ROADMAP-described behaviour (signed cookie, tamper/secret rejection,
// guard redirect, login form, logout) rather than its internal cookie
// format. The shared install/build fixture from tests/helpers.cjs is reused
// so the heavy install+build only happens once for the whole `npm test` run,
// and this suite never mutates the shared repo root.
//
// File: tests/auth.test.cjs
// Run with: npm test
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const { ROOT, getFreePort, useSharedFixture } = require('./helpers.cjs');

const APP_PASSWORD = 'correct-horse-battery-staple';
const SESSION_SECRET = 'test-session-secret-one';

function readText(relPath) {
	return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

// Spawn the built standalone server with the given extra env vars and wait
// until it accepts connections. Mirrors the retry/error-surfacing pattern in
// tests/adapter-node.test.cjs so a spawn failure or early crash is reported
// with its real cause instead of a bare connect-refused after the timeout.
async function startServer(fixtureDir, extraEnv) {
	const port = await getFreePort();
	const child = spawn('node', ['build'], {
		cwd: fixtureDir,
		env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...extraEnv },
		stdio: ['ignore', 'pipe', 'pipe']
	});

	let stderr = '';
	child.stderr.on('data', (chunk) => {
		stderr += chunk.toString();
	});

	let spawnError = null;
	let earlyExit = null;
	child.on('error', (err) => {
		spawnError = err;
	});
	child.on('exit', (code, signal) => {
		if (earlyExit === null) {
			earlyExit = { code, signal };
		}
	});

	await new Promise((resolve, reject) => {
		const start = Date.now();
		const retryOrFail = (cause) => {
			if (spawnError) {
				reject(new Error(`server process failed to start: ${spawnError.message}. stderr:\n${stderr}`));
			} else if (earlyExit) {
				reject(new Error(`server exited early (code ${earlyExit.code}, signal ${earlyExit.signal}). stderr:\n${stderr}`));
			} else if (Date.now() - start > 15000) {
				reject(new Error(`server never became reachable on port ${port}: ${cause}. stderr:\n${stderr}`));
			} else {
				setTimeout(tryConnect, 250);
			}
		};
		const tryConnect = () => {
			if (spawnError || earlyExit) {
				retryOrFail('child process is not running');
				return;
			}
			const req = http.get({ host: '127.0.0.1', port, path: '/login', timeout: 1000 }, (res) => {
				res.resume();
				resolve();
			});
			// A socket timeout does not abort the request on its own; without
			// destroying it here the request would hang instead of retrying.
			req.on('timeout', () => {
				req.destroy(new Error('request timed out'));
			});
			req.on('error', (err) => {
				retryOrFail(err.message);
			});
		};
		tryConnect();
	});

	return {
		port,
		baseUrl: `http://127.0.0.1:${port}`,
		getStderr: () => stderr,
		async stop() {
			// child.kill() only sends SIGTERM; wait for actual exit so no orphan
			// process is left holding the port after the test finishes.
			if (child.exitCode === null && child.signalCode === null) {
				await new Promise((resolve) => {
					child.once('exit', () => resolve());
					child.kill();
				});
			}
		}
	};
}

// Minimal HTTP client that never follows redirects (so redirect status/target
// can be asserted directly) and surfaces socket errors/timeouts instead of
// hanging, per the CLAUDE.md test-helper hygiene rule.
function request(baseUrl, { method = 'GET', path = '/', headers = {}, body } = {}) {
	return new Promise((resolve, reject) => {
		const url = new URL(path, baseUrl);
		const req = http.request(
			{
				method,
				host: url.hostname,
				port: url.port,
				path: url.pathname + url.search,
				headers,
				timeout: 5000
			},
			(res) => {
				const chunks = [];
				res.on('data', (chunk) => chunks.push(chunk));
				res.on('end', () => {
					resolve({
						status: res.statusCode,
						headers: res.headers,
						body: Buffer.concat(chunks).toString('utf8')
					});
				});
			}
		);
		req.on('timeout', () => {
			req.destroy(new Error(`request to ${path} timed out`));
		});
		req.on('error', reject);
		if (body) {
			req.write(body);
		}
		req.end();
	});
}

// Submits an application/x-www-form-urlencoded POST, the shape a plain HTML
// form action posts. The Origin header is set to the origin SvelteKit's CSRF
// check expects so the request isn't rejected with 403 regardless of the
// password: adapter-node's handler derives the expected origin from the Host
// header plus a protocol that defaults to `https` when no
// x-forwarded-proto-style header is set (see adapter-node's get_origin), even
// though the plain HTTP test server itself is reached over `http://`.
function formPost(baseUrl, targetPath, fields, cookie) {
	const body = new URLSearchParams(fields).toString();
	const expectedOrigin = `https://${new URL(baseUrl).host}`;
	const headers = {
		'content-type': 'application/x-www-form-urlencoded',
		'content-length': Buffer.byteLength(body),
		origin: expectedOrigin
	};
	if (cookie) {
		headers.cookie = cookie;
	}
	return request(baseUrl, { method: 'POST', path: targetPath, headers, body });
}

function firstSetCookie(headers) {
	const raw = headers['set-cookie'];
	return raw && raw.length > 0 ? raw[0] : null;
}

// "name=value", stripped of attributes, suitable for reuse as a Cookie header.
function cookiePair(setCookieHeader) {
	return setCookieHeader.split(';')[0];
}

function cookieName(setCookieHeader) {
	return cookiePair(setCookieHeader).split('=')[0];
}

function isRedirect(status) {
	return status === 302 || status === 303 || status === 307 || status === 308;
}

describe('.env.example documents the auth secrets with clear comments (roadmap 1.5/3.1)', () => {
	const lines = readText('.env.example').split('\n');

	for (const varName of ['APP_PASSWORD', 'SESSION_SECRET']) {
		test(`a comment immediately precedes ${varName}`, () => {
			const index = lines.findIndex((line) => line.startsWith(`${varName}=`));
			assert.ok(index > 0, `expected ${varName}=... in .env.example`);
			assert.match(
				lines[index - 1].trim(),
				/^#\s*\S/,
				`expected a non-empty comment line right before ${varName}=...`
			);
		});
	}
});

describe('single-user authentication (shared install/build fixture)', () => {
	let fixture;
	let server;

	before(async () => {
		fixture = useSharedFixture();
		server = await startServer(fixture.dir, {
			APP_PASSWORD,
			SESSION_SECRET
		});
	});

	after(async () => {
		if (server) {
			await server.stop();
		}
	});

	test('an unauthenticated request to the app home is redirected to /login (3.3)', async () => {
		const res = await request(server.baseUrl, { path: '/' });
		assert.ok(isRedirect(res.status), `expected a redirect, got ${res.status}`);
		assert.equal(res.headers.location, '/login');
	});

	test('an unauthenticated request to an unknown route is also redirected to /login (3.3)', async () => {
		const res = await request(server.baseUrl, { path: '/some/nonexistent/page' });
		assert.ok(isRedirect(res.status), `expected a redirect, got ${res.status}`);
		assert.equal(res.headers.location, '/login');
	});

	test('the /login route itself is reachable without a session (3.3)', async () => {
		const res = await request(server.baseUrl, { path: '/login' });
		assert.equal(res.status, 200);
	});

	test('a static/public asset is reachable without a session (3.3)', async () => {
		const res = await request(server.baseUrl, { path: '/robots.txt' });
		assert.equal(res.status, 200);
	});

	test('the login page renders a password field and a submit button (3.2)', async () => {
		const res = await request(server.baseUrl, { path: '/login' });
		assert.match(res.body, /<form[^>]*method=["']?POST["']?/i);
		assert.match(res.body, /<input[^>]*type=["']?password["']?/i);
		assert.match(res.body, /<button[^>]*type=["']?submit["']?/i);
	});

	test('the login page is in English (lang="en")', async () => {
		const res = await request(server.baseUrl, { path: '/login' });
		assert.match(res.body, /<html[^>]*\blang=["']en["']/i);
	});

	test('a wrong password shows an error and sets no session cookie (3.2)', async () => {
		const res = await formPost(server.baseUrl, '/login', { password: 'not-the-right-password' });
		assert.ok(!isRedirect(res.status), `wrong password should not redirect, got ${res.status}`);
		assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx status, got ${res.status}`);
		assert.match(res.body, /incorrect|invalid|wrong/i, 'expected an error message in the response body');
		assert.equal(firstSetCookie(res.headers), null, 'no session cookie should be set on failure');
	});

	describe('a successful login (3.1/3.2)', () => {
		let loginRes;
		let sessionSetCookie;
		let sessionCookiePair;

		before(async () => {
			loginRes = await formPost(server.baseUrl, '/login', { password: APP_PASSWORD });
			sessionSetCookie = firstSetCookie(loginRes.headers);
			sessionCookiePair = sessionSetCookie ? cookiePair(sessionSetCookie) : null;
		});

		test('redirects to the app home', () => {
			assert.ok(isRedirect(loginRes.status), `expected a redirect, got ${loginRes.status}`);
			assert.equal(loginRes.headers.location, '/');
		});

		test('sets a session cookie', () => {
			assert.ok(sessionSetCookie, 'expected a Set-Cookie header on successful login');
		});

		test('the session cookie is HttpOnly', () => {
			assert.ok(sessionSetCookie, 'expected a session cookie from an earlier successful login');
			assert.match(sessionSetCookie, /;\s*HttpOnly/i);
		});

		test('the session cookie is SameSite=Lax', () => {
			assert.ok(sessionSetCookie, 'expected a session cookie from an earlier successful login');
			assert.match(sessionSetCookie, /;\s*SameSite=Lax/i);
		});

		test('the session cookie is Secure (production build)', () => {
			assert.ok(sessionSetCookie, 'expected a session cookie from an earlier successful login');
			assert.match(sessionSetCookie, /;\s*Secure/i);
		});

		test('the session cookie grants access to the guarded home page', async () => {
			assert.ok(sessionCookiePair, 'expected a session cookie from an earlier successful login');
			const res = await request(server.baseUrl, { path: '/', headers: { cookie: sessionCookiePair } });
			assert.equal(res.status, 200);
		});

		test('visiting /login again with a valid session no longer serves the raw form at the guard level', async () => {
			// Not a hard ROADMAP requirement, but the guard must at least keep
			// allowing the (now authenticated) request through rather than
			// erroring out.
			assert.ok(sessionCookiePair, 'expected a session cookie from an earlier successful login');
			const res = await request(server.baseUrl, { path: '/login', headers: { cookie: sessionCookiePair } });
			assert.ok(res.status < 500, `expected no server error, got ${res.status}`);
		});

		test('a tampered session cookie is rejected (redirect to /login)', async () => {
			assert.ok(sessionCookiePair, 'expected a session cookie from an earlier successful login');
			const [name, value] = sessionCookiePair.split('=');
			const flippedChar = value.at(-1) === 'a' ? 'b' : 'a';
			const tampered = `${name}=${value.slice(0, -1)}${flippedChar}`;
			const res = await request(server.baseUrl, { path: '/', headers: { cookie: tampered } });
			assert.ok(isRedirect(res.status), `expected a redirect, got ${res.status}`);
			assert.equal(res.headers.location, '/login');
		});

		test('a cookie signed with a different SESSION_SECRET is rejected (redirect to /login)', async () => {
			const otherServer = await startServer(fixture.dir, {
				APP_PASSWORD,
				SESSION_SECRET: 'a-totally-different-secret'
			});
			try {
				const otherLogin = await formPost(otherServer.baseUrl, '/login', { password: APP_PASSWORD });
				const otherSetCookie = firstSetCookie(otherLogin.headers);
				assert.ok(otherSetCookie, 'expected the other server to also issue a session cookie');

				const res = await request(server.baseUrl, {
					path: '/',
					headers: { cookie: cookiePair(otherSetCookie) }
				});
				assert.ok(isRedirect(res.status), `expected a redirect, got ${res.status}`);
				assert.equal(res.headers.location, '/login');
			} finally {
				await otherServer.stop();
			}
		});

		test('logout clears the session cookie and redirects to /login (3.2)', async () => {
			assert.ok(sessionCookiePair, 'expected a session cookie from an earlier successful login');
			const res = await formPost(server.baseUrl, '/login?/logout', {}, sessionCookiePair);
			assert.ok(isRedirect(res.status), `expected a redirect, got ${res.status}`);
			assert.equal(res.headers.location, '/login');

			const clearing = (res.headers['set-cookie'] || []).find(
				(c) => cookieName(c) === cookieName(sessionSetCookie)
			);
			assert.ok(clearing, 'expected the logout action to clear the session cookie');
			assert.match(
				clearing,
				/Max-Age=0|Expires=[^;]*1970/i,
				'expected the cleared cookie to be expired/removed'
			);
		});
	});
});

describe('the ROADMAP checks off the authentication tasks', () => {
	const roadmap = readText('docs/ROADMAP.md');

	for (const taskId of ['3.1', '3.2', '3.3']) {
		test(`task ${taskId} is checked off`, () => {
			const escaped = taskId.replace('.', '\\.');
			const line = roadmap.split('\n').find((l) => new RegExp(`\\*\\*${escaped}\\*\\*`).test(l));
			assert.ok(line, `expected to find the "${taskId}" task line in docs/ROADMAP.md`);
			assert.match(line, /^- \[x\]/i, `task ${taskId} must be checked off`);
		});
	}
});
