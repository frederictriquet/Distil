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
// The dynamic checks reuse the shared install/build/check fixture from
// tests/helpers.cjs (so the heavy install/build happens once for the whole
// `npm test` run); the runes-enforcement check runs in its own writable copy
// that reuses the fixture's node_modules, so it never corrupts the shared
// fixture that other suites read concurrently.
//
// File: tests/sveltekit-config-idiom.test.cjs
// Run with: npm test
'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
	ROOT,
	runNpm,
	useSharedFixture,
	makeMutableCopyWithSharedModules
} = require('./helpers.cjs');

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

describe('the conventional svelte.config.js still drives build and runes enforcement', () => {
	let fixture;

	before(() => {
		fixture = useSharedFixture();
	});

	test('npm run build still selects adapter-node and produces a standalone server entry point', () => {
		assert.match(
			fixture.buildStdout,
			/Using @sveltejs\/adapter-node/,
			'build output should confirm adapter-node was selected via svelte.config.js'
		);
		assert.ok(
			fs.existsSync(path.join(fixture.dir, 'build/index.js')),
			'build/index.js entry point must exist after build'
		);
	});

	test('runes mode is still enforced end-to-end: legacy `export let` props fail svelte-check', () => {
		// Adds a component using Svelte 4-style legacy prop syntax, which is
		// only rejected by svelte-check when runes mode is actually forced on
		// for project files (as opposed to merely present, unused, in
		// svelte.config.js). Proves the runes behavior survived the move out
		// of vite.config.ts, through the real `npm run check` entry point.
		//
		// Runs in its own writable copy (reusing the shared fixture's installed
		// node_modules) so mutating src/ and re-running check can't corrupt the
		// shared fixture that other suites read concurrently.
		const workDir = makeMutableCopyWithSharedModules();
		try {
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

			const result = runNpm(['run', 'check'], workDir);

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
		} finally {
			fs.rmSync(workDir, { recursive: true, force: true });
		}
	});
});
