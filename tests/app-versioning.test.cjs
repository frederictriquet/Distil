// tests/app-versioning.test.cjs
//
// Verifies roadmap task 13.5 ("Mettre en place le versionnage de
// l'application"): package.json's `version` is the SemVer source of truth,
// combined at build time with the short commit SHA into a runtime version
// string "<semver>+<shortSha>" (svelte.config.js's `kit.version.name`), with a
// working fallback (env var override) when git is unavailable so the build
// never fails outside a checkout (e.g. a Docker build with `.git` excluded
// from the context) -- and that the resulting version is exposed through a
// consumable access point (the `/api/version` endpoint).
//
// Every check here runs svelte.config.js (or the full production build) out
// of process, against either the real project checkout or a throwaway
// `mkdtempSync` copy that deliberately excludes `.git`, so this suite never
// mutates the real repository (no stray tags, no build/ churn in the shared
// tree) and can run concurrently with the rest of `node --test tests/`.
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
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readPkgVersion(root) {
	return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

/** Run a git subcommand, surfacing spawn/exit failures instead of hanging or masking them. */
function runGit(args, cwd) {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30 * 1000 });
	if (result.error) {
		throw new Error(`git ${args.join(' ')} failed to spawn: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`git ${args.join(' ')} exited with ${result.status}:\n${result.stdout}\n${result.stderr}`);
	}
	return result;
}

// --- svelte.config.js resolution harness ------------------------------------
//
// svelte.config.js computes `kit.version.name` as a side effect of being
// imported (it calls out to `git` and reads package.json inline). This tiny
// ESM harness imports a given svelte.config.js path in a fresh process (so
// each case gets its own cwd/env, never mutating this test process's own
// environment) and reports the resolved `kit.version.name` back over stdout.
const CONFIG_HARNESS_SOURCE = `
import { pathToFileURL } from 'node:url';

const [, , configPath] = process.argv;
const mod = await import(pathToFileURL(configPath).href);
process.stdout.write(JSON.stringify({ versionName: mod.default.kit.version.name }));
`;

let configHarnessDir;
let configHarnessPath;

before(() => {
	configHarnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-version-cfg-harness-'));
	configHarnessPath = path.join(configHarnessDir, 'config-harness.mjs');
	fs.writeFileSync(configHarnessPath, CONFIG_HARNESS_SOURCE, 'utf8');
});

after(() => {
	if (configHarnessDir) fs.rmSync(configHarnessDir, { recursive: true, force: true });
});

/** Import `configPath` in a fresh process, with `overrides` as the only GIT_SHA/APP_VERSION env. */
function resolveConfigVersionName(configPath, cwd, overrides = {}) {
	const env = { ...process.env };
	delete env.GIT_SHA;
	delete env.APP_VERSION;
	Object.assign(env, overrides);

	const result = spawnSync(process.execPath, [configHarnessPath, configPath], {
		cwd,
		encoding: 'utf8',
		timeout: 30 * 1000,
		env
	});

	if (result.error) {
		throw new Error(`importing ${configPath} failed to spawn: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`importing ${configPath} exited with ${result.status}:\n${result.stdout}\n${result.stderr}`);
	}
	return JSON.parse(result.stdout.trim()).versionName;
}

// --- Isolated app copy (no .git) --------------------------------------------
//
// Mirrors the pattern in tests/db-auto-migrate-on-boot.test.cjs: a throwaway
// copy of just the files needed to build/run the app, with node_modules
// symlinked ('junction', so no admin/Developer Mode is required on Windows)
// rather than reinstalled. Crucially this copy never includes `.git`, so it
// exercises the exact "build outside a checkout" scenario the task calls out
// (a Docker build with `.git` excluded from the context via .dockerignore).
const APP_COPY_FILES = ['package.json', 'svelte.config.js', 'vite.config.ts', 'tsconfig.json'];
const APP_COPY_DIRS = ['src', 'static', 'drizzle'];

function buildIsolatedAppCopyWithoutGit(prefix) {
	const appDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	for (const file of APP_COPY_FILES) {
		fs.cpSync(path.join(ROOT, file), path.join(appDir, file));
	}
	for (const dir of APP_COPY_DIRS) {
		fs.cpSync(path.join(ROOT, dir), path.join(appDir, dir), { recursive: true });
	}
	fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(appDir, 'node_modules'), 'junction');

	assert.equal(fs.existsSync(path.join(appDir, '.git')), false, 'sanity check: the isolated copy must have no .git directory');
	return appDir;
}

function cleanupAppCopy(appDir) {
	fs.rmSync(path.join(appDir, 'node_modules'), { force: true });
	fs.rmSync(appDir, { recursive: true, force: true });
}

