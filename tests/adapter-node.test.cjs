// Verifies task 1.2 of docs/ROADMAP.md (section "1. Fondations du projet"):
// @sveltejs/adapter-node must be installed and wired in, replacing
// adapter-auto, so that `npm run build` produces a standalone Node server
// in build/ (entry point build/index.js) that can be launched with
// `node build`, and the README must document how to run it.
//
// The dynamic checks (build output, running server) operate on the shared
// install/build fixture from tests/helpers.cjs rather than the repo root, so
// this suite neither mutates nor races the shared root and the expensive
// install/build happens once for the whole `npm test` run.
//
// File: tests/adapter-node.test.cjs
// Run with: npm test
'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const { ROOT, getFreePort, useSharedFixture } = require('./helpers.cjs');

function readJson(relPath) {
	return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function exists(relPath) {
	return fs.existsSync(path.join(ROOT, relPath));
}

function readText(relPath) {
	return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('@sveltejs/adapter-node is a dependency and adapter-auto is gone', () => {
	const pkg = readJson('package.json');
	const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

	assert.ok(
		'@sveltejs/adapter-node' in allDeps,
		'@sveltejs/adapter-node must be installed'
	);
	assert.ok(
		!('@sveltejs/adapter-auto' in allDeps),
		'@sveltejs/adapter-auto must no longer be a dependency'
	);
});

test('package-lock.json is in sync (no adapter-auto, adapter-node present)', () => {
	const lock = readJson('package-lock.json');
	const rootDeps = lock.packages?.['']?.devDependencies ?? {};

	assert.ok(
		'@sveltejs/adapter-node' in rootDeps,
		'package-lock.json root manifest should list @sveltejs/adapter-node'
	);
	assert.ok(
		!('@sveltejs/adapter-auto' in rootDeps),
		'package-lock.json root manifest should not list @sveltejs/adapter-auto'
	);
	assert.ok(
		'node_modules/@sveltejs/adapter-node' in (lock.packages ?? {}),
		'package-lock.json should have a resolved entry for @sveltejs/adapter-node'
	);
});

test('the project config imports adapter-node, not adapter-auto', () => {
	// Since task 1.1 the SvelteKit adapter is wired from svelte.config.js (the
	// standard location); vite.config.ts is a bare sveltekit() call. Whichever
	// file defines the adapter must use adapter-node, so check every config
	// that references an adapter at all.
	const candidates = ['svelte.config.js', 'vite.config.ts'].filter(exists);
	assert.ok(candidates.length > 0, 'expected a svelte.config.js or vite.config.ts defining the adapter');

	const configsReferencingAdapter = candidates
		.map((relPath) => ({ relPath, source: readText(relPath) }))
		.filter(({ source }) => /adapter/.test(source));

	assert.ok(
		configsReferencingAdapter.length > 0,
		'no config file references an adapter at all'
	);

	for (const { relPath, source } of configsReferencingAdapter) {
		assert.match(
			source,
			/@sveltejs\/adapter-node/,
			`${relPath} should import @sveltejs/adapter-node`
		);
		assert.doesNotMatch(
			source,
			/@sveltejs\/adapter-auto/,
			`${relPath} should not still reference @sveltejs/adapter-auto`
		);
	}
});

test('the ROADMAP checks off task 1.2 (adapter-node)', () => {
	const roadmap = readText('docs/ROADMAP.md');
	const line = roadmap.split('\n').find((l) => /\*\*1\.2\*\*/.test(l));

	assert.ok(line, 'expected to find the "1.2" task line in docs/ROADMAP.md');
	assert.match(line, /^- \[x\]/i, 'task 1.2 must be checked off');
	assert.match(line, /adapter-node/i);
});

test('the README documents how to run the production Node server', () => {
	const readme = readText('README.md');

	assert.match(readme, /adapter-node/i, 'README should mention adapter-node');
	assert.match(readme, /npm run build/, 'README should mention building the app');
	assert.match(
		readme,
		/node build/,
		'README should document launching the standalone server with `node build`'
	);
});

describe('the built standalone Node server (shared install/build fixture)', () => {
	let fixture;

	before(() => {
		fixture = useSharedFixture();
	});

	test('npm run build produced a standalone Node server entry point', () => {
		assert.match(
			fixture.buildStdout,
			/adapter-node/i,
			'build output should confirm adapter-node was used'
		);
		assert.ok(
			fs.existsSync(path.join(fixture.dir, 'build/index.js')),
			'build/index.js entry point must exist after build'
		);
	});

	test('`node build` starts a standalone server that responds to HTTP requests', async () => {
		assert.ok(
			fs.existsSync(path.join(fixture.dir, 'build/index.js')),
			'build/ must exist (produced by the shared fixture)'
		);

		// Bind to an OS-allocated ephemeral port rather than a fixed one, so
		// concurrent test runs (or a leftover process) can't collide on it.
		const port = await getFreePort();
		const child = spawn('node', ['build'], {
			cwd: fixture.dir,
			env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
			stdio: ['ignore', 'pipe', 'pipe']
		});

		let stderr = '';
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString();
		});

		// A spawn failure emits 'error' and an early crash emits 'exit' on the
		// child; without listeners the former is an uncaught exception that
		// crashes the test process, and the latter would go unnoticed until the
		// full retry window expires. Record both so the probe fails fast with the
		// real cause.
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

		try {
			const response = await new Promise((resolve, reject) => {
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
					const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (res) => {
						res.resume();
						resolve({ statusCode: res.statusCode, location: res.headers.location });
					});
					// A socket timeout does not abort the request on its own; without
					// destroying it here the request would hang and the test would
					// stall instead of retrying, so handle 'timeout' explicitly.
					req.on('timeout', () => {
						req.destroy(new Error('request timed out'));
					});
					req.on('error', (err) => {
						retryOrFail(err.message);
					});
				};
				tryConnect();
			});

			// Since roadmap task 3.3 the access guard protects every non-public
			// route. This server is spawned without APP_PASSWORD/SESSION_SECRET, so
			// an unauthenticated GET / is redirected to the login page rather than
			// served directly — the smoke test just needs a real HTTP response, so
			// assert the guard's 303 → /login contract.
			assert.equal(response.statusCode, 303, 'the standalone server should respond to / (guard redirect)');
			assert.equal(response.location, '/login', 'an unauthenticated / should redirect to /login');
		} finally {
			// child.kill() only sends SIGTERM; wait for the process to actually
			// exit so it can't keep holding the port/files after the test and no
			// orphan is left behind if SIGTERM is slow.
			if (child.exitCode === null && child.signalCode === null) {
				await new Promise((resolve) => {
					child.once('exit', () => resolve());
					child.kill();
				});
			}
		}
	});
});
