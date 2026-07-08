// Verifies task 1.4 of docs/ROADMAP.md (section "1. Fondations du projet"):
// .gitignore must exclude the app's local data directory (SQLite database,
// cloned KB repo cache) and the environment file (.env and variants), while
// still allowing a versioned .env.example. It also verifies that a versioned
// .env.example documents the environment variables the app will need
// (app password, session secret, SQLite database path, and the ORIGIN
// required by adapter-node behind a reverse proxy in production), and that
// no local data or secret env file is currently tracked by git.
//
// The .gitignore checks run against an isolated throwaway git repository
// (a temp dir with its own `git init` and a copy of the real .gitignore),
// so this suite never touches the real repo's working tree or index and
// can't race with other test files under `node --test`.
//
// File: tests/gitignore-local-data-env.test.cjs
// Run with: npm test
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function readText(relPath) {
	return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function git(args, cwd) {
	// A timeout is essential here: without it a stalled git (e.g. blocking on a
	// credential or hook prompt in a misconfigured environment) would hang
	// `npm test` forever instead of failing with a cause.
	const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60 * 1000 });
	// A missing git binary (or a spawn timeout) surfaces as result.error with a
	// null status; assert on it so callers see the real cause instead of
	// misreading an "exited null" as a legitimate git exit code.
	assert.equal(
		result.error,
		undefined,
		`\`git ${args.join(' ')}\` could not be spawned: ${result.error}`
	);
	return result;
}

describe('.gitignore excludes local app data and env files (isolated repo)', () => {
	let repoDir;

	before(() => {
		repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-gitignore-'));

		const init = git(['init', '-q'], repoDir);
		assert.equal(init.status, 0, `git init failed:\n${init.stdout}\n${init.stderr}`);
		// Local, throwaway repo: identity is irrelevant, only needed so
		// `git add`/`git status` below don't fail on a missing author.
		git(['config', 'user.email', 'test@example.com'], repoDir);
		git(['config', 'user.name', 'Test'], repoDir);

		fs.copyFileSync(path.join(ROOT, '.gitignore'), path.join(repoDir, '.gitignore'));
		fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(repoDir, '.env.example'));

		fs.mkdirSync(path.join(repoDir, 'data', 'kb-cache', 'some-kb'), { recursive: true });
		fs.writeFileSync(path.join(repoDir, 'data', 'distil.db'), 'fake sqlite content');
		fs.writeFileSync(path.join(repoDir, 'data', 'kb-cache', 'some-kb', 'note.md'), '# note');

		fs.writeFileSync(path.join(repoDir, '.env'), 'APP_PASSWORD=secret\n');
		fs.writeFileSync(path.join(repoDir, '.env.local'), 'APP_PASSWORD=secret\n');
		fs.writeFileSync(path.join(repoDir, '.env.production'), 'APP_PASSWORD=secret\n');
	});

	after(() => {
		if (repoDir) {
			fs.rmSync(repoDir, { recursive: true, force: true });
		}
	});

	test('the SQLite database file under data/ is git-ignored', () => {
		const result = git(['check-ignore', '-q', 'data/distil.db'], repoDir);
		assert.equal(
			result.status,
			0,
			`expected data/distil.db to be ignored, git check-ignore exited ${result.status}`
		);
	});

	test('the cloned KB repo cache under data/kb-cache/ is git-ignored', () => {
		const result = git(['check-ignore', '-q', 'data/kb-cache/some-kb/note.md'], repoDir);
		assert.equal(
			result.status,
			0,
			`expected data/kb-cache/some-kb/note.md to be ignored, git check-ignore exited ${result.status}`
		);
	});

	test('.env and its variants are git-ignored', () => {
		for (const file of ['.env', '.env.local', '.env.production']) {
			const result = git(['check-ignore', '-q', file], repoDir);
			assert.equal(
				result.status,
				0,
				`expected ${file} to be ignored, git check-ignore exited ${result.status}`
			);
		}
	});

	test('.env.example is NOT git-ignored (kept versioned)', () => {
		const result = git(['check-ignore', '-q', '.env.example'], repoDir);
		assert.equal(
			result.status,
			1,
			`expected .env.example to NOT be ignored, git check-ignore exited ${result.status}`
		);
	});

	test('`git add -A` only stages .env.example and .gitignore, never data/ or .env files', () => {
		const add = git(['add', '-A'], repoDir);
		assert.equal(add.status, 0, `git add failed:\n${add.stdout}\n${add.stderr}`);

		const diff = git(['diff', '--cached', '--name-only'], repoDir);
		assert.equal(diff.status, 0, `git diff failed:\n${diff.stdout}\n${diff.stderr}`);

		const staged = diff.stdout.split('\n').filter(Boolean).sort();
		assert.deepEqual(staged, ['.env.example', '.gitignore']);
	});
});

