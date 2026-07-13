// tests/update-detection-banner.test.cjs
//
// Verifies roadmap task 13.7 ("Mettre en place la détection de mise à jour via
// le mécanisme natif SvelteKit ... et inviter l'utilisateur à recharger"):
//   - svelte.config.js turns on SvelteKit's native update-polling by setting
//     `kit.version.pollInterval` to a reasonable, positive interval (in
//     milliseconds), while leaving `kit.version.name` (roadmap 13.5) intact;
//   - a small component reacts to the `updated` store from `$app/state` (the
//     runes-era API, not the legacy `$app/stores`), showing a dismissible
//     "new version available" banner with a reload control only once
//     `updated.current` flips to true, using theme tokens rather than
//     hardcoded colors;
//   - that component is mounted in the shared app shell (src/routes/
//     +layout.svelte), inside the branch rendered for every page except
//     /login, which keeps its own chrome-free markup;
//   - on a normal boot (no new deploy), the banner does not render — neither
//     on a shell page nor on /login.
//
// What this suite deliberately does NOT do: flip SvelteKit's real `updated`
// store to true and assert the banner then appears. That transition is
// driven by the framework polling its build manifest at runtime; forcing it
// from an HTTP test would mean faking the very mechanism under test, which
// would make the assertion tautological. Instead, the "reacts to `updated`"
// half of the behaviour is verified structurally (the component reads
// `updated.current` from the real `$app/state` module, gates its render on
// it, and exposes a real reload/dismiss control), while the "absent by
// default" half is verified against the real running app below.
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
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TSX_CLI = require.resolve('tsx/cli');
const DRIZZLE_KIT_CLI = path.join(ROOT, 'node_modules', 'drizzle-kit', 'bin.cjs');

const LAYOUT_PATH = path.join(ROOT, 'src', 'routes', '+layout.svelte');
const NOTIFIER_PATH = path.join(ROOT, 'src', 'lib', 'components', 'UpdateNotifier.svelte');

// --- svelte.config.js: native polling is turned on ---------------------------

describe('svelte.config.js configures native SvelteKit update polling (roadmap 13.7)', () => {
	test('kit.version.pollInterval is a reasonable positive interval in milliseconds, and kit.version.name (13.5) is preserved', async () => {
		const mod = await import(pathToFileURL(path.join(ROOT, 'svelte.config.js')).href);
		const { version } = mod.default.kit;

		assert.ok(
			Number.isInteger(version.pollInterval) && version.pollInterval > 0,
			`expected kit.version.pollInterval to be a positive integer number of milliseconds, got ${version.pollInterval}`
		);
		// "Reasonable" per the task's own examples (60s to 5min): generously
		// bound it between 30s and 15min so this doesn't overfit one exact value.
		assert.ok(
			version.pollInterval >= 30 * 1000 && version.pollInterval <= 15 * 60 * 1000,
			`expected kit.version.pollInterval to be between 30s and 15min, got ${version.pollInterval}ms`
		);

		assert.equal(typeof version.name, 'string');
		assert.ok(version.name.length > 0, 'kit.version.name (roadmap 13.5) must still be set');
	});
});

// --- UpdateNotifier.svelte: structural wiring --------------------------------

