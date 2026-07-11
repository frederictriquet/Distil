// tests/theme-token-consistency.test.cjs
//
// Verifies the theming part of roadmap task 12 ("finitions": 12.1 consistency
// and 12.5 dark mode) with static, file-content checks rather than a
// rendered-DOM test, for the same reasons as tests/ui-foundations.test.cjs
// (no component-testing tool is installed in this project): every page must
// style itself through the shared theme tokens declared in src/app.css
// instead of literal hex colors, or a page will look broken/illegible in the
// dark theme regardless of how correct its light-theme colors happen to be.
//
// tests/ui-foundations.test.cjs already pins this down for the login page
// (the only page with feature UI at the time that suite was written); this
// file extends the same check to every other page's own <style> block, now
// that they all carry real feature UI.
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

const PAGE_FILES = [
	'src/routes/+layout.svelte',
	'src/routes/+page.svelte',
	'src/routes/kb/+page.svelte',
	'src/routes/bookmarks/+page.svelte',
	'src/routes/cards/+page.svelte',
	'src/routes/cards/[id]/+page.svelte',
	'src/routes/card/[kbId]/[...slug]/+page.svelte',
	'src/lib/components/CardView.svelte',
	'src/lib/components/Card.svelte',
	'src/lib/components/EmptyState.svelte',
	'src/lib/components/PageContainer.svelte'
];

describe('every page styles itself through shared theme tokens, not hardcoded hex colors (tasks 12.1 & 12.5)', () => {
	for (const file of PAGE_FILES) {
		test(`${file} contains no literal hex color in its <style> block`, () => {
			const source = readText(file);
			const styleMatch = source.match(/<style[^>]*>([\s\S]*?)<\/style>/);
			if (!styleMatch) {
				// A page with no <style> block of its own has nothing to check here.
				return;
			}
			assert.doesNotMatch(
				styleMatch[1],
				/#[0-9a-fA-F]{3,8}\b/,
				`${file} must style itself with var(--color-*) tokens from src/app.css so dark mode (task 12.5) stays correct, instead of a hardcoded hex color`
			);
		});
	}

	test('src/app.css defines the success and muted-surface tokens for both the light and dark theme', () => {
		const css = readText('src/app.css');
		const rootBlock = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
		const explicitDarkBlock = css.match(/:root\[data-theme=['"]dark['"]\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
		const systemDarkBlock =
			css.match(/@media[^{]*prefers-color-scheme:\s*dark[^{]*\{[\s\S]*?\{([\s\S]*?)\n\t\}/)?.[1] ?? '';

		for (const [label, block] of [
			['light (:root)', rootBlock],
			['explicit dark ([data-theme="dark"])', explicitDarkBlock],
			['system dark (prefers-color-scheme)', systemDarkBlock]
		]) {
			assert.match(block, /--color-success\s*:/, `expected --color-success in the ${label} theme block`);
			assert.match(block, /--color-surface-muted\s*:/, `expected --color-surface-muted in the ${label} theme block`);
		}
	});
});
