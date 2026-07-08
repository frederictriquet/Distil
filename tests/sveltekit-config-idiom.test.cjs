// Verifies the BACKLOG.md item 'sveltekit-config-idiom': the SvelteKit
// configuration (adapter-node as kit.adapter, and the compilerOptions.runes
// function forcing runes mode everywhere except under node_modules) must
// live in a conventional svelte.config.js at the repo root, instead of
// being passed inline to sveltekit() in vite.config.ts. vite.config.ts must
// be simplified back down to a bare `sveltekit()` call with no inline
// options, relying on the plugin's default svelte.config.js discovery.
// The existing behavior must be strictly preserved: `npm run build` must
// still select @sveltejs/adapter-node and produce a standalone Node server
// in build/, and `npm run check` must still pass with 0 errors.
//
// The dynamic checks (install/build/check) operate on an isolated copy of
// the project rather than the repo root, mirroring
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
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');

function readText(relPath) {
	return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function exists(relPath) {
	return fs.existsSync(path.join(ROOT, relPath));
}

test('svelte.config.js exists at the repo root', () => {
	assert.ok(exists('svelte.config.js'), 'expected a conventional svelte.config.js at the repo root');
});

test('vite.config.ts calls sveltekit() with no inline configuration', () => {
	const source = readText('vite.config.ts');

	assert.match(
		source,
		/sveltekit\(\s*\)/,
		'vite.config.ts should call sveltekit() with no arguments, letting it read svelte.config.js'
	);
	assert.doesNotMatch(
		source,
		/compilerOptions/,
		'vite.config.ts should no longer carry compilerOptions inline'
	);
	assert.doesNotMatch(
		source,
		/adapter-node|from ['"]@sveltejs\/adapter-node['"]/,
		'vite.config.ts should no longer import/reference the adapter directly'
	);
});

test('svelte.config.js exports kit.adapter wired to @sveltejs/adapter-node', async () => {
	const config = (await import(pathToFileURL(path.join(ROOT, 'svelte.config.js')).href)).default;

	assert.ok(config.kit, 'expected a "kit" key in the exported config');
	assert.ok(config.kit.adapter, 'expected kit.adapter to be set');
	assert.equal(
		config.kit.adapter.name,
		'@sveltejs/adapter-node',
		'kit.adapter must be produced by @sveltejs/adapter-node'
	);
});

test('svelte.config.js forces runes mode, except for files under node_modules', async () => {
	const config = (await import(pathToFileURL(path.join(ROOT, 'svelte.config.js')).href)).default;

	const runes = config.compilerOptions && config.compilerOptions.runes;
	assert.equal(typeof runes, 'function', 'expected compilerOptions.runes to be a function');

	assert.equal(
		runes({ filename: '/repo/src/lib/Foo.svelte' }),
		true,
		'runes must be forced to true for project source files'
	);
	assert.equal(
		runes({ filename: '/repo/node_modules/some-lib/Foo.svelte' }),
		undefined,
		'runes must be left undefined (library default) for files under node_modules (POSIX path)'
	);
	assert.equal(
		runes({ filename: 'C:\\repo\\node_modules\\some-lib\\Foo.svelte' }),
		undefined,
		'runes must be left undefined (library default) for files under node_modules (Windows path)'
	);
});

test('the BACKLOG.md item sveltekit-config-idiom is checked off', () => {
	const backlog = readText('BACKLOG.md');
	const line = backlog.split('\n').find((l) => l.includes('sveltekit-config-idiom'));

	assert.ok(line, 'expected to find the sveltekit-config-idiom line in BACKLOG.md');
	assert.match(line, /^- \[x\]/i, 'sveltekit-config-idiom must be checked off');
});

describe('npm run build / check still work from the conventional svelte.config.js, in an isolated copy', () => {
	let workDir;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-sveltekit-config-idiom-'));

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
		const result = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
			cwd: workDir,
			encoding: 'utf8',
			timeout: 5 * 60 * 1000
		});

		assert.equal(result.status, 0, `npm install failed:\n${result.stdout}\n${result.stderr}`);
	});

	test('npm run build still selects adapter-node and produces a standalone server entry point', () => {
		const result = spawnSync('npm', ['run', 'build'], {
			cwd: workDir,
			encoding: 'utf8',
			timeout: 5 * 60 * 1000
		});

		assert.equal(result.status, 0, `npm run build failed:\n${result.stdout}\n${result.stderr}`);
		assert.match(
			result.stdout,
			/Using @sveltejs\/adapter-node/,
			'build output should confirm adapter-node was selected via svelte.config.js'
		);
		assert.ok(
			fs.existsSync(path.join(workDir, 'build/index.js')),
			'build/index.js entry point must exist after build'
		);
	});

	test('npm run check still passes with 0 errors', () => {
		const result = spawnSync('npm', ['run', 'check'], {
			cwd: workDir,
			encoding: 'utf8',
			timeout: 5 * 60 * 1000
		});

		assert.equal(result.status, 0, `npm run check failed:\n${result.stdout}\n${result.stderr}`);
	});

	test('runes mode is still enforced end-to-end: legacy `export let` props fail svelte-check', () => {
		// Adds a component using Svelte 4-style legacy prop syntax, which is
		// only rejected by svelte-check when runes mode is actually forced on
		// for project files (as opposed to merely present, unused, in
		// svelte.config.js). Proves the runes behavior survived the move out
		// of vite.config.ts, through the real `npm run check` entry point.
		const legacyDir = path.join(workDir, 'src/lib');
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(
			path.join(legacyDir, 'LegacyProps.svelte'),
			'<script>\n\texport let label;\n</script>\n\n<span>{label}</span>\n'
		);
		fs.writeFileSync(
			path.join(legacyDir, 'LegacyPropsHost.svelte'),
			"<script>\n\timport LegacyProps from './LegacyProps.svelte';\n</script>\n\n<LegacyProps label=\"hi\" />\n"
		);

		const result = spawnSync('npm', ['run', 'check'], {
			cwd: workDir,
			encoding: 'utf8',
			timeout: 5 * 60 * 1000
		});

		assert.equal(
			result.error,
			undefined,
			`npm run check could not be spawned or timed out, so it never actually ran: ${result.error}`
		);
		assert.notEqual(
			result.status,
			0,
			`expected npm run check to fail on legacy (non-runes) prop syntax, but it passed:\n${result.stdout}\n${result.stderr}`
		);
		assert.match(
			result.stdout + result.stderr,
			/LegacyProps\.svelte/,
			'svelte-check output must point at the legacy component, proving it actually analyzed it'
		);
		assert.match(
			result.stdout + result.stderr,
			/export let.*runes mode|legacy_export_invalid/i,
			'svelte-check output must report the runes-mode rejection of `export let`, not an unrelated failure'
		);
	});
});