describe('a versioned .env.example documents the expected environment variables', () => {
	test('.env.example exists at the repo root', () => {
		assert.ok(fs.existsSync(path.join(ROOT, '.env.example')), '.env.example should exist');
	});

	test('.env.example is tracked by git', () => {
		const result = git(['ls-files', '--error-unmatch', '.env.example'], ROOT);
		assert.equal(
			result.status,
			0,
			'.env.example should be tracked by git (it is the exception to .env / .env.*)'
		);
	});

	test('.env.example documents the app password variable', () => {
		const content = readText('.env.example');
		assert.match(
			content,
			/^APP_PASSWORD=.+$/m,
			'.env.example should document an APP_PASSWORD variable with a placeholder value'
		);
	});

	test('.env.example documents the session secret variable', () => {
		const content = readText('.env.example');
		assert.match(
			content,
			/^SESSION_SECRET=.+$/m,
			'.env.example should document a SESSION_SECRET variable with a placeholder value'
		);
	});

	test('.env.example documents the SQLite database path variable', () => {
		const content = readText('.env.example');
		assert.match(
			content,
			/^[A-Z_]*DATABASE[A-Z_]*=.*\.db.*$/m,
			'.env.example should document a *DATABASE*=... variable pointing at a .db file path'
		);
	});

	test('.env.example documents the ORIGIN variable required by adapter-node behind a proxy', () => {
		const content = readText('.env.example');
		assert.match(
			content,
			/^ORIGIN=https?:\/\/.+$/m,
			'.env.example should document an ORIGIN=<url> variable'
		);
	});

	test('none of the placeholder values look like a real secret (non-sensitive example values)', () => {
		const content = readText('.env.example');
		// A very loose guard against accidentally committing a real-looking
		// secret in the example file: placeholders should read as obvious
		// placeholders, not high-entropy random strings copy-pasted from a
		// real .env.
		assert.doesNotMatch(
			content,
			/^(APP_PASSWORD|SESSION_SECRET)=[A-Za-z0-9+/]{20,}={0,2}$/m,
			'.env.example values should look like placeholders, not real generated secrets'
		);
	});
});

describe('no local data or env secret file is currently tracked by git', () => {
	test('git ls-files has no entry under data/', () => {
		const result = git(['ls-files'], ROOT);
		assert.equal(result.status, 0, `git ls-files failed:\n${result.stderr}`);

		const tracked = result.stdout.split('\n').filter(Boolean);
		const dataFiles = tracked.filter((f) => f === 'data' || f.startsWith('data/'));
		assert.deepEqual(dataFiles, [], `no file under data/ should be tracked, found: ${dataFiles}`);
	});

	test('git ls-files has no tracked .env file other than .env.example', () => {
		const result = git(['ls-files'], ROOT);
		assert.equal(result.status, 0, `git ls-files failed:\n${result.stderr}`);

		const tracked = result.stdout.split('\n').filter(Boolean);
		const envFiles = tracked.filter((f) => /(^|\/)\.env(\..+)?$/.test(f) && !f.endsWith('.env.example'));
		assert.deepEqual(
			envFiles,
			[],
			`no .env file besides .env.example should be tracked, found: ${envFiles}`
		);
	});
});

test('the ROADMAP checks off task 1.4 (.gitignore for local data and env)', () => {
	const roadmap = readText('docs/ROADMAP.md');
	const line = roadmap.split('\n').find((l) => /\*\*1\.4\*\*/.test(l));

	assert.ok(line, 'expected to find the "1.4" task line in docs/ROADMAP.md');
	assert.match(line, /^- \[x\]/i, 'task 1.4 must be checked off');
});