describe('svelte.config.js resolves kit.version.name from package.json + git/env (roadmap 13.5)', () => {
	let appDir;

	before(() => {
		appDir = buildIsolatedAppCopyWithoutGit('distil-version-cfg-');
	});

	after(() => {
		if (appDir) cleanupAppCopy(appDir);
	});

	test('with no .git and no env override, the build still resolves a version instead of crashing', () => {
		const pkgVersion = readPkgVersion(appDir);
		const versionName = resolveConfigVersionName(path.join(appDir, 'svelte.config.js'), appDir);
		assert.match(
			versionName,
			new RegExp(`^${escapeRegExp(pkgVersion)}\\+.+$`),
			`expected "${pkgVersion}+<some fallback>", got "${versionName}"`
		);
	});

	test('GIT_SHA overrides just the commit SHA suffix; the SemVer part still comes from package.json', () => {
		const pkgVersion = readPkgVersion(appDir);
		const versionName = resolveConfigVersionName(path.join(appDir, 'svelte.config.js'), appDir, {
			GIT_SHA: 'deadbee'
		});
		assert.equal(versionName, `${pkgVersion}+deadbee`);
	});

	test('APP_VERSION overrides the whole version string, taking priority over GIT_SHA and package.json', () => {
		const versionName = resolveConfigVersionName(path.join(appDir, 'svelte.config.js'), appDir, {
			GIT_SHA: 'deadbee',
			APP_VERSION: '9.9.9-custom'
		});
		assert.equal(versionName, '9.9.9-custom');
	});
});

describe('against the real project checkout, with git available', () => {
	test('the resolved version is "<package.json version>+<real short commit SHA>"', () => {
		const pkgVersion = readPkgVersion(ROOT);
		const shaResult = runGit(['rev-parse', '--short', 'HEAD'], ROOT);
		const expectedSha = shaResult.stdout.trim();
		assert.ok(expectedSha.length > 0, 'sanity check: `git rev-parse --short HEAD` must return a non-empty SHA in this checkout');

		const versionName = resolveConfigVersionName(path.join(ROOT, 'svelte.config.js'), ROOT);
		assert.equal(versionName, `${pkgVersion}+${expectedSha}`);
	});
});

describe('npm run build succeeds without a .git directory (the Docker/no-checkout fallback must not fail the build)', () => {
	let appDir;

	before(() => {
		appDir = buildIsolatedAppCopyWithoutGit('distil-version-build-');
	});

	after(() => {
		if (appDir) cleanupAppCopy(appDir);
	});

	function runBuild(env) {
		const result = spawnSync(NPM_BIN, ['run', 'build'], {
			cwd: appDir,
			encoding: 'utf8',
			timeout: 120 * 1000,
			env
		});
		if (result.error) {
			throw new Error(`npm run build failed to spawn: ${result.error.message}`);
		}
		return result;
	}

	function readBuiltVersion() {
		const versionJsonPath = path.join(appDir, 'build', 'client', '_app', 'version.json');
		return JSON.parse(fs.readFileSync(versionJsonPath, 'utf8')).version;
	}

	test(
		'the production build completes with no .git present and no GIT_SHA/APP_VERSION override, and still embeds a version',
		{ timeout: 120 * 1000 },
		() => {
			const env = { ...process.env };
			delete env.GIT_SHA;
			delete env.APP_VERSION;

			const result = runBuild(env);
			assert.equal(result.status, 0, `npm run build must succeed without .git:\n${result.stdout}\n${result.stderr}`);

			const pkgVersion = readPkgVersion(appDir);
			const builtVersion = readBuiltVersion();
			assert.match(
				builtVersion,
				new RegExp(`^${escapeRegExp(pkgVersion)}\\+.+$`),
				`built version.json must still be "${pkgVersion}+<fallback>", got "${builtVersion}"`
			);
		}
	);

	test(
		'a GIT_SHA build-arg embeds the exact SHA into the built version, without a real .git repo',
		{ timeout: 120 * 1000 },
		() => {
			const env = { ...process.env, GIT_SHA: 'cafeb00', APP_VERSION: '' };
			const result = runBuild(env);
			assert.equal(result.status, 0, `npm run build must succeed with GIT_SHA set:\n${result.stdout}\n${result.stderr}`);

			const pkgVersion = readPkgVersion(appDir);
			assert.equal(readBuiltVersion(), `${pkgVersion}+cafeb00`);
		}
	);
});

// --- End-to-end: the /api/version access point ------------------------------

const TEST_PASSWORD = 'correct horse battery staple';
const TEST_SESSION_SECRET = 'y'.repeat(32);
const STARTUP_TIMEOUT_MS = 30 * 1000;
const SHUTDOWN_TIMEOUT_MS = 5 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;

// Boots Vite's dev server programmatically against the isolated app copy,
// bound to a caller-chosen ephemeral port. Mirrors the harness in
// tests/db-auto-migrate-on-boot.test.cjs / tests/access-guard-and-logout.test.cjs.
// SvelteKit's `$app/environment` `version` export is populated from
// `kit.version.name` when Vite loads svelte.config.js, in dev mode exactly as
// at build time, so this exercises the real access point without paying for a
// full production build.
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
	const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-version-web-harness-'));
	const harnessPath = path.join(harnessDir, 'web-harness.mjs');
	fs.writeFileSync(harnessPath, WEB_HARNESS_SOURCE, 'utf8');

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

