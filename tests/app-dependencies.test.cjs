// Verifies task 1.3 of docs/ROADMAP.md (section "1. Fondations du projet"):
// the application dependencies listed there must be added to the project
// (better-sqlite3, drizzle-orm, drizzle-kit, simple-git, gray-matter,
// marked, syntax highlighting for code blocks, and an HTML sanitizer),
// split coherently between dependencies/devDependencies, with a
// package-lock.json kept in sync, and the whole thing must still install
// (including native compilation of better-sqlite3), build and typecheck
// on Node 20.17. The task explicitly forbids adding application code: this
// is an install-only task.
//
// The dynamic checks (install/build/check/native module) operate on an
// isolated copy of the project rather than the repo root, mirroring
// tests/adapter-node.test.cjs, so this suite doesn't race with the other
// test files that also run `npm install` / `npm run build` concurrently
// under `node --test tests/`.
//
// Run with: node --test tests/
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

const RUNTIME_DEPS = [
	'better-sqlite3',
	'drizzle-orm',
	'simple-git',
	'gray-matter',
	'marked',
	'highlight.js',
	'marked-highlight',
	'isomorphic-dompurify'
];

const DEV_DEPS = ['drizzle-kit'];

function readJson(relPath) {
	return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function readText(relPath) {
	return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function exists(relPath) {
	return fs.existsSync(path.join(ROOT, relPath));
}

test('every requested runtime library is a dependency (not devDependency)', () => {
	const pkg = readJson('package.json');

	for (const name of RUNTIME_DEPS) {
		assert.ok(
			pkg.dependencies && name in pkg.dependencies,
			`${name} should be listed in "dependencies"`
		);
		assert.ok(
			!(pkg.devDependencies && name in pkg.devDependencies),
			`${name} is a runtime library and should not also/only be a devDependency`
		);
	}
});

test('drizzle-kit (migration tooling) is a devDependency, not a runtime dependency', () => {
	const pkg = readJson('package.json');

	for (const name of DEV_DEPS) {
		assert.ok(
			pkg.devDependencies && name in pkg.devDependencies,
			`${name} should be listed in "devDependencies"`
		);
		assert.ok(
			!(pkg.dependencies && name in pkg.dependencies),
			`${name} is dev tooling and should not also be a runtime dependency`
		);
	}
});

test('better-sqlite3 type definitions are installed as a devDependency', () => {
	const pkg = readJson('package.json');

	assert.ok(
		pkg.devDependencies && '@types/better-sqlite3' in pkg.devDependencies,
		'@types/better-sqlite3 should be a devDependency since better-sqlite3 ships no bundled types'
	);
});

test('package-lock.json is in sync with package.json for every new dependency', () => {
	const pkg = readJson('package.json');
	const lock = readJson('package-lock.json');
	const rootManifest = lock.packages?.[''] ?? {};

	for (const name of [...RUNTIME_DEPS, ...DEV_DEPS, '@types/better-sqlite3']) {
		const declaredInPkg = Boolean(
			(pkg.dependencies && name in pkg.dependencies) ||
				(pkg.devDependencies && name in pkg.devDependencies)
		);
		assert.ok(declaredInPkg, `${name} should be declared in package.json`);

		const declaredInLockManifest = Boolean(
			(rootManifest.dependencies && name in rootManifest.dependencies) ||
				(rootManifest.devDependencies && name in rootManifest.devDependencies)
		);
		assert.ok(
			declaredInLockManifest,
			`package-lock.json root manifest should list ${name}`
		);

		assert.ok(
			`node_modules/${name}` in (lock.packages ?? {}),
			`package-lock.json should have a resolved entry for ${name}`
		);
	}
});

test('the ROADMAP checks off task 1.3 (application dependencies)', () => {
	const roadmap = readText('docs/ROADMAP.md');
	const line = roadmap.split('\n').find((l) => /\*\*1\.3\*\*/.test(l));

	assert.ok(line, 'expected to find the "1.3" task line in docs/ROADMAP.md');
	assert.match(line, /^- \[x\]/i, 'task 1.3 must be checked off');
});

describe('npm install / build / check with the new dependencies, in an isolated copy of the project', () => {
	// Isolated in its own temp directory so this suite doesn't race with the
	// other test files, which also run `npm install` / `npm run build`
	// directly and would otherwise corrupt this suite's
	// node_modules/.svelte-kit/build output when run concurrently under
	// `node --test`.
	let workDir;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-app-deps-'));

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

	test('npm install succeeds, including native compilation of better-sqlite3', () => {
		const result = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
			cwd: workDir,
			encoding: 'utf8',
			timeout: 5 * 60 * 1000
		});

		assert.equal(result.status, 0, `npm install failed:\n${result.stdout}\n${result.stderr}`);

		for (const name of [...RUNTIME_DEPS, ...DEV_DEPS]) {
			assert.ok(
				fs.existsSync(path.join(workDir, 'node_modules', name)),
				`node_modules/${name} should exist after npm install`
			);
		}

		// better-sqlite3 ships a native addon that must be compiled/downloaded
		// for the current Node ABI (Node 20.17 here); its presence is the
		// concrete signal that native compilation actually succeeded.
		const buildReleaseDir = path.join(workDir, 'node_modules/better-sqlite3/build/Release');
		assert.ok(
			fs.existsSync(buildReleaseDir) &&
				fs.readdirSync(buildReleaseDir).some((f) => f.endsWith('.node')),
			'better-sqlite3 should have a compiled native .node binary under build/Release'
		);
	});

	test('better-sqlite3 is actually usable at runtime on this Node version', () => {
		const result = spawnSync(
			'node',
			[
				'-e',
				"const Database = require('better-sqlite3'); " +
					"const db = new Database(':memory:'); " +
					"db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)'); " +
					"db.prepare('INSERT INTO t (v) VALUES (?)').run('ok'); " +
					"const row = db.prepare('SELECT v FROM t WHERE id = 1').get(); " +
					"if (row.v !== 'ok') { throw new Error('unexpected row: ' + JSON.stringify(row)); } " +
					"console.log('better-sqlite3-ok');"
			],
			{ cwd: workDir, encoding: 'utf8', timeout: 30 * 1000 }
		);

		assert.equal(
			result.status,
			0,
			`better-sqlite3 smoke test failed:\n${result.stdout}\n${result.stderr}`
		);
		assert.match(result.stdout, /better-sqlite3-ok/);
	});

	test('npm run build still succeeds with the new dependencies installed', () => {
		const result = spawnSync('npm', ['run', 'build'], {
			cwd: workDir,
			encoding: 'utf8',
			timeout: 5 * 60 * 1000
		});

		assert.equal(result.status, 0, `npm run build failed:\n${result.stdout}\n${result.stderr}`);
	});

	test('npm run check still succeeds with the new dependencies installed', () => {
		const result = spawnSync('npm', ['run', 'check'], {
			cwd: workDir,
			encoding: 'utf8',
			timeout: 5 * 60 * 1000
		});

		assert.equal(result.status, 0, `npm run check failed:\n${result.stdout}\n${result.stderr}`);
	});
});
