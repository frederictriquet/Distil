// tests/action-route-contract-static.test.cjs
//
// Static checks for the "sveltekit-action-contract" backlog task (rule 1 of
// the contract: never mix a `default` action with a named action in the
// same route's `actions` object), plus a regression guard that the old
// bespoke /login?/logout interception in hooks.server.ts was actually
// removed in favor of a dedicated logout route, and that the logout form
// now targets that dedicated route.
//
// These are source-text checks (regex against the real files), not a
// running server: they guard the *shape* of the code (which route declares
// which action keys, and what hooks.server.ts special-cases) rather than
// runtime behavior, which is covered by tests/access-guard-and-logout.test.cjs.
//
// Run with: node --test tests/
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function readText(relPath) {
	return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

/** Recursively find all files under `dir` whose basename matches `name`. */
function findFiles(dir, name) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...findFiles(full, name));
		} else if (entry.name === name) {
			out.push(full);
		}
	}
	return out;
}

/**
 * Extract the top-level key names of a route's `export const actions = { ... }`
 * object from its source text.
 *
 * This is a regex-based extraction (not a TS parse), matching this project's
 * existing test style (see tests/ui-foundations.test.cjs). It relies on the
 * project's own formatting convention of single-tab-indented `key: async (...`
 * action entries, and on the actions object being the last top-level
 * declaration in the file (so its closing `};` is unambiguous).
 */
function extractActionKeys(source) {
	const blockMatch = source.match(/actions\s*(?::\s*Actions)?\s*=\s*\{([\s\S]*)\n\};?\s*$/);
	assert.ok(blockMatch, 'expected an `export const actions = { ... };` declaration');
	const block = blockMatch[1];
	const keys = [...block.matchAll(/^\t([A-Za-z_$][\w$]*)\s*:\s*async/gm)].map((m) => m[1]);
	assert.ok(keys.length > 0, 'expected at least one action key to be found in the actions object');
	return keys;
}

describe('rule 1 of the action/route contract: never mix a `default` action with a named action', () => {
	const serverFiles = findFiles(path.join(ROOT, 'src', 'routes'), '+page.server.ts');

	test('sanity check: found the known form-action routes (kb and login)', () => {
		const relFiles = serverFiles.map((f) => path.relative(ROOT, f)).sort();
		assert.ok(relFiles.includes(path.join('src', 'routes', 'kb', '+page.server.ts')));
		assert.ok(relFiles.includes(path.join('src', 'routes', 'login', '+page.server.ts')));
	});

	for (const file of serverFiles) {
		const rel = path.relative(ROOT, file);
		test(`${rel}: if it declares a "default" action, that is its ONLY action`, () => {
			const source = fs.readFileSync(file, 'utf8');
			if (!/actions\s*(?::\s*Actions)?\s*=/.test(source)) {
				return; // this route has no form actions at all
			}
			const keys = extractActionKeys(source);
			if (keys.includes('default')) {
				assert.deepEqual(
					keys,
					['default'],
					`${rel} mixes a "default" action with named action(s) (${keys.join(', ')}) -- forbidden by the action/route contract`
				);
			}
		});
	}

	test('the login route keeps a single "default" action (login), never a mix', () => {
		const source = readText(path.join('src', 'routes', 'login', '+page.server.ts'));
		assert.deepEqual(extractActionKeys(source), ['default']);
	});

	test('the KB route uses only named mutating actions, no "default"', () => {
		const source = readText(path.join('src', 'routes', 'kb', '+page.server.ts'));
		const keys = extractActionKeys(source);
		assert.ok(!keys.includes('default'), 'the KB route must not declare a "default" action');
		assert.ok(keys.includes('toggleFocus'));
		assert.ok(keys.includes('delete'));
	});
});

describe('logout moved to its own route instead of a bespoke hooks.server.ts interception', () => {
	test('hooks.server.ts no longer special-cases a "?/logout" form action', () => {
		const source = readText(path.join('src', 'hooks.server.ts'));
		assert.doesNotMatch(
			source,
			/\?\/logout/,
			'hooks.server.ts must not intercept a POST /login?/logout form action anymore'
		);
	});

	test('a dedicated logout route exists as either a +server.ts POST handler or a +page.server.ts default action', () => {
		const serverEndpoint = path.join(ROOT, 'src', 'routes', 'logout', '+server.ts');
		const serverPage = path.join(ROOT, 'src', 'routes', 'logout', '+page.server.ts');

		if (fs.existsSync(serverEndpoint)) {
			const source = fs.readFileSync(serverEndpoint, 'utf8');
			assert.match(source, /export const POST/, 'expected the logout endpoint to export a POST handler');
		} else if (fs.existsSync(serverPage)) {
			const source = fs.readFileSync(serverPage, 'utf8');
			const keys = extractActionKeys(source);
			assert.deepEqual(keys, ['default'], 'the logout page must declare a single "default" action, no mixing');
		} else {
			assert.fail('expected either src/routes/logout/+server.ts or src/routes/logout/+page.server.ts to exist');
		}
	});

	test('the logout form in the layout targets the dedicated /logout route, not /login', () => {
		const layout = readText(path.join('src', 'routes', '+layout.svelte'));
		const formMatch = layout.match(/<form\b[^>]*action=["']([^"']+)["'][^>]*>[\s\S]{0,200}?log\s*out/i);
		assert.ok(formMatch, 'expected a <form action="..."> containing a logout control in the root layout');
		assert.equal(formMatch[1], '/logout', 'the logout form must post to the dedicated /logout route');
	});
});
