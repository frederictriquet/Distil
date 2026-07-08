// Shared helpers for the test suites. This file is NOT a test file (its name
// does not match the `*.test.*` discovery convention), so `npm test`
// (`node --test`) never runs it directly.
//
// It centralises the spawn-error hardening (so the "real cause" reporting
// lives in one place) and provides a single shared install/build/check
// fixture: `node --test` runs each test file in its own process concurrently,
// and several suites need an installed + built copy of the project. Rather
// than each suite running its own full `npm install` (network) + `npm run
// build` + native better-sqlite3 compile — quadruplicating a multi-minute,
// flake-prone cycle — the heavy work happens ONCE per `npm test` run into a
// shared temp directory, and the other processes reuse it.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// npm ships as npm.cmd on Windows; spawnSync does not resolve it without a
// shell, so pick the right executable name per platform for portability.
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// The repo-root entries copied to build an isolated working copy that can be
// installed/built/checked without mutating or racing the shared repo root.
const PROJECT_ENTRIES = [
	'package.json',
	'package-lock.json',
	'tsconfig.json',
	'vite.config.ts',
	'svelte.config.js',
	'.npmrc',
	'.nvmrc',
	'src',
	'static'
];

// Run an npm command and fail loudly (with the real cause) if it could not be
// spawned at all — e.g. ENOENT when npm is missing, or the timeout firing.
// Without this, spawnSync returns { status: null, error: <Error> } and a bare
// `assert.equal(result.status, 0)` reports a misleading "exited null" instead
// of the actual reason.
function runNpm(args, cwd) {
	const result = spawnSync(NPM, args, {
		cwd,
		encoding: 'utf8',
		timeout: 5 * 60 * 1000
	});
	assert.equal(
		result.error,
		undefined,
		`\`npm ${args.join(' ')}\` could not be spawned or timed out and never ran: ${result.error}`
	);
	return result;
}

// Copy the tracked project entries from the repo root into destDir, skipping
// anything that does not exist so the helper stays usable as the scaffold
// evolves.
function copyProjectInto(destDir) {
	for (const entry of PROJECT_ENTRIES) {
		const from = path.join(ROOT, entry);
		if (fs.existsSync(from)) {
			fs.cpSync(from, path.join(destDir, entry), { recursive: true });
		}
	}
}

// Reserve a free TCP port on the loopback interface and return it, so a
// spawned server binds to an OS-allocated ephemeral port instead of a
// hardcoded one that could already be in use under concurrent test runs.
// (There is a residual close-then-rebind window; the server itself binding
// PORT=0 would be fully race-free, but adapter-node's entry point does not
// expose the chosen port, so this is the closest portable approximation.)
function getFreePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close((err) => (err ? reject(err) : resolve(port)));
		});
	});
}

// A synchronous sleep that does not busy-spin the CPU, used only while waiting
// for another process to finish building the shared fixture.
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let cachedFixture = null;

// Build (or reuse) the single shared install/build/check fixture and return
// { dir, buildStdout }. Coordination is cross-process because `node --test`
// runs each test file in its own process: the first process to atomically
// claim a lock directory does the install + build + check once; the others
// wait for the ready sentinel and reuse the result. The fixture is keyed on a
// hash of package-lock.json so a dependency change forces a rebuild rather
// than silently reusing a stale install.
function useSharedFixture() {
	if (cachedFixture) {
		return cachedFixture;
	}

	const lockHash = crypto
		.createHash('sha1')
		.update(fs.readFileSync(path.join(ROOT, 'package-lock.json')))
		.digest('hex')
		.slice(0, 12);
	const fixtureDir = path.join(os.tmpdir(), `distil-test-fixture-${lockHash}`);
	const readyFile = path.join(fixtureDir, '.fixture-ready.json');
	const lockDir = path.join(os.tmpdir(), `distil-test-fixture-${lockHash}.lock`);

	// Generous overall bound so a crashed builder surfaces as a clear timeout
	// rather than an infinite hang, while never firing on a healthy build.
	const overallDeadline = Date.now() + 18 * 60 * 1000;
	// A lock older than the worst-case install+build+check (3 x 5-minute
	// timeouts) is assumed to belong to a dead builder and is reclaimed.
	const staleLockMs = 16 * 60 * 1000;

	for (;;) {
		if (fs.existsSync(readyFile)) {
			cachedFixture = { dir: fixtureDir, ...JSON.parse(fs.readFileSync(readyFile, 'utf8')) };
			return cachedFixture;
		}
		assert.ok(
			Date.now() < overallDeadline,
			`timed out waiting for the shared install/build fixture at ${fixtureDir}`
		);

		let claimed = false;
		try {
			fs.mkdirSync(lockDir);
			claimed = true;
		} catch (err) {
			if (err.code !== 'EEXIST') {
				throw err;
			}
		}

		if (claimed) {
			try {
				fs.rmSync(fixtureDir, { recursive: true, force: true });
				fs.mkdirSync(fixtureDir, { recursive: true });
				copyProjectInto(fixtureDir);

				const install = runNpm(['install', '--no-audit', '--no-fund'], fixtureDir);
				assert.equal(
					install.status,
					0,
					`shared fixture npm install failed:\n${install.stdout}\n${install.stderr}`
				);

				const build = runNpm(['run', 'build'], fixtureDir);
				assert.equal(
					build.status,
					0,
					`shared fixture npm run build failed:\n${build.stdout}\n${build.stderr}`
				);

				const check = runNpm(['run', 'check'], fixtureDir);
				assert.equal(
					check.status,
					0,
					`shared fixture npm run check failed:\n${check.stdout}\n${check.stderr}`
				);

				fs.writeFileSync(readyFile, JSON.stringify({ buildStdout: build.stdout }));
			} finally {
				fs.rmSync(lockDir, { recursive: true, force: true });
			}
			cachedFixture = { dir: fixtureDir, ...JSON.parse(fs.readFileSync(readyFile, 'utf8')) };
			return cachedFixture;
		}

		// Another process holds the lock. Reclaim it only if it is old enough to
		// have been abandoned by a crashed builder, then retry.
		let lockMtime = 0;
		try {
			lockMtime = fs.statSync(lockDir).mtimeMs;
		} catch {
			// The lock vanished between the claim attempt and the stat; retry.
		}
		if (lockMtime && Date.now() - lockMtime > staleLockMs && !fs.existsSync(readyFile)) {
			fs.rmSync(lockDir, { recursive: true, force: true });
			continue;
		}
		sleepSync(250);
	}
}

// Create an isolated, writable copy of the project that reuses the shared
// fixture's already-installed node_modules via a symlink, so a suite can run a
// *mutated* `npm run check` without a second install and without corrupting
// the shared fixture that other suites read concurrently. Returns the copy's
// directory; the caller owns cleanup.
function makeMutableCopyWithSharedModules() {
	const fixture = useSharedFixture();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-mutable-'));
	copyProjectInto(dir);
	fs.symlinkSync(
		path.join(fixture.dir, 'node_modules'),
		path.join(dir, 'node_modules'),
		process.platform === 'win32' ? 'junction' : 'dir'
	);
	return dir;
}

module.exports = {
	ROOT,
	NPM,
	runNpm,
	copyProjectInto,
	getFreePort,
	useSharedFixture,
	makeMutableCopyWithSharedModules
};
