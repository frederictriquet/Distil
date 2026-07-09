// Shared helpers for the test suites. This file is NOT a test file (its name
// does not match the `*.test.*` discovery convention), so `npm test`
// (`node --test`) never runs it directly.
//
// File: tests/helpers.cjs
// Loaded by the tests/*.test.cjs suites; run them with: npm test
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

// On Windows npm ships as npm.cmd, and since the CVE-2024-27980 fix (Node
// >=20.12.2, which the engines field mandates) child_process refuses to spawn
// a .cmd/.bat file without a shell, failing with EINVAL. Running through a
// shell lets the OS resolve the right `npm` executable on every platform; the
// argument lists below are static tokens with no spaces or shell
// metacharacters, so no quoting is required.
const NPM = 'npm';

// Per-step spawn timeouts. `npm install` bundles a native better-sqlite3
// node-gyp compile, which on a cold cache or a slow runner can take several
// minutes, so it gets a much larger budget than the pure JS build/check steps.
const INSTALL_TIMEOUT_MS = 12 * 60 * 1000;
const STEP_TIMEOUT_MS = 5 * 60 * 1000;

// Sibling fixtures older than this are assumed to belong to long-finished runs
// and are removed to bound disk use. It is far longer than any concurrent run
// so it never evicts a fixture a parallel `npm test` is still reading.
const EVICTION_AGE_MS = 24 * 60 * 60 * 1000;

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
function runNpm(args, cwd, timeout = STEP_TIMEOUT_MS) {
	const result = spawnSync(NPM, args, {
		cwd,
		encoding: 'utf8',
		shell: true,
		timeout
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

// Fold a path (and its contents, for directories) into a hash so the fixture
// key changes whenever any copied source or config changes. Directory entries
// are walked in a stable, sorted order; a missing entry is recorded as such so
// adding or removing one also changes the key.
function hashEntryInto(hash, absPath, relPath) {
	let stat;
	try {
		stat = fs.statSync(absPath);
	} catch {
		hash.update(`\0missing\0${relPath}`);
		return;
	}
	if (stat.isDirectory()) {
		hash.update(`\0dir\0${relPath}`);
		for (const name of fs.readdirSync(absPath).sort()) {
			hashEntryInto(hash, path.join(absPath, name), `${relPath}/${name}`);
		}
	} else {
		hash.update(`\0file\0${relPath}\0`);
		hash.update(fs.readFileSync(absPath));
	}
}

// Key the fixture on the content of every copied project entry (not just
// package-lock.json): a source or config change with no lockfile change must
// force a rebuild instead of validating a stale install+build+check. The repo
// path is folded in too so two worktrees with identical sources (the /tmp/wt-*
// orchestrator setup) never share one fixture and validate each other's build.
function projectFixtureHash() {
	const hash = crypto.createHash('sha1');
	hash.update(`\0root\0${ROOT}`);
	// Fold in the Node ABI so a fixture built under one Node is never reused
	// under another: better-sqlite3 is compiled natively during install, and a
	// NODE_MODULE_VERSION mismatch would otherwise make the smoke tests fail
	// spuriously when `npm test` runs on a different Node than the fixture.
	hash.update(`\0nodeabi\0${process.versions.modules}\0${process.version}`);
	for (const entry of PROJECT_ENTRIES) {
		hashEntryInto(hash, path.join(ROOT, entry), entry);
	}
	return hash.digest('hex').slice(0, 12);
}

// Remove abandoned sibling fixtures/locks from previous runs to bound disk use.
// Only entries older than EVICTION_AGE_MS are touched, so a fixture a parallel
// `npm test` is still using (minutes old) is never removed.
function evictStaleFixtures(keepDir, keepLock) {
	const tmp = os.tmpdir();
	let entries;
	try {
		entries = fs.readdirSync(tmp);
	} catch {
		return;
	}
	const now = Date.now();
	for (const name of entries) {
		if (!name.startsWith('distil-test-fixture-')) {
			continue;
		}
		const abs = path.join(tmp, name);
		if (abs === keepDir || abs === keepLock) {
			continue;
		}
		let mtimeMs;
		try {
			mtimeMs = fs.statSync(abs).mtimeMs;
		} catch {
			continue;
		}
		if (now - mtimeMs > EVICTION_AGE_MS) {
			fs.rmSync(abs, { recursive: true, force: true });
		}
	}
}

let cachedFixture = null;

// Build (or reuse) the single shared install/build/check fixture and return
// { dir, buildStdout }. Coordination is cross-process because `node --test`
// runs each test file in its own process: the first process to atomically
// claim a lock directory does the install + build + check once; the others
// wait for the ready sentinel and reuse the result. The fixture is keyed on a
// content hash of every copied project entry (see projectFixtureHash) so any
// source or config change forces a rebuild rather than silently reusing a
// stale install/build, and so separate worktrees never share one fixture.
function useSharedFixture() {
	if (cachedFixture) {
		return cachedFixture;
	}

	const fixtureHash = projectFixtureHash();
	const fixtureDir = path.join(os.tmpdir(), `distil-test-fixture-${fixtureHash}`);
	const readyFile = path.join(fixtureDir, '.fixture-ready.json');
	const failedFile = path.join(fixtureDir, '.fixture-failed.json');
	const lockDir = path.join(os.tmpdir(), `distil-test-fixture-${fixtureHash}.lock`);

	// Generous overall bound so a crashed builder surfaces as a clear timeout
	// rather than an infinite hang, while never firing on a healthy build. It
	// exceeds the worst-case install+build+check step budget below.
	const overallDeadline = Date.now() + 25 * 60 * 1000;
	// A lock older than the worst-case install+build+check (install +
	// build + check step timeouts) is assumed to belong to a dead builder and
	// is reclaimed.
	const staleLockMs = INSTALL_TIMEOUT_MS + STEP_TIMEOUT_MS + STEP_TIMEOUT_MS;

	for (;;) {
		if (fs.existsSync(readyFile)) {
			cachedFixture = { dir: fixtureDir, ...JSON.parse(fs.readFileSync(readyFile, 'utf8')) };
			return cachedFixture;
		}
		// If a builder in THIS run already failed, fail fast with its recorded
		// cause instead of having each remaining suite serially re-run the whole
		// install+build. Stamped with the shared parent pid (the `node --test`
		// runner) so a sentinel left by a previous run is ignored — a fresh
		// builder will wipe and rebuild it below.
		if (fs.existsSync(failedFile)) {
			let failure = null;
			try {
				failure = JSON.parse(fs.readFileSync(failedFile, 'utf8'));
			} catch {
				failure = null;
			}
			if (failure && failure.ppid === process.ppid) {
				assert.fail(`shared install/build fixture failed earlier in this run: ${failure.error}`);
			}
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
				evictStaleFixtures(fixtureDir, lockDir);
				fs.rmSync(fixtureDir, { recursive: true, force: true });
				fs.mkdirSync(fixtureDir, { recursive: true });
				copyProjectInto(fixtureDir);

				const install = runNpm(
					['install', '--no-audit', '--no-fund'],
					fixtureDir,
					INSTALL_TIMEOUT_MS
				);
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
			} catch (err) {
				// Record the failure so the other waiting suites fail fast with the
				// same cause rather than each re-running the full install+build.
				try {
					fs.mkdirSync(fixtureDir, { recursive: true });
					fs.writeFileSync(
						failedFile,
						JSON.stringify({ ppid: process.ppid, error: String((err && err.message) || err) })
					);
				} catch {
					// Best effort; the rethrow below still reports the real cause.
				}
				throw err;
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
