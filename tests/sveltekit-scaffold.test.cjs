// Verifies the SvelteKit scaffold requested by docs/ROADMAP.md section 1,
// task 1: TypeScript, minimal/skeleton template, created in place at the
// repo root, without touching pre-existing files, and installable/buildable.
//
// The static checks (files present at the repo root, ROADMAP checkbox, etc.)
// run against ROOT, since they assert the scaffold was created in place. The
// dynamic checks (install/build) operate on an isolated copy of the project
// instead, mirroring the other test files, so this suite never mutates the
// shared repo root and can't race with the other suites that also run
// `npm install` / `npm run build` concurrently under `node --test`.
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

describe('the skeleton installs and builds, in an isolated copy of the project', () => {
	// Isolated in its own temp directory (rather than run against ROOT) so this
	// suite doesn't mutate the shared repo root and can't race with the other
	// test files, which also run `npm install` / `npm run build` concurrently
	// under `node --test`.
	let workDir;

	before(() => {
		assert.ok(exists('package-lock.json'), 'package-lock.json must be committed');

		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-sveltekit-scaffold-'));

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

		assert.equal(
			result.status,
			0,
			`npm install failed:\n${result.stdout}\n${result.stderr}`
		);
		assert.ok(
			fs.existsSync(path.join(workDir, 'node_modules/@sveltejs/kit')),
			'@sveltejs/kit should be installed'
		);
	});

	test('npm run build succeeds on the skeleton', () => {
		const result = runNpm(['run', 'build'], workDir);

		assert.equal(
			result.status,
			0,
			`npm run build failed:\n${result.stdout}\n${result.stderr}`
		);
		assert.ok(
			fs.existsSync(path.join(workDir, '.svelte-kit/output')) ||
				fs.existsSync(path.join(workDir, 'build')),
			'build should produce output artifacts'
		);
	});
});
