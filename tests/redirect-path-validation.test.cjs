// tests/redirect-path-validation.test.cjs
//
// Unit checks for the open-redirect validator `safeRedirectPath`
// (src/lib/server/redirect.ts), the pure function behind the login flow's
// `redirectTo` handling. The end-to-end suite
// (tests/access-guard-and-logout.test.cjs) exercises the scheme, "//" and
// leading "/\" vectors through a running server, but not the
// backslash-or-control-character-deeper-in-the-path rejection branch of the
// validator. That branch is security-relevant (a browser may normalize such a
// value into an off-origin destination), so it is covered here directly.
//
// redirect.ts is TypeScript with no relative imports, so it is loaded
// out-of-process through `tsx` (the loader already pulled in by this project's
// `drizzle-kit` dependency), exactly as tests/kb-management.test.cjs does for
// the KB module. The harness prints a JSON result on stdout; this suite never
// spawns `npm install`, touches the network, or writes into the project tree
// beyond a throwaway temp harness file.
//
// Run with: npm test
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TSX_CLI = require.resolve('tsx/cli');

// Harness executed by `tsx` in a fresh process: it loads the real
// src/lib/server/redirect.ts, runs safeRedirectPath over every input passed as
// a JSON array on argv, and prints the JSON array of results on stdout.
const HARNESS_SOURCE = `
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [, , rootDir, inputsJson] = process.argv;
const inputs = JSON.parse(inputsJson);

const redirectUrl = pathToFileURL(path.join(rootDir, 'src', 'lib', 'server', 'redirect.ts')).href;
const { safeRedirectPath, DEFAULT_REDIRECT } = await import(redirectUrl);

process.stdout.write(
	JSON.stringify({ default: DEFAULT_REDIRECT, results: inputs.map((v) => safeRedirectPath(v)) })
);
`;

let harnessDir;
let harnessPath;

before(() => {
	harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-redirect-harness-'));
	harnessPath = path.join(harnessDir, 'redirect-harness.mjs');
	fs.writeFileSync(harnessPath, HARNESS_SOURCE, 'utf8');
});

after(() => {
	if (harnessDir) fs.rmSync(harnessDir, { recursive: true, force: true });
});

/** Run safeRedirectPath over the given inputs, out-of-process via tsx. */
function runSafeRedirectPath(inputs) {
	const result = spawnSync(process.execPath, [TSX_CLI, harnessPath, ROOT, JSON.stringify(inputs)], {
		cwd: ROOT,
		encoding: 'utf8',
		timeout: 30 * 1000
	});

	if (result.error) {
		throw new Error(`running the redirect harness failed to spawn: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`redirect harness exited with ${result.status}:\n${result.stdout}\n${result.stderr}`);
	}
	return JSON.parse(result.stdout);
}

describe('safeRedirectPath open-redirect validation', () => {
	test('a backslash deeper in an otherwise-rooted path is rejected (falls back to "/")', () => {
		const { default: fallback, results } = runSafeRedirectPath(['/kb\\evil.example']);
		assert.equal(results[0], fallback);
	});

	test('an ASCII control character deeper in the path is rejected (falls back to "/")', () => {
		// A NUL and a low control char, both past index 1 so they can only be
		// caught by the UNSAFE_PATH_CHAR branch, not the leading "//"/"\" checks.
		const { default: fallback, results } = runSafeRedirectPath(['/kb\x00evil', '/kb\x1fevil']);
		assert.equal(results[0], fallback);
		assert.equal(results[1], fallback);
	});

	test('a non-Latin-1 character in the path is rejected (falls back to "/")', () => {
		// A code point above 0x7E (e.g. U+4E2D) makes the Location header throw a
		// ByteString conversion error when the redirect is issued, so such a value
		// must never be returned as-is. Internal paths are percent-encoded, so a
		// raw non-ASCII byte is always illegitimate here.
		const { default: fallback, results } = runSafeRedirectPath(['/kb中', '/café']);
		assert.equal(results[0], fallback);
		assert.equal(results[1], fallback);
	});

	test('a clean same-origin path (with query) is returned unchanged', () => {
		const { results } = runSafeRedirectPath(['/kb?tab=active']);
		assert.equal(results[0], '/kb?tab=active');
	});
});