describe('the update-notification component reacts to $app/state\'s `updated` store (roadmap 13.7)', () => {
	let source;

	before(() => {
		source = fs.readFileSync(NOTIFIER_PATH, 'utf8');
	});

	test('imports `updated` from the runes-era `$app/state`, not the legacy `$app/stores`', () => {
		assert.match(
			source,
			/import\s*{\s*[^}]*\bupdated\b[^}]*}\s*from\s*['"]\$app\/state['"]/,
			'expected a named import of `updated` from "$app/state"'
		);
		assert.doesNotMatch(
			source,
			/from\s*['"]\$app\/stores['"]/,
			'must not use the legacy $app/stores API'
		);
	});

	test('the banner render is gated on `updated.current`', () => {
		assert.match(
			source,
			/updated\.current/,
			'expected the component to branch its rendering on `updated.current`'
		);
	});

	test('the reload control triggers the idiomatic reload flow (location.reload())', () => {
		assert.match(source, /location\.reload\(\)/, 'expected a call to location.reload()');
	});

	test('the banner can be dismissed/ignored', () => {
		assert.match(
			source,
			/aria-label\s*=\s*["'][^"']*(dismiss|ignore|close)[^"']*["']/i,
			'expected a dismiss/ignore control with an accessible label'
		);
	});

	test('the banner copy is in English, per the project\'s language policy', () => {
		assert.match(source, /A new version is available/);
	});

	test('an information banner that appears asynchronously (unlike the static SSR "archived" banner) uses a live region', () => {
		assert.match(
			source,
			/role\s*=\s*["'](status|alert)["']/,
			'expected a live-region role (status/alert) on the transient update banner'
		);
	});

	test('styling uses theme tokens, not hardcoded colors', () => {
		const styleMatch = source.match(/<style>([\s\S]*)<\/style>/);
		assert.ok(styleMatch, 'expected a <style> block');
		const css = styleMatch[1];

		assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'expected no hardcoded hex colors in the banner styles');
		assert.doesNotMatch(
			css,
			/\b(rgb|rgba|hsl|hsla)\(/,
			'expected no hardcoded rgb()/hsl() color literals in the banner styles'
		);
		assert.match(css, /var\(--color-/, 'expected the banner styles to reference theme color tokens');
	});
});

// --- +layout.svelte: mounted on the shell branch, not on /login -------------

describe('the update notifier is mounted in the app shell, not on the chrome-free /login branch (roadmap 13.7)', () => {
	let layoutSource;

	before(() => {
		layoutSource = fs.readFileSync(LAYOUT_PATH, 'utf8');
	});

	test('the layout imports UpdateNotifier', () => {
		assert.match(
			layoutSource,
			/import\s+UpdateNotifier\s+from\s*['"]\$lib\/components\/UpdateNotifier\.svelte['"]/,
			'expected +layout.svelte to import UpdateNotifier from $lib/components/UpdateNotifier.svelte'
		);
	});

	test('<UpdateNotifier /> is rendered in the shell branch, not in the isAuthPage (/login) branch', () => {
		const ifIdx = layoutSource.indexOf('{#if isAuthPage}');
		const elseIdx = layoutSource.indexOf('{:else}', ifIdx);
		const endIfIdx = layoutSource.lastIndexOf('{/if}');

		assert.ok(ifIdx !== -1 && elseIdx !== -1 && endIfIdx !== -1 && ifIdx < elseIdx && elseIdx < endIfIdx,
			'expected to find the {#if isAuthPage} ... {:else} ... {/if} structure in +layout.svelte');

		const authBranch = layoutSource.slice(ifIdx, elseIdx);
		const shellBranch = layoutSource.slice(elseIdx, endIfIdx);

		assert.doesNotMatch(
			authBranch,
			/<UpdateNotifier\b/,
			'the /login (isAuthPage) branch must not mount UpdateNotifier'
		);
		assert.match(
			shellBranch,
			/<UpdateNotifier\b/,
			'the app-shell branch (rendered on every non-/login page) must mount UpdateNotifier'
		);
	});
});

// --- real app boot: the banner is absent on a normal (no-update) boot -------

const TEST_PASSWORD = 'correct horse battery staple';
const TEST_SESSION_SECRET = 'w'.repeat(32);
const STARTUP_TIMEOUT_MS = 30 * 1000;
const SHUTDOWN_TIMEOUT_MS = 5 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;
const BANNER_TEXT = 'A new version is available';

// Mirrors the harness in tests/footer-version-display.test.cjs / tests/
// app-versioning.test.cjs: a real Vite dev server against a throwaway app
// copy (node_modules brought in via a directory junction), bound to an OS-
// assigned ephemeral port, so this suite never touches the shared repo root
// and can run concurrently with the rest of `node --test tests/`.
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

async function startApp(appDir, env) {
	const port = await getEphemeralPort();
	const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-update-banner-harness-'));
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
// dangling once the dev server under test is killed; see tests/access-guard-
// and-logout.test.cjs for the full rationale. Surfaces the socket 'timeout'/
// 'error' events so a hung/broken request reports its real cause instead of
// hanging the suite.
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

function cookiePair(setCookieHeader) {
	return setCookieHeader.split(';')[0];
}

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

describe('on a normal boot (no new deploy detected), the update banner does not render (roadmap 13.7)', () => {
	let appDir;
	let app;
	let workDir;
	let cookie;

	before(async () => {
		appDir = buildIsolatedAppCopy('distil-update-banner-app-');
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-update-banner-data-'));
		const dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);

		app = await startApp(appDir, {
			APP_PASSWORD: TEST_PASSWORD,
			SESSION_SECRET: TEST_SESSION_SECRET,
			DATABASE_PATH: dbPath
		});
		cookie = await login(app.baseUrl);
	});

	after(async () => {
		if (app) await app.stop();
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
		if (appDir) cleanupAppCopy(appDir);
	});

	for (const route of ['/', '/kb', '/bookmarks']) {
		test(`GET ${route} renders the shell without the update banner`, async () => {
			const res = await fetch(`${app.baseUrl}${route}`, { headers: { cookie } });
			assert.equal(res.status, 200, `expected 200 from ${route}, got ${res.status}`);
			const html = await res.text();

			assert.match(html, /class="app-shell(\s|")/, `expected the app shell to render on ${route}`);
			assert.doesNotMatch(
				html,
				new RegExp(BANNER_TEXT),
				`expected no update banner on a normal boot for ${route}, got:\n${html}`
			);
		});
	}

	test('GET /login (no session) never shows the update banner: the auth page has no shell chrome', async () => {
		const res = await fetch(`${app.baseUrl}/login`, { redirect: 'manual' });
		assert.equal(res.status, 200, 'expected the login page itself to render directly');
		const html = await res.text();

		assert.doesNotMatch(html, /class="app-shell(\s|")/, 'expected no app shell on /login');
		assert.doesNotMatch(
			html,
			new RegExp(BANNER_TEXT),
			`expected no update banner on /login, got:\n${html}`
		);
	});
});
