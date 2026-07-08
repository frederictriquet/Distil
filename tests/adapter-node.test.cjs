// Verifies task 1.2 of docs/ROADMAP.md (section "1. Fondations du projet"):
// @sveltejs/adapter-node must be installed and wired in, replacing
// adapter-auto, so that `npm run build` produces a standalone Node server
// in build/ (entry point build/index.js) that can be launched with
// `node build`, and the README must document how to run it.
//
// The dynamic checks (install/build/check/run) operate on an isolated copy
// of the project rather than the repo root: `node --test tests/` runs test
// files concurrently, and several suites each run `npm install` /
// `npm run build`, which would race on a shared node_modules/.svelte-kit/build
// if they all worked out of the repo root.
//
// Run with: node --test tests/
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawnSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// npm ships as npm.cmd on Windows; spawnSync does not resolve it without a
// shell, so pick the right executable name per platform for portability.
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

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

// Reserve a free TCP port on the loopback interface and return it, so the
// spawned server binds to an OS-allocated ephemeral port instead of a
// hardcoded one that could already be in use under concurrent test runs.
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
	// The project wires its SvelteKit adapter either from svelte.config.js
	// (the standard location) or, as this project does since task 1.1, from
	// the sveltekit() plugin options in vite.config.ts. Whichever file
	// defines the adapter must use adapter-node.
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

describe('npm install / build / check / run, in an isolated copy of the project', () => {
	// Isolated in its own temp directory (rather than run against ROOT) so
	// this suite doesn't race with the other test files, which also run
	// `npm install` / `npm run build`; sharing the repo root's
	// node_modules/.svelte-kit/build across suites running concurrently under
	// `node --test` would otherwise corrupt this suite's output.
	let workDir;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-adapter-node-'));

		const entriesToCopy = [
			'package.json',
			'package-lock.json',
			'tsconfig.json',
			'vite.config.ts',
			'svelte.config.js',
			'.npmrc',
			'.nvmrc',
			'src',
			'static'
		].filter(exists);

		for (const entry of entriesToCopy) {
			fs.cpSync(path.join(ROOT, entry), path.join(workDir, entry), { recursive: true });
		}
	});

	after(() => {
		if (workDir) {
			fs.rmSync(workDir, { recursive: true, force: true });
		}
	});

	test('npm install succeeds against the committed package-lock.json', () => {
		const result = runNpm(['install', '--no-audit', '--no-fund'], workDir);

		assert.equal(result.status, 0, `npm install failed:\n${result.stdout}\n${result.stderr}`);
	});

	test('npm run build produces a standalone Node server entry point', () => {
		const result = runNpm(['run', 'build'], workDir);

		assert.equal(result.status, 0, `npm run build failed:\n${result.stdout}\n${result.stderr}`);
		assert.match(
			result.stdout,
			/adapter-node/i,
			'build output should confirm adapter-node was used'
		);
		assert.ok(
			fs.existsSync(path.join(workDir, 'build/index.js')),
			'build/index.js entry point must exist after build'
		);
	});

	test('npm run check still succeeds after switching adapters', () => {
		const result = runNpm(['run', 'check'], workDir);

		assert.equal(result.status, 0, `npm run check failed:\n${result.stdout}\n${result.stderr}`);
	});

	test('`node build` starts a standalone server that responds to HTTP requests', async () => {
		assert.ok(
			fs.existsSync(path.join(workDir, 'build/index.js')),
			'build/ must exist (built by a previous test in this suite)'
		);

		// Bind to an OS-allocated ephemeral port rather than a fixed one, so
		// concurrent test runs (or a leftover process) can't collide on it.
		const port = await getFreePort();
		const child = spawn('node', ['build'], {
			cwd: workDir,
			env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
			stdio: ['ignore', 'pipe', 'pipe']
		});

		let stderr = '';
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString();
		});

		try {
			const statusCode = await new Promise((resolve, reject) => {
				const start = Date.now();
				const retryOrFail = (cause) => {
					if (Date.now() - start > 15000) {
						reject(new Error(`server never became reachable on port ${port}: ${cause}. stderr:\n${stderr}`));
					} else {
						setTimeout(tryConnect, 250);
					}
				};
				const tryConnect = () => {
					const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (res) => {
						res.resume();
						resolve(res.statusCode);
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

			assert.equal(statusCode, 200, 'the standalone server should respond 200 on /');
		} finally {
			child.kill();
		}
	});
});
