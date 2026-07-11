// tests/archived-banner-polish.test.cjs
//
// Verifies the two roadmap-12 review nits about the archived/inactive card
// banner rendered by src/lib/components/CardView.svelte:
//   - it must signal an informative, non-error state using the theme's
//     token system (src/app.css custom properties), NOT the danger/error
//     accent token and NOT a hardcoded color literal (the banner reports
//     "this card is archived", which is not a failure);
//   - it must not carry role="status" (an ARIA live region), because the
//     banner is static content rendered once on the server for a page that
//     does not update dynamically -- an unwarranted live region is noise
//     for screen reader users.
//
// The token/no-hardcoded-color and no-role-status checks are done by
// reading the real component source directly: which CSS custom property
// backs the banner's accent, and whether the element carries a `role`
// attribute, are static facts about the component's contract, not runtime
// behavior that requires booting the app to observe. The token is also
// cross-checked against the real theme tokens declared in src/app.css so
// this test would fail if that token were ever removed from the theme.
//
// A second describe block confirms the same absence of role="status" end
// to end, in the actual server-rendered HTML of a deactivated card's page,
// the same way tests/inactive-card-banner.test.cjs confirms the banner
// text itself is present -- so a wrapper or directive reintroducing the
// attribute at render time would still be caught.
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

const CARD_VIEW_PATH = path.join(ROOT, 'src', 'lib', 'components', 'CardView.svelte');
const APP_CSS_PATH = path.join(ROOT, 'src', 'app.css');

describe('archived-card banner styling and markup, in the component source (roadmap 12.1 review nit)', () => {
	const source = fs.readFileSync(CARD_VIEW_PATH, 'utf8');

	const bannerRuleMatch = source.match(/\.fiche__banner\s*\{([^}]*)\}/);
	assert.ok(bannerRuleMatch, 'expected a ".fiche__banner" style rule in CardView.svelte');
	const bannerRule = bannerRuleMatch[1];

	const borderLeftMatch = bannerRule.match(/border-left:\s*([^;]+);/);
	assert.ok(borderLeftMatch, 'expected the ".fiche__banner" rule to set border-left');
	const borderLeftValue = borderLeftMatch[1];

	test('the banner accent is not the danger/error token', () => {
		assert.doesNotMatch(
			borderLeftValue,
			/--color-danger/,
			'the archived-card banner is an informative state, not an error, and must not use --color-danger'
		);
	});

	test('the banner accent is a theme custom property, not a hardcoded color literal', () => {
		assert.match(
			borderLeftValue,
			/var\(--color-[\w-]+\)/,
			'the banner accent must come from the theme token system (a var(--color-*) reference)'
		);
		assert.doesNotMatch(borderLeftValue, /#[0-9a-fA-F]{3,8}/, 'must not hardcode a hex color');
		assert.doesNotMatch(borderLeftValue, /rgba?\(/, 'must not hardcode an rgb()/rgba() color');
	});

	test('the token used for the banner accent is a real token declared in src/app.css', () => {
		const [, tokenName] = borderLeftValue.match(/var\((--color-[\w-]+)\)/);
		const appCss = fs.readFileSync(APP_CSS_PATH, 'utf8');
		assert.match(
			appCss,
			new RegExp(`${tokenName}\\s*:`),
			`expected "${tokenName}" to be declared as a theme token in src/app.css`
		);
	});

	test('the banner element does not carry role="status" in the component source', () => {
		const bannerTagMatch = source.match(/<p class="fiche__banner"[^>]*>/);
		assert.ok(bannerTagMatch, 'expected a <p class="fiche__banner"> element in CardView.svelte');
		assert.doesNotMatch(
			bannerTagMatch[0],
			/role\s*=/,
			'the banner is static SSR content, not a live region, and must not carry a role attribute'
		);
	});
});

// Bootstraps Vite's dev server programmatically, pointed at a throwaway copy
// of this repo's config, bound to a caller-chosen port. See
// tests/access-guard-and-logout.test.cjs for the rationale of every detail
// here (resolving 'vite' from inside the copy's junction-linked node_modules,
// a dedicated cacheDir, etc.) -- this harness is intentionally identical to
// the one in tests/inactive-card-banner.test.cjs.
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

const TEST_PASSWORD = 'correct horse battery staple';
const TEST_SESSION_SECRET = 'z'.repeat(32);
const STARTUP_TIMEOUT_MS = 30 * 1000;
const SHUTDOWN_TIMEOUT_MS = 5 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;

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
	const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-banner-polish-app-copy-'));
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
	const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-banner-polish-web-harness-'));
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

describe('archived-card banner has no role="status" in the real server-rendered page (roadmap 12.2 review nit)', () => {
	let app;
	let workDir;
	let dbPath;
	let cookie;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-banner-polish-db-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);

		withRawDb(dbPath, (raw) => {
			raw
				.prepare('INSERT INTO knowledge_bases (id, name, repo_url, branch, focus) VALUES (1, ?, ?, ?, 0)')
				.run('Fixture KB', 'https://example.test/fixture.git', 'main');
			raw
				.prepare(
					'INSERT INTO cards (id, kb_id, slug, title, theme, level, source_path, content, active) VALUES (41, 1, ?, ?, ?, ?, ?, ?, 0)'
				)
				.run('removed-card', 'Removed Card', 'sql', 'beginner', 'sql/removed.md', 'No longer in the repo.');
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

	test('the served page for a deactivated card carries the banner without a role="status" attribute', async () => {
		const res = await fetch(`${app.baseUrl}/cards/41`, { redirect: 'manual', headers: { cookie } });
		assert.equal(res.status, 200);
		const html = await res.text();

		// Svelte's scoped-styles compiler appends a per-component class (e.g.
		// "s-abc123") after "fiche__banner" in the rendered markup, so the
		// class attribute is not an exact "fiche__banner" match.
		const bannerMatch = html.match(/<p class="fiche__banner[^"]*"[^>]*>/);
		assert.ok(bannerMatch, 'expected the archived-card banner element to be present on the page');
		assert.doesNotMatch(
			bannerMatch[0],
			/role\s*=\s*"?status"?/i,
			'the archived-card banner is static SSR content and must not be rendered as an ARIA live region'
		);
	});
});
