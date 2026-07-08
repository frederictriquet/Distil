// Verifies task 1.3 of docs/ROADMAP.md (section "1. Fondations du projet"):
// the application dependencies listed there must be added to the project
// (better-sqlite3, drizzle-orm, drizzle-kit, simple-git, gray-matter,
// marked, syntax highlighting for code blocks, and an HTML sanitizer),
// split coherently between dependencies/devDependencies, with a
// package-lock.json kept in sync, and the whole thing must still install
// (including native compilation of better-sqlite3), build and typecheck on
// the pinned Node (22.23.1, see .nvmrc; engines require >=20.19). The task
// explicitly forbids adding application code: this is an install-only task.
//
// The dynamic checks (install/build/check/native module) reuse the shared
// install/build/check fixture from tests/helpers.cjs, so the heavy install
// (native better-sqlite3 compile included) and build happen once for the
// whole `npm test` run instead of once per suite.
//
// Run with: npm test
'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { ROOT, useSharedFixture } = require('./helpers.cjs');

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

describe('the new dependencies install, compile and run in the shared install/build fixture', () => {
	let fixture;

	before(() => {
		fixture = useSharedFixture();
	});

	test('every new dependency is present after install', () => {
		for (const name of [...RUNTIME_DEPS, ...DEV_DEPS]) {
			assert.ok(
				fs.existsSync(path.join(fixture.dir, 'node_modules', name)),
				`node_modules/${name} should exist after npm install`
			);
		}
	});

	test('better-sqlite3 has a compiled native binary for this Node ABI', () => {
		// better-sqlite3 ships a native addon that must be compiled/downloaded
		// for the current Node ABI; a compiled .node binary under build/Release
		// is the concrete signal that native compilation actually succeeded.
		const buildReleaseDir = path.join(fixture.dir, 'node_modules/better-sqlite3/build/Release');
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
			{ cwd: fixture.dir, encoding: 'utf8', timeout: 30 * 1000 }
		);

		assert.equal(
			result.error,
			undefined,
			`the better-sqlite3 smoke test could not be spawned or timed out and never ran: ${result.error}`
		);
		assert.equal(
			result.status,
			0,
			`better-sqlite3 smoke test failed:\n${result.stdout}\n${result.stderr}`
		);
		assert.match(result.stdout, /better-sqlite3-ok/);
	});
});
