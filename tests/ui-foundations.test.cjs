// Verifies the "UI foundations" task (root layout shell, global theme,
// reusable components, empty-state foundations, English-only UI text) that
// is not itself a numbered docs/ROADMAP.md task but underpins the upcoming
// business pages (KB management, study view, bookmarks).
//
// These are static, file-content checks rather than a rendered-DOM test:
// the project has no component-testing tool installed (no vitest/jsdom/
// Testing Library, no Playwright), and per CLAUDE.md / the task brief, a UI
// foundations task must not gain a heavy install/build test cycle or a
// fragile browser-driven UI test. Checking the source text keeps this
// suite fast, network-free and safe to run concurrently with the rest of
// `node --test tests/`, while still failing loudly if the required shell,
// theme, reuse or language properties regress.
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

function walkFiles(dir, extensions) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkFiles(full, extensions));
		} else if (extensions.some((ext) => entry.name.endsWith(ext))) {
			out.push(full);
		}
	}
	return out;
}

describe('root layout: persistent navigation shell to the main planned sections', () => {
	const layout = readText('src/routes/+layout.svelte');

	function navHrefs(source) {
		const match = source.match(/const navItems\s*=\s*\[([\s\S]*?)\];/);
		assert.ok(match, 'expected a navItems array declaration in the root layout');
		return [...match[1].matchAll(/href:\s*['"`](\/[^'"`]*)['"`]/g)].map((m) => m[1]);
	}

	test('navigation links to the study/home, KB and bookmarks sections', () => {
		const hrefs = navHrefs(layout);
		assert.ok(hrefs.includes('/'), 'expected a nav link to "/" (study/home)');
		assert.ok(hrefs.includes('/kb'), 'expected a nav link to "/kb" (knowledge base management)');
		assert.ok(hrefs.includes('/bookmarks'), 'expected a nav link to "/bookmarks"');
	});

	test('every nav link target resolves to an existing route, so navigation never 404s', () => {
		const hrefs = navHrefs(layout);
		for (const href of hrefs) {
			const routeDir = href === '/' ? 'src/routes' : path.join('src/routes', href);
			const pageFile = path.join(ROOT, routeDir, '+page.svelte');
			assert.ok(
				fs.existsSync(pageFile),
				`nav link "${href}" should resolve to an existing +page.svelte (found none at ${pageFile})`
			);
		}
	});

	test('the layout renders a header, a main content area and a footer', () => {
		assert.match(layout, /<header\b/, 'expected a <header> in the app shell');
		assert.match(layout, /<main\b/, 'expected a <main> content area in the app shell');
		assert.match(layout, /<footer\b/, 'expected a <footer> in the app shell');
	});

	test('the layout applies the global stylesheet app-wide', () => {
		assert.match(layout, /import\s+['"]\.\.\/app\.css['"]/, 'expected the root layout to import app.css');
	});
});

describe('global stylesheet: theme tokens and a light/dark theme', () => {
	const css = readText('src/app.css');

	test('defines color, typography, spacing and radius tokens', () => {
		assert.match(css, /--color-bg\s*:/, 'expected a --color-bg token');
		assert.match(css, /--color-text\s*:/, 'expected a --color-text token');
		assert.match(css, /--color-primary\s*:/, 'expected a --color-primary token');
		assert.match(css, /--font-sans\s*:/, 'expected a --font-sans typography token');
		assert.match(css, /--text-base\s*:/, 'expected a --text-base typography token');
		assert.match(css, /--space-\d+\s*:/, 'expected a spacing scale token (--space-N)');
		assert.match(css, /--radius-(sm|md|lg)\s*:/, 'expected a border-radius token');
	});

	test('defines a coherent dark theme variant, not just a single fixed palette', () => {
		assert.match(
			css,
			/prefers-color-scheme:\s*dark/,
			'expected a dark theme driven by the OS color-scheme preference'
		);
		assert.match(
			css,
			/\[data-theme=['"]dark['"]\]/,
			'expected an explicit dark theme selectable via a data-theme attribute (for the manual toggle)'
		);
	});

	test('applies a light reset (box-sizing, margin reset) rather than relying on browser defaults', () => {
		assert.match(css, /box-sizing:\s*border-box/, 'expected a box-sizing reset');
	});
});

describe('reusable UI foundation components stay generic (no business logic baked in)', () => {
	test('EmptyState requires only a title and takes description/action as optional', () => {
		const source = readText('src/lib/components/EmptyState.svelte');
		assert.match(source, /\$props\s*\(/, 'expected EmptyState to declare its props via $props()');

		const typeMatch = source.match(/\{\s*title\s*,\s*description\s*,\s*action\s*\}\s*:\s*\{([^}]*)\}/);
		assert.ok(typeMatch, 'expected EmptyState to destructure { title, description, action } with a type annotation');
		const propsType = typeMatch[1];

		assert.match(propsType, /title\s*:\s*string/, 'title should be a required string');
		assert.doesNotMatch(propsType, /title\s*\?\s*:/, 'title must not be optional');
		assert.match(propsType, /description\s*\?\s*:/, 'description should be optional');
		assert.match(propsType, /action\s*\?\s*:/, 'action should be optional');
	});

	test('PageContainer only centers/lays out content: no KB/bookmark-specific text', () => {
		const source = readText('src/lib/components/PageContainer.svelte');
		assert.doesNotMatch(source, /knowledge base|bookmark/i, 'PageContainer must stay generic, not KB/bookmark-specific');
	});

	test('KB and Bookmarks placeholder pages both build on PageContainer + EmptyState, not bespoke markup', () => {
		for (const route of ['src/routes/kb/+page.svelte', 'src/routes/bookmarks/+page.svelte']) {
			const source = readText(route);
			assert.match(source, /import PageContainer from ['"]\$lib\/components\/PageContainer\.svelte['"]/, `${route} should reuse PageContainer`);
			assert.match(source, /import EmptyState from ['"]\$lib\/components\/EmptyState\.svelte['"]/, `${route} should reuse EmptyState`);
			assert.match(source, /<EmptyState\b/, `${route} should render the EmptyState foundation`);
		}
	});
});

describe('the existing login page integrates with the shared theme instead of hardcoding its own colors', () => {
	test('the login page styles reference shared theme tokens, not literal hex colors', () => {
		const source = readText('src/routes/login/+page.svelte');
		assert.doesNotMatch(
			source,
			/#[0-9a-fA-F]{3,8}\b/,
			'the login page must use var(--color-*) tokens from the shared theme instead of hardcoded hex colors'
		);
		assert.match(source, /var\(--color-/, 'expected the login page to use shared theme color tokens');
	});
});

describe('language policy: UI-visible source under src/ is English only', () => {
	test('the document language is declared as English', () => {
		const html = readText('src/app.html');
		assert.match(html, /<html[^>]*\blang=["']en["']/, 'expected <html lang="en"> in src/app.html');
	});

	test('no French-only accented characters appear anywhere under src/', () => {
		const files = walkFiles(path.join(ROOT, 'src'), ['.svelte', '.ts', '.css', '.html']);
		const offenders = [];
		const frenchAccents = /[àâäéèêëîïôöùûüçœÀÂÄÉÈÊËÎÏÔÖÙÛÜÇŒ]/;
		for (const file of files) {
			const content = fs.readFileSync(file, 'utf8');
			if (frenchAccents.test(content)) {
				offenders.push(path.relative(ROOT, file));
			}
		}
		assert.deepEqual(offenders, [], `found French-looking accented characters in: ${offenders.join(', ')}`);
	});
});