describe('GET /api/version exposes the build-time application version (roadmap 13.5)', () => {
	let appDir;
	let app;
	let workDir;
	let cookie;

	before(async () => {
		appDir = buildIsolatedAppCopyWithoutGit('distil-version-http-');
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-version-http-data-'));
		const dbPath = path.join(workDir, 'data', 'distil.db');

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

	test('responds 200 with JSON { version } matching "<package.json version>+<something>"', async () => {
		const res = await fetch(`${app.baseUrl}/api/version`, { headers: { cookie } });
		assert.equal(res.status, 200, `expected 200 from /api/version, got ${res.status}`);
		assert.match(res.headers.get('content-type') || '', /application\/json/);

		const body = JSON.parse(await res.text());
		const pkgVersion = readPkgVersion(appDir);
		assert.match(
			body.version,
			new RegExp(`^${escapeRegExp(pkgVersion)}\\+.+$`),
			`expected /api/version's "version" to be "${pkgVersion}+<something>", got ${JSON.stringify(body)}`
		);
	});
});

// --- scripts/version-tag.js (npm run version:tag) ---------------------------

describe('npm run version:tag creates the annotated vX.Y.Z tag matching package.json, without pushing (roadmap 13.5)', () => {
	let fixtureDir;
	let bareRemoteDir;

	before(() => {
		fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-version-tag-fixture-'));
		runGit(['init', '-q'], fixtureDir);
		runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], fixtureDir);

		fs.writeFileSync(
			path.join(fixtureDir, 'package.json'),
			JSON.stringify(
				{
					name: 'distil-version-tag-fixture',
					version: '2.3.4',
					private: true,
					type: 'module',
					scripts: { 'version:tag': 'node scripts/version-tag.js' }
				},
				null,
				'\t'
			),
			'utf8'
		);
		fs.mkdirSync(path.join(fixtureDir, 'scripts'), { recursive: true });
		fs.cpSync(path.join(ROOT, 'scripts', 'version-tag.js'), path.join(fixtureDir, 'scripts', 'version-tag.js'));

		runGit(['add', '-A'], fixtureDir);
		runGit(
			['-c', 'user.name=Distil Test Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'],
			fixtureDir
		);

		// A local bare "origin" so the "no push happens" assertion is a real
		// behavioural check (an absent tag there) rather than just reading the
		// script's source for the absence of a push call.
		bareRemoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-version-tag-remote-'));
		runGit(['init', '-q', '--bare'], bareRemoteDir);
		runGit(['remote', 'add', 'origin', bareRemoteDir], fixtureDir);
		runGit(['push', '-q', 'origin', 'HEAD:refs/heads/main'], fixtureDir);
	});

	after(() => {
		if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
		if (bareRemoteDir) fs.rmSync(bareRemoteDir, { recursive: true, force: true });
	});

	function runVersionTag() {
		const result = spawnSync(NPM_BIN, ['run', 'version:tag'], {
			cwd: fixtureDir,
			encoding: 'utf8',
			timeout: 30 * 1000
		});
		if (result.error) {
			throw new Error(`npm run version:tag failed to spawn: ${result.error.message}`);
		}
		return result;
	}

	test('creates an annotated tag "v2.3.4" pointing at HEAD, matching package.json\'s version', () => {
		const result = runVersionTag();
		assert.equal(result.status, 0, `npm run version:tag must succeed:\n${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /Created annotated tag v2\.3\.4/);

		const tagList = runGit(['tag', '-l'], fixtureDir).stdout.trim().split('\n').filter(Boolean);
		assert.deepEqual(tagList, ['v2.3.4']);

		const tagType = runGit(['cat-file', '-t', 'v2.3.4'], fixtureDir).stdout.trim();
		assert.equal(tagType, 'tag', 'a lightweight tag would report as "commit"; an annotated tag reports its own "tag" object type');

		const headSha = runGit(['rev-parse', 'HEAD'], fixtureDir).stdout.trim();
		const taggedSha = runGit(['rev-parse', 'v2.3.4^{commit}'], fixtureDir).stdout.trim();
		assert.equal(taggedSha, headSha, 'the tag must point at the current HEAD commit');
	});

	test('does not push the tag anywhere: the "origin" remote never receives it', () => {
		const remoteTags = runGit(['ls-remote', '--tags', 'origin'], fixtureDir).stdout.trim();
		assert.equal(remoteTags, '', 'the script must not push the tag to origin (or anywhere else)');
	});

	test('running it again when the tag already exists fails loudly instead of silently overwriting it', () => {
		const result = runVersionTag();
		assert.notEqual(result.status, 0, 'creating an already-existing tag a second time must not report success');
		assert.match(result.stdout + result.stderr, /Failed to create tag v2\.3\.4/);
	});
});
