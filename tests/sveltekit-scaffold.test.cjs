// Verifies the SvelteKit scaffold requested by docs/ROADMAP.md section 1,
// task 1: TypeScript, minimal/skeleton template, created in place at the
// repo root, without touching pre-existing files, and installable/buildable.
//
// Run with: node --test tests/sveltekit-scaffold.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function readJson(relPath) {
	return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function exists(relPath) {
	return fs.existsSync(path.join(ROOT, relPath));
}

test('scaffold files live at the repo root, not in a subfolder', () => {
	for (const relPath of [
		'package.json',
		'vite.config.ts',
		'tsconfig.json',
		'src/app.html',
		'src/app.d.ts',
		'src/routes/+page.svelte'
	]) {
		assert.ok(exists(relPath), `expected ${relPath} at repo root`);
	}
});

test('pre-existing files were preserved, not deleted or overwritten', () => {
	assert.ok(exists('.git'), '.git must still exist');
	assert.ok(exists('.gitignore'), '.gitignore must still exist');
	assert.ok(exists('docs/ROADMAP.md'), 'docs/ROADMAP.md must still exist');

	const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
	assert.match(
		gitignore,
		/\/data\//,
		'.gitignore should still ignore the local data dir defined before scaffolding'
	);
});

test('the ROADMAP checks off the SvelteKit init task as the first item of section 1', () => {
	const roadmap = fs.readFileSync(path.join(ROOT, 'docs/ROADMAP.md'), 'utf8');
	const section1 = roadmap.split(/^## /m).find((block) => block.startsWith('1. '));
	assert.ok(section1, 'section "1. Fondations du projet" should exist');

	const firstTaskLine = section1
		.split('\n')
		.find((line) => /^- \[[ x]\]/.test(line));
	assert.ok(firstTaskLine, 'section 1 should start with a checkbox task');
	assert.match(
		firstTaskLine,
		/^- \[x\]/i,
		'first task of section 1 (SvelteKit init) must be checked off'
	);
	assert.match(firstTaskLine, /SvelteKit/i);
});

test('TypeScript is enabled for the project', () => {
	const pkg = readJson('package.json');
	assert.ok(
		pkg.devDependencies && pkg.devDependencies.typescript,
		'typescript must be a devDependency'
	);
	assert.ok(exists('tsconfig.json'), 'tsconfig.json must exist');

	// tsconfig.json is JSONC (comments allowed), so it's checked as text
	// rather than parsed with JSON.parse.
	const tsconfigSource = fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8');
	assert.match(
		tsconfigSource,
		/"extends"\s*:\s*".*svelte-kit.*tsconfig\.json"/,
		'tsconfig.json should extend the generated svelte-kit config'
	);

	const appDts = fs.readFileSync(path.join(ROOT, 'src/app.d.ts'), 'utf8');
	assert.match(appDts, /declare global/);
});

test('the template is minimal: no demo app, no optional tooling bundled in', () => {
	const pkg = readJson('package.json');
	const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

	for (const forbidden of ['eslint', 'prettier', '@playwright/test', 'vitest']) {
		assert.ok(
			!(forbidden in allDeps),
			`minimal template should not bundle ${forbidden}`
		);
	}

	// the "demo" SvelteKit template ships extra routes/components (e.g. a
	// Sverdle game); the minimal/skeleton template only has the root route.
	const routesDir = path.join(ROOT, 'src/routes');
	const routeEntries = fs.readdirSync(routesDir);
	assert.deepEqual(
		routeEntries.sort(),
		['+layout.svelte', '+page.svelte'],
		'src/routes should only contain the root layout and page (skeleton template)'
	);

	const pageSource = fs.readFileSync(path.join(ROOT, 'src/routes/+page.svelte'), 'utf8');
	assert.doesNotMatch(pageSource, /counter/i, 'skeleton template page should not include demo widgets');
});

test('npm install succeeds against the committed package-lock.json', () => {
	assert.ok(exists('package-lock.json'), 'package-lock.json must be committed');

	const result = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
		cwd: ROOT,
		encoding: 'utf8',
		timeout: 5 * 60 * 1000
	});

	assert.equal(
		result.status,
		0,
		`npm install failed:\n${result.stdout}\n${result.stderr}`
	);
	assert.ok(exists('node_modules/@sveltejs/kit'), '@sveltejs/kit should be installed');
});

test('npm run build succeeds on the skeleton', () => {
	const result = spawnSync('npm', ['run', 'build'], {
		cwd: ROOT,
		encoding: 'utf8',
		timeout: 5 * 60 * 1000
	});

	assert.equal(
		result.status,
		0,
		`npm run build failed:\n${result.stdout}\n${result.stderr}`
	);
	assert.ok(
		exists('.svelte-kit/output') || exists('build'),
		'build should produce output artifacts'
	);
});
