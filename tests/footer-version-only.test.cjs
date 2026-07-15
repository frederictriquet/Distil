// tests/footer-version-only.test.cjs
//
// Verifies the "keep only the version in the footer, no other useless info"
// task: the shared footer (src/routes/+layout.svelte's .app-footer) must show
// the build-time application version -- and nothing else. Concretely:
//   - the version label ("Version <semver>+<sha>") still renders in the footer
//     on pages that draw the app shell;
//   - the previously-shown tagline ("Distil — your personal knowledge base
//     study companion") -- the "useless info" the task removes -- must no
//     longer appear anywhere in the footer (nor elsewhere in the page);
//   - the footer's only visible text is the version label: once the version
//     token is stripped out, no other words remain inside <footer>.
//
// This drives the real HTTP flow (a real Vite dev server + real login),
// because whether the tagline is genuinely gone and the version genuinely
// remains in the rendered HTML is a property of the running app, not
// something a source text check could establish. Each server runs against a
// throwaway copy of the project (src/, static/ and config files, with
// node_modules brought in via a directory junction rather than copied or
// reinstalled, per CLAUDE.md), with its own isolated SQLite file and an
// OS-assigned ephemeral port, so this suite never touches the shared repo
// root and is safe to run concurrently with the rest of `node --test tests/`.
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
const TEST_SESSION_SECRET = 'z'.repeat(32);
const STARTUP_TIMEOUT_MS = 30 * 1000;
const SHUTDOWN_TIMEOUT_MS = 5 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;

// The tagline the task removes as "useless info".
const REMOVED_TAGLINE = /Distil\s*—\s*your personal knowledge base study companion/;

// --- shared harness (mirrors tests/footer-version-display.test.cjs) ---------

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

/** A throwaway copy of the project Vite can be pointed at instead of ROOT. */
function buildIsolatedAppCopy(prefix) {
	const appDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	for (const file of APP_COPY_FILES) {
		fs.cpSync(path.join(ROOT, file), path.join(appDir, file));
	}
	for (const dir of APP_COPY_DIRS) {
		fs.cpSync(path.join(ROOT, dir), path.join(appDir, dir), { recursive: true });
	}
	fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(appDir, 'node_modules'), 'junction');
	return appDir;
}

function cleanupAppCopy(appDir) {
	fs.rmSync(path.join(appDir, 'node_modules'), { force: true });
	fs.rmSync(appDir, { recursive: true, force: true });
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

/** Start the real app (against `appDir`) with the given environment; resolves once ready. */
async function startApp(appDir, env) {
	const port = await getEphemeralPort();
	const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-footer-only-harness-'));
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
		}
	};
}

// Built on node:http (not global fetch) so no pooled keep-alive socket is left
// dangling once the dev server under test is killed at the end of a suite.
// Surfaces the socket 'timeout'/'error' events so a hung/broken request
// reports its real cause instead of hanging the suite.
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
							getSetCookie: () =>
								Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
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
	const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('distil_session='));
	assert.ok(setCookie, 'expected a distil_session Set-Cookie header from a successful login');
	return cookiePair(setCookie);
}

/** Extract the inner HTML of the (single) <footer> element, or null if absent. */
function footerInnerHtml(html) {
	const match = html.match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/i);
	return match ? match[1] : null;
}

/** Strip HTML tags and collapse whitespace, yielding the visible text. */
function visibleText(html) {
	return html
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

// --- main behaviour: footer holds the version and nothing else -------------

describe('the footer shows only the build version, no other info', () => {
	const FIXED_VERSION = '3.4.5+cafef00';

	let appDir;
	let app;
	let workDir;
	let cookie;

	before(async () => {
		appDir = buildIsolatedAppCopy('distil-footer-only-app-');
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-footer-only-data-'));
		const dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);

		app = await startApp(appDir, {
			APP_PASSWORD: TEST_PASSWORD,
			SESSION_SECRET: TEST_SESSION_SECRET,
			DATABASE_PATH: dbPath,
			// Pin the build-time version to a known value so the footer
			// assertions don't depend on this checkout's package.json/git state.
			APP_VERSION: FIXED_VERSION
		});
		cookie = await login(app.baseUrl);
	});

	after(async () => {
		if (app) await app.stop();
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
		if (appDir) cleanupAppCopy(appDir);
	});

	const versionPattern = new RegExp(
		`Version\\s+${FIXED_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
	);

	for (const route of ['/', '/kb', '/bookmarks']) {
		test(`GET ${route}: footer shows "Version ${FIXED_VERSION}" and nothing else`, async () => {
			const res = await fetch(`${app.baseUrl}${route}`, { headers: { cookie } });
			assert.equal(res.status, 200, `expected 200 from ${route}, got ${res.status}`);
			const html = await res.text();

			const footer = footerInnerHtml(html);
			assert.ok(footer !== null, `expected a <footer> in the response for ${route}`);

			// The version must still be there.
			assert.match(
				footer,
				versionPattern,
				`expected the footer on ${route} to show "Version ${FIXED_VERSION}", got footer:\n${footer}`
			);

			// The removed tagline must be gone -- from the footer and the page.
			assert.doesNotMatch(
				footer,
				REMOVED_TAGLINE,
				`the removed tagline must no longer appear in the footer on ${route}, got footer:\n${footer}`
			);
			assert.doesNotMatch(
				html,
				REMOVED_TAGLINE,
				`the removed tagline must no longer appear anywhere on ${route}`
			);

			// Once the version label is removed, no other visible words remain
			// in the footer: the version is the *only* info left.
			const text = visibleText(footer);
			const leftover = text.replace(versionPattern, '').trim();
			assert.equal(
				leftover,
				'',
				`the footer must contain only the version; unexpected leftover text on ${route}: "${leftover}"`
			);
		});
	}
});
