// Verifies tasks 6.1 to 6.7 of docs/ROADMAP.md (section "6. Synchronisation et
// ingestion"):
//   - 6.1 a KB's git repository is cloned into its local cache on the first
//     pass, and updated (in a way that reflects new remote commits and
//     discards local drift) on later passes; an unreachable/invalid
//     repository rejects with an error instead of hanging or silently
//     succeeding.
//   - 6.2 every `.md` file under the KB's content sub-directory is walked and
//     its YAML frontmatter read.
//   - 6.3 only real study cards are kept: files whose frontmatter `type` is
//     `index` are excluded (wherever they sit), and so are files sitting
//     directly at the root of the content sub-directory; only files nested in
//     a content sub-folder are kept.
//   - 6.4 each kept card's theme is its frontmatter `theme` when present,
//     otherwise the name of its first sub-folder.
//   - 6.5 the parsed cards are reconciled with the database by the stable
//     `sourcePath` key: new paths are inserted (active), changed ones are
//     updated, and paths that disappeared from the repo are soft-deleted
//     (active = false) -- never hard-deleted, so bookmarks referencing them
//     survive.
//   - 6.6 a `themePreferences` row is created (with the default weight) the
//     first time a theme is seen, and left untouched afterwards (a
//     user-tuned weight is not reset by a later sync).
//   - 6.7 the /kb page's `sync` form action drives the whole pipeline, shows a
//     report of what changed, and stamps the KB's `lastSyncedAt`.
//
// Parts 1-3 exercise the real `src/lib/server/sync.ts` module directly,
// following the same approach as tests/kb-management.test.cjs and
// tests/bookmarks-management.test.cjs: because that module is TypeScript with
// extension-less relative imports, each check runs it out-of-process through
// `tsx` via a small harness script written to a throwaway temp file. Task 6.1
// is exercised against a real, throwaway LOCAL git fixture repository
// (created with the `git` binary and cloned over a `file://` URL), so no
// network access is ever required. Every database file, cache directory and
// git fixture used here lives under a fresh `mkdtempSync` directory, so this
// suite never touches the real project `data/` tree and can run concurrently
// with the rest of `node --test tests/`.
//
// Part 4 ("triggering a sync from the /kb page") drives the actual
// `+page.server.ts` `sync` action over real HTTP against a running instance
// of the app, the same way tests/bookmarks-management.test.cjs covers the
// bookmarks route's actions.
//
// Run with: node --test tests/
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const TSX_CLI = require.resolve('tsx/cli');
const DRIZZLE_KIT_CLI = path.join(ROOT, 'node_modules', 'drizzle-kit', 'bin.cjs');

/** Run the project's reproducible migration ("npm run db:migrate", task 2.3). */
function runMigrate(databasePath) {
	const result = spawnSync(process.execPath, [DRIZZLE_KIT_CLI, 'migrate'], {
		cwd: ROOT,
		encoding: 'utf8',
		timeout: 60 * 1000,
		env: { ...process.env, DATABASE_PATH: databasePath }
	});

	if (result.error) {
		throw new Error(`spawning the drizzle-kit migrate CLI failed: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`drizzle-kit migrate failed:\n${result.stdout}\n${result.stderr}`);
	}
	return result;
}

// --- Local git fixture helpers ---------------------------------------------
//
// Task 6.1 must be exercised against a real git repository, not a mock, but
// never against the network: these helpers build a throwaway repo on disk
// with the `git` binary and expose it over a `file://` URL that `simple-git`
// can clone/fetch exactly like a remote. `-c user.name=/-c user.email=` and
// `-c commit.gpgsign=false` are passed explicitly on every commit so these
// fixture repos never depend on (or are broken by) the host's global git
// config -- keeping the suite hermetic. `git` is invoked directly (never
// through a shell), so this works unchanged on Windows.
function runGit(args, cwd) {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30 * 1000 });
	if (result.error) {
		throw new Error(`git ${args.join(' ')} failed to spawn: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`git ${args.join(' ')} exited with ${result.status}:\n${result.stdout}\n${result.stderr}`);
	}
	return result;
}

/** Initialise an empty git repo at `dir` with a `main` branch. */
function initFixtureRepo(dir) {
	fs.mkdirSync(dir, { recursive: true });
	runGit(['init', '-q'], dir);
	runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
}

/** Write a fixture file (creating parent directories as needed). */
function writeFixtureFile(dir, relPath, content) {
	const full = path.join(dir, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, 'utf8');
}

/** Stage and commit everything currently on disk in the fixture repo. */
function commitFixture(dir, message) {
	runGit(['add', '-A'], dir);
	runGit(
		['-c', 'user.name=Distil Test Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message],
		dir
	);
}

/**
 * Build a fixture KB repository with a realistic mix of content: two
 * root-level files that must be excluded regardless of frontmatter (6.3), a
 * nested generated index flagged `type: index` that must also be excluded
 * even though it is not at the root (6.3), and three genuine cards spread
 * across sub-folders exercising both explicit-frontmatter and folder-derived
 * themes (6.4).
 */
function buildFixtureRepo(dir) {
	initFixtureRepo(dir);

	writeFixtureFile(
		dir,
		'content/home.md',
		['---', 'title: Home', '---', '# Home', '', 'Welcome page, not a card.'].join('\n')
	);
	writeFixtureFile(dir, 'content/index.md', ['# Index', '', 'Plain root file with no frontmatter at all.'].join('\n'));
	writeFixtureFile(
		dir,
		'content/concepts/nested-index.md',
		['---', 'type: index', 'title: Concepts Index', '---', '# Concepts', '', 'Generated index, not a card.'].join('\n')
	);
	writeFixtureFile(
		dir,
		'content/concepts/recursion.md',
		['---', 'title: Recursion', 'theme: algorithms', 'level: intermediate', '---', '# Recursion', '', 'Recursion body.'].join(
			'\n'
		)
	);
	writeFixtureFile(dir, 'content/guides/setup.md', ['---', 'title: Setup Guide', '---', '# Setup', '', 'Guide body.'].join('\n'));
	writeFixtureFile(dir, 'content/tools/linter.md', ['Linter card body, with no frontmatter at all.'].join('\n'));

	commitFixture(dir, 'initial content');
}

// Harness executed by `tsx` (in a fresh process) so it can load the real
// `src/lib/server/sync.ts` module exactly as SvelteKit does, and dispatch one
// action against a given SQLite file / on-disk repo, printing the JSON result
// on stdout.
const HARNESS_SOURCE = `
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [, , rootDir, dbPath, action, payloadJson] = process.argv;
const payload = JSON.parse(payloadJson || '{}');

const dbIndexUrl = pathToFileURL(path.join(rootDir, 'src', 'lib', 'server', 'db', 'index.ts')).href;
const syncUrl = pathToFileURL(path.join(rootDir, 'src', 'lib', 'server', 'sync.ts')).href;

const { createSqliteConnection, createDb } = await import(dbIndexUrl);
const sync = await import(syncUrl);

async function run() {
	switch (action) {
		case 'cloneOrUpdate': {
			try {
				const repoDir = await sync.cloneOrUpdateRepo(payload.kb, payload.cacheBaseDir);
				return { ok: true, repoDir };
			} catch (error) {
				return { ok: false, message: String((error && error.message) || error) };
			}
		}
		case 'parseCards':
			return sync.parseCards(payload.repoDir, payload.contentSubdir);
		case 'reconcile': {
			const sqlite = createSqliteConnection(dbPath);
			const db = createDb(sqlite);
			try {
				return sync.reconcileCards(db, payload.kbId, payload.parsed);
			} finally {
				sqlite.close();
			}
		}
		case 'syncKb': {
			const sqlite = createSqliteConnection(dbPath);
			const db = createDb(sqlite);
			try {
				const report = await sync.syncKnowledgeBase(db, payload.kb, payload.cacheBaseDir);
				return { ok: true, report };
			} catch (error) {
				return { ok: false, message: String((error && error.message) || error) };
			} finally {
				sqlite.close();
			}
		}
		default:
			throw new Error('unknown harness action: ' + action);
	}
}

try {
	const result = await run();
	process.stdout.write(JSON.stringify(result === undefined ? null : result));
} catch (error) {
	process.stderr.write(String((error && error.stack) || error));
	process.exitCode = 1;
}
`;

let harnessDir;
let harnessPath;

before(() => {
	harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-sync-harness-'));
	harnessPath = path.join(harnessDir, 'sync-harness.mjs');
	fs.writeFileSync(harnessPath, HARNESS_SOURCE, 'utf8');
});

after(() => {
	if (harnessDir) fs.rmSync(harnessDir, { recursive: true, force: true });
});

/** Run one `sync.ts` action, out-of-process via tsx, and return its parsed JSON result. */
function runSync(dbPath, action, payload) {
	const result = spawnSync(
		process.execPath,
		[TSX_CLI, harnessPath, ROOT, dbPath, action, JSON.stringify(payload ?? {})],
		{ cwd: ROOT, encoding: 'utf8', timeout: 30 * 1000 }
	);

	if (result.error) {
		throw new Error(`running sync action "${action}" failed to spawn: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`sync action "${action}" exited with ${result.status}:\n${result.stdout}\n${result.stderr}`);
	}
	const output = result.stdout.trim();
	return output.length > 0 ? JSON.parse(output) : undefined;
}

// --- Part 1: cloning and updating a KB repo (task 6.1) ---------------------

describe('cloning and updating a KB repo from a local git fixture (task 6.1)', () => {
	let workDir;
	let sourceDir;
	let cacheBaseDir;
	let kb;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-sync-clone-'));
		sourceDir = path.join(workDir, 'source');
		cacheBaseDir = path.join(workDir, 'cache');
		buildFixtureRepo(sourceDir);
		kb = { id: 1, repoUrl: pathToFileURL(sourceDir).href, branch: 'main', contentSubdir: 'content' };
	});

	after(() => {
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('the first sync clones the repo into <cacheBaseDir>/<kbId>', () => {
		const result = runSync('unused.db', 'cloneOrUpdate', { kb, cacheBaseDir });
		assert.equal(result.ok, true);

		const setupPath = path.join(cacheBaseDir, String(kb.id), 'content', 'guides', 'setup.md');
		assert.ok(fs.existsSync(setupPath), 'expected the cloned checkout to contain the fixture content');
		assert.match(fs.readFileSync(setupPath, 'utf8'), /Guide body\./);
	});

	test('a later sync picks up new commits pushed to the source repo (update, not re-clone)', () => {
		writeFixtureFile(
			sourceDir,
			'content/guides/setup.md',
			['---', 'title: Setup Guide', '---', '# Setup', '', 'Updated guide body.'].join('\n')
		);
		writeFixtureFile(sourceDir, 'content/guides/new-guide.md', ['# New Guide', '', 'Brand new guide body.'].join('\n'));
		commitFixture(sourceDir, 'update setup guide, add new guide');

		const result = runSync('unused.db', 'cloneOrUpdate', { kb, cacheBaseDir });
		assert.equal(result.ok, true);

		const setupPath = path.join(cacheBaseDir, String(kb.id), 'content', 'guides', 'setup.md');
		const newGuidePath = path.join(cacheBaseDir, String(kb.id), 'content', 'guides', 'new-guide.md');
		assert.match(fs.readFileSync(setupPath, 'utf8'), /Updated guide body\./);
		assert.ok(fs.existsSync(newGuidePath), 'expected the new file pushed upstream to appear in the local cache');
	});

	test('a later sync discards local drift in the cached checkout instead of merging or failing on it', () => {
		const setupPath = path.join(cacheBaseDir, String(kb.id), 'content', 'guides', 'setup.md');
		fs.writeFileSync(setupPath, 'LOCAL DRIFT THAT SHOULD BE DISCARDED', 'utf8');

		const result = runSync('unused.db', 'cloneOrUpdate', { kb, cacheBaseDir });
		assert.equal(result.ok, true);
		assert.match(
			fs.readFileSync(setupPath, 'utf8'),
			/Updated guide body\./,
			'expected the update to overwrite local drift with the remote content, not merge or abort on it'
		);
	});

	test('an unreachable/invalid repository rejects with an error, not a hang or a silent success', () => {
		const badKb = {
			id: 999,
			repoUrl: pathToFileURL(path.join(workDir, 'does-not-exist')).href,
			branch: 'main',
			contentSubdir: 'content'
		};
		const result = runSync('unused.db', 'cloneOrUpdate', { kb: badKb, cacheBaseDir });
		assert.equal(result.ok, false);
		assert.ok(result.message && result.message.length > 0, 'expected a non-empty error message');
	});
});

// --- Part 2: parsing cards from the content sub-directory (6.2-6.4) --------

describe('parsing cards out of the content sub-directory (tasks 6.2-6.4)', () => {
	let workDir;
	let repoDir;
	let parsed;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-sync-parse-'));
		repoDir = path.join(workDir, 'repo');

		writeFixtureFile(repoDir, 'content/home.md', ['# Home', '', 'Root-level page.'].join('\n'));
		writeFixtureFile(repoDir, 'content/index.md', ['---', 'title: Index', '---', '# Index'].join('\n'));
		writeFixtureFile(
			repoDir,
			'content/concepts/nested-index.md',
			['---', 'type: index', 'title: Concepts Index', '---', '# Concepts'].join('\n')
		);
		writeFixtureFile(
			repoDir,
			'content/concepts/recursion.md',
			['---', 'title: Recursion', 'theme: algorithms', 'level: intermediate', '---', 'Recursion body.'].join('\n')
		);
		writeFixtureFile(repoDir, 'content/guides/setup.md', ['---', 'title: Setup Guide', '---', 'Guide body.'].join('\n'));
		writeFixtureFile(repoDir, 'content/tools/linter.md', 'Linter card body, no frontmatter at all.');

		parsed = runSync('unused.db', 'parseCards', { repoDir, contentSubdir: 'content' });
	});

	after(() => {
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('root-level files under the content sub-directory are excluded, even without index frontmatter', () => {
		const sourcePaths = parsed.map((c) => c.sourcePath);
		assert.ok(!sourcePaths.includes('content/home.md'));
		assert.ok(!sourcePaths.includes('content/index.md'));
	});

	test('a nested file flagged `type: index` is excluded even though it sits inside a content sub-folder', () => {
		const sourcePaths = parsed.map((c) => c.sourcePath);
		assert.ok(!sourcePaths.includes('content/concepts/nested-index.md'));
	});

	test('files nested in a content sub-folder are kept, with title/level parsed from frontmatter and a repo-relative sourcePath', () => {
		assert.equal(parsed.length, 3, 'expected exactly the three genuine cards to survive the filter');

		const recursion = parsed.find((c) => c.sourcePath === 'content/concepts/recursion.md');
		assert.ok(recursion);
		assert.equal(recursion.title, 'Recursion');
		assert.equal(recursion.level, 'intermediate');
		assert.equal(recursion.slug, 'concepts/recursion');
	});

	test('theme defaults to the name of the first sub-folder when no frontmatter theme is present (task 6.4)', () => {
		const setup = parsed.find((c) => c.sourcePath === 'content/guides/setup.md');
		const linter = parsed.find((c) => c.sourcePath === 'content/tools/linter.md');
		assert.equal(setup.theme, 'guides');
		assert.equal(linter.theme, 'tools');
		assert.equal(linter.title, 'linter', 'expected the title to fall back to the filename when no frontmatter title exists');
	});

	test('an explicit frontmatter theme overrides the folder-derived category (task 6.4)', () => {
		const recursion = parsed.find((c) => c.sourcePath === 'content/concepts/recursion.md');
		assert.equal(recursion.theme, 'algorithms', 'expected the explicit frontmatter theme, not the folder name "concepts"');
	});
});

// --- Part 3: reconciling parsed cards with the database (6.5-6.6) ----------

describe('reconciling parsed cards with the database (tasks 6.5-6.6)', () => {
	let workDir;
	let dbPath;
	let kbId;
	let linterCardId;

	const parsedInitial = [
		{
			sourcePath: 'content/guides/setup.md',
			slug: 'guides/setup',
			title: 'Setup Guide',
			theme: 'guides',
			level: null,
			content: 'Guide body.'
		},
		{
			sourcePath: 'content/tools/linter.md',
			slug: 'tools/linter',
			title: 'Linter',
			theme: 'tools',
			level: null,
			content: 'Linter body.'
		}
	];

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-sync-reconcile-'));
		dbPath = path.join(workDir, 'app.db');
		runMigrate(dbPath);

		const raw = new Database(dbPath);
		raw.prepare('INSERT INTO knowledge_bases (name, repo_url, branch) VALUES (?, ?, ?)').run(
			'Reconcile KB',
			'https://example.test/reconcile.git',
			'main'
		);
		kbId = raw.prepare('SELECT last_insert_rowid() AS id').get().id;
		raw.close();
	});

	after(() => {
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('the first reconciliation inserts every parsed card as active, and reports it in "added"', () => {
		const report = runSync(dbPath, 'reconcile', { kbId, parsed: parsedInitial });
		assert.deepEqual(report, { added: 2, updated: 0, deactivated: 0 });

		const raw = new Database(dbPath);
		const rows = raw.prepare('SELECT slug, active, source_path FROM cards WHERE kb_id = ? ORDER BY slug').all(kbId);
		assert.equal(rows.length, 2);
		assert.ok(rows.every((r) => r.active === 1));
		linterCardId = raw.prepare('SELECT id FROM cards WHERE source_path = ?').get('content/tools/linter.md').id;
		raw.close();
	});

	test('a themePreferences row is created for every theme seen for the first time (task 6.6)', () => {
		const raw = new Database(dbPath);
		const themes = raw.prepare('SELECT theme, weight, default_weight FROM theme_preferences ORDER BY theme').all();
		raw.close();
		assert.deepEqual(themes.map((t) => t.theme).sort(), ['guides', 'tools']);
		for (const row of themes) {
			assert.equal(row.weight, 1);
			assert.equal(row.default_weight, 1);
		}
	});

	test('reconciling again with no changes is a no-op: nothing added, updated or deactivated', () => {
		const report = runSync(dbPath, 'reconcile', { kbId, parsed: parsedInitial });
		assert.deepEqual(report, { added: 0, updated: 0, deactivated: 0 });
	});

	test('a theme preference already tuned by the user keeps its custom weight on a later reconciliation', () => {
		const raw = new Database(dbPath);
		raw.prepare('UPDATE theme_preferences SET weight = 2.5 WHERE theme = ?').run('guides');
		raw.close();

		runSync(dbPath, 'reconcile', { kbId, parsed: parsedInitial });

		const rawAfter = new Database(dbPath);
		const weight = rawAfter.prepare('SELECT weight FROM theme_preferences WHERE theme = ?').get('guides').weight;
		rawAfter.close();
		assert.equal(weight, 2.5, 'a later sync must not reset an already-tuned theme weight back to its default');
	});

	// From here on, `currentParsed` tracks the state we just reconciled the DB
	// to, so each following test's expected report only reflects the delta it
	// itself introduces (rather than accidentally re-diffing against the
	// original `parsedInitial`, which earlier tests have already moved past).
	let currentParsed = parsedInitial;

	test('a modified card is updated in place and reported in "updated", leaving unrelated cards untouched', () => {
		const modified = currentParsed.map((c) =>
			c.sourcePath === 'content/guides/setup.md' ? { ...c, content: 'Updated guide body.' } : c
		);
		const report = runSync(dbPath, 'reconcile', { kbId, parsed: modified });
		assert.deepEqual(report, { added: 0, updated: 1, deactivated: 0 });

		const raw = new Database(dbPath);
		const setup = raw.prepare('SELECT content FROM cards WHERE source_path = ?').get('content/guides/setup.md');
		const linter = raw.prepare('SELECT content FROM cards WHERE source_path = ?').get('content/tools/linter.md');
		raw.close();
		assert.equal(setup.content, 'Updated guide body.');
		assert.equal(linter.content, 'Linter body.', 'the unrelated card must not have been touched');

		currentParsed = modified;
	});

	test('a card that disappears from the repo is soft-deleted (active=false), never hard-deleted, and a bookmark on it survives', () => {
		const raw = new Database(dbPath);
		raw.prepare('INSERT INTO bookmark_categories (name) VALUES (?)').run('Later');
		const categoryId = raw.prepare('SELECT last_insert_rowid() AS id').get().id;
		raw.prepare('INSERT INTO bookmarks (card_id, category_id) VALUES (?, ?)').run(linterCardId, categoryId);
		raw.close();

		const withoutLinter = currentParsed.filter((c) => c.sourcePath !== 'content/tools/linter.md');
		const report = runSync(dbPath, 'reconcile', { kbId, parsed: withoutLinter });
		assert.deepEqual(report, { added: 0, updated: 0, deactivated: 1 });

		const raw2 = new Database(dbPath);
		const linterRow = raw2.prepare('SELECT active FROM cards WHERE id = ?').get(linterCardId);
		const bookmarkCount = raw2.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE card_id = ?').get(linterCardId).n;
		raw2.close();

		assert.ok(linterRow, 'the card row must still exist (soft-delete, not a hard delete)');
		assert.equal(linterRow.active, 0);
		assert.equal(bookmarkCount, 1, "the bookmark referencing the deactivated card must survive");

		currentParsed = withoutLinter;
	});

	test('a card that reappears is reactivated (reported as "updated", not duplicated)', () => {
		const withLinterBack = [...currentParsed, parsedInitial.find((c) => c.sourcePath === 'content/tools/linter.md')];
		const report = runSync(dbPath, 'reconcile', { kbId, parsed: withLinterBack });
		assert.deepEqual(report, { added: 0, updated: 1, deactivated: 0 });

		const raw = new Database(dbPath);
		const rows = raw.prepare('SELECT id, active FROM cards WHERE source_path = ?').all('content/tools/linter.md');
		raw.close();
		assert.equal(rows.length, 1, 'the reappearing card must reuse its existing row, not create a duplicate');
		assert.equal(rows[0].id, linterCardId);
		assert.equal(rows[0].active, 1);
	});
});

// --- End-to-end orchestration: syncKnowledgeBase (6.1-6.7 core) ------------

describe('end-to-end KB synchronisation against a local git fixture (tasks 6.1-6.6 orchestrated)', () => {
	let workDir;
	let sourceDir;
	let cacheBaseDir;
	let dbPath;
	let kbId;
	let repoUrl;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-sync-e2e-'));
		sourceDir = path.join(workDir, 'source');
		cacheBaseDir = path.join(workDir, 'cache');
		dbPath = path.join(workDir, 'app.db');

		buildFixtureRepo(sourceDir);
		repoUrl = pathToFileURL(sourceDir).href;
		runMigrate(dbPath);

		const raw = new Database(dbPath);
		raw
			.prepare('INSERT INTO knowledge_bases (name, repo_url, branch, content_subdir) VALUES (?, ?, ?, ?)')
			.run('E2E KB', repoUrl, 'main', 'content');
		kbId = raw.prepare('SELECT last_insert_rowid() AS id').get().id;
		raw.close();
	});

	after(() => {
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	function kbRef() {
		return { id: kbId, repoUrl, branch: 'main', contentSubdir: 'content' };
	}

	test('the first sync clones, ingests only the real cards, derives their themes, creates theme preferences and stamps lastSyncedAt', () => {
		const result = runSync(dbPath, 'syncKb', { kb: kbRef(), cacheBaseDir });
		assert.equal(result.ok, true);
		assert.deepEqual(result.report, { added: 3, updated: 0, deactivated: 0 });

		const raw = new Database(dbPath);
		const cards = raw.prepare('SELECT slug, theme, active FROM cards WHERE kb_id = ? ORDER BY slug').all(kbId);
		const themes = raw.prepare('SELECT theme FROM theme_preferences ORDER BY theme').all().map((r) => r.theme);
		const kbRow = raw.prepare('SELECT last_synced_at FROM knowledge_bases WHERE id = ?').get(kbId);
		raw.close();

		assert.deepEqual(
			cards.map((c) => c.slug),
			['concepts/recursion', 'guides/setup', 'tools/linter']
		);
		assert.ok(cards.every((c) => c.active === 1));
		assert.deepEqual(
			cards.map((c) => c.theme).sort(),
			['algorithms', 'guides', 'tools']
		);
		assert.deepEqual(themes.sort(), ['algorithms', 'guides', 'tools']);
		assert.ok(kbRow.last_synced_at !== null, 'expected lastSyncedAt to be stamped after a successful sync');
	});

	test('a later sync reconciles a modified, a new and a removed file, preserving a bookmark on the removed one', () => {
		const raw = new Database(dbPath);
		const linterId = raw.prepare('SELECT id FROM cards WHERE source_path = ?').get('content/tools/linter.md').id;
		raw.prepare('INSERT INTO bookmark_categories (name) VALUES (?)').run('E2E Later');
		const categoryId = raw.prepare('SELECT last_insert_rowid() AS id').get().id;
		raw.prepare('INSERT INTO bookmarks (card_id, category_id) VALUES (?, ?)').run(linterId, categoryId);
		const firstSyncedAt = raw.prepare('SELECT last_synced_at FROM knowledge_bases WHERE id = ?').get(kbId).last_synced_at;
		raw.close();

		writeFixtureFile(
			sourceDir,
			'content/concepts/recursion.md',
			['---', 'title: Recursion', 'theme: algorithms', 'level: intermediate', '---', 'Updated recursion body.'].join('\n')
		);
		writeFixtureFile(sourceDir, 'content/guides/new-topic.md', ['---', 'title: New Topic', '---', 'New topic body.'].join('\n'));
		fs.rmSync(path.join(sourceDir, 'content', 'tools', 'linter.md'));
		commitFixture(sourceDir, 'update recursion, add new-topic, remove linter');

		const result = runSync(dbPath, 'syncKb', { kb: kbRef(), cacheBaseDir });
		assert.equal(result.ok, true);
		assert.deepEqual(result.report, { added: 1, updated: 1, deactivated: 1 });

		const raw2 = new Database(dbPath);
		const recursion = raw2.prepare('SELECT content FROM cards WHERE source_path = ?').get('content/concepts/recursion.md');
		const newTopic = raw2.prepare('SELECT active FROM cards WHERE source_path = ?').get('content/guides/new-topic.md');
		const linter = raw2.prepare('SELECT active FROM cards WHERE id = ?').get(linterId);
		const bookmarkCount = raw2.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE card_id = ?').get(linterId).n;
		const secondSyncedAt = raw2.prepare('SELECT last_synced_at FROM knowledge_bases WHERE id = ?').get(kbId).last_synced_at;
		raw2.close();

		assert.match(recursion.content, /Updated recursion body\./);
		assert.equal(newTopic.active, 1);
		assert.equal(linter.active, 0, 'the removed card must be soft-deleted, not hard-deleted');
		assert.equal(bookmarkCount, 1, 'the bookmark on the removed card must survive the reconciliation');
		assert.ok(secondSyncedAt >= firstSyncedAt, 'lastSyncedAt must be refreshed by the later sync');
	});

	test('a sync failure (unreachable repository) rejects without stamping lastSyncedAt', () => {
		const raw = new Database(dbPath);
		raw
			.prepare('INSERT INTO knowledge_bases (name, repo_url, branch, content_subdir) VALUES (?, ?, ?, ?)')
			.run('Doomed KB', pathToFileURL(path.join(workDir, 'nope')).href, 'main', 'content');
		const doomedId = raw.prepare('SELECT last_insert_rowid() AS id').get().id;
		raw.close();

		const result = runSync(dbPath, 'syncKb', {
			kb: { id: doomedId, repoUrl: pathToFileURL(path.join(workDir, 'nope')).href, branch: 'main', contentSubdir: 'content' },
			cacheBaseDir
		});
		assert.equal(result.ok, false);

		const rawAfter = new Database(dbPath);
		const kbRow = rawAfter.prepare('SELECT last_synced_at FROM knowledge_bases WHERE id = ?').get(doomedId);
		rawAfter.close();
		assert.equal(kbRow.last_synced_at, null, 'a failed sync must not stamp lastSyncedAt');
	});
});

// --- Part 4: triggering a sync from the /kb page (task 6.7) ----------------
//
// Bootstraps Vite's dev server programmatically (the same engine `npm run
// dev` uses), pointed at a throwaway copy of this repo, bound to a
// caller-chosen port -- the same harness as tests/bookmarks-management.test.cjs
// (see that file for the full rationale): Vite/svelte-kit sync write
// cache/build state into the project root they are pointed at, so the dev
// server is pointed at a temp copy (node_modules brought in via a directory
// junction, never copied) instead of this repo checkout, and the server binds
// to a port freshly probed from the OS so this suite is safe to run
// concurrently with the rest of `node --test`.
const HTTP_HARNESS_SOURCE = `
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [, , rootDir, portArg] = process.argv;
const port = Number(portArg);

const viteEntry = pathToFileURL(path.join(rootDir, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href;
const { createServer } = await import(viteEntry);

const server = await createServer({
	root: rootDir,
	configFile: path.join(rootDir, 'vite.config.ts'),
	cacheDir: path.join(rootDir, '.vite-cache'),
	server: { port, host: '127.0.0.1', strictPort: true },
	logLevel: 'error'
});

await server.listen();
process.stdout.write('READY\\n');
`;

const APP_COPY_FILES = ['package.json', 'svelte.config.js', 'vite.config.ts', 'tsconfig.json'];
const APP_COPY_DIRS = ['src', 'static'];

/** Materialize a throwaway copy of the project that Vite can be pointed at. */
function buildIsolatedAppCopy() {
	const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-sync-app-copy-'));
	for (const file of APP_COPY_FILES) {
		fs.cpSync(path.join(ROOT, file), path.join(appDir, file));
	}
	for (const dir of APP_COPY_DIRS) {
		fs.cpSync(path.join(ROOT, dir), path.join(appDir, dir), { recursive: true });
	}
	fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(appDir, 'node_modules'), 'junction');
	return appDir;
}

/** Ask the OS for a free TCP port by briefly binding to port 0, then release it. */
function getEphemeralPort() {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close((closeErr) => (closeErr ? reject(closeErr) : resolve(port)));
		});
	});
}

const STARTUP_TIMEOUT_MS = 30 * 1000;
const SHUTDOWN_TIMEOUT_MS = 5 * 1000;

/** Start the real app (via the Vite dev server harness above) with the given environment. */
async function startApp(env) {
	const port = await getEphemeralPort();
	const appDir = buildIsolatedAppCopy();
	const httpHarnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-sync-web-harness-'));
	const httpHarnessPath = path.join(httpHarnessDir, 'web-harness.mjs');
	fs.writeFileSync(httpHarnessPath, HTTP_HARNESS_SOURCE, 'utf8');

	const child = spawn(process.execPath, [TSX_CLI, httpHarnessPath, appDir, String(port)], {
		cwd: appDir,
		env: { ...process.env, ...env },
		stdio: ['ignore', 'pipe', 'pipe']
	});

	let stdoutBuf = '';
	let stderrBuf = '';
	child.stdout.on('data', (chunk) => {
		stdoutBuf += chunk.toString();
	});
	child.stderr.on('data', (chunk) => {
		stderrBuf += chunk.toString();
	});

	await new Promise((resolve, reject) => {
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(
				new Error(
					`dev server harness did not report readiness within ${STARTUP_TIMEOUT_MS}ms.\n` +
						`stdout:\n${stdoutBuf}\nstderr:\n${stderrBuf}`
				)
			);
		}, STARTUP_TIMEOUT_MS);

		function checkReady() {
			if (settled || !/^READY$/m.test(stdoutBuf)) return;
			settled = true;
			cleanup();
			resolve();
		}
		function onError(err) {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error(`failed to spawn the dev server harness: ${err.message}`));
		}
		function onExit(code, signal) {
			if (settled) return;
			settled = true;
			cleanup();
			reject(
				new Error(
					`dev server harness exited early (code=${code}, signal=${signal}) before becoming ready.\n` +
						`stderr:\n${stderrBuf}`
				)
			);
		}
		function cleanup() {
			clearTimeout(timer);
			child.stdout.removeListener('data', checkReady);
			child.removeListener('error', onError);
			child.removeListener('exit', onExit);
		}

		child.stdout.on('data', checkReady);
		child.once('error', onError);
		child.once('exit', onExit);
		checkReady();
	});

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		appDir,
		async stop() {
			child.kill('SIGKILL');
			await new Promise((resolve) => {
				const timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
				child.once('close', () => {
					clearTimeout(timer);
					resolve();
				});
			});
			child.stdout?.destroy();
			child.stderr?.destroy();
			fs.rmSync(httpHarnessDir, { recursive: true, force: true });
			fs.rmSync(path.join(appDir, 'node_modules'), { force: true });
			fs.rmSync(appDir, { recursive: true, force: true });
		}
	};
}

const REQUEST_TIMEOUT_MS = 10 * 1000;

/** A minimal fetch-shaped helper built on node:http; see bookmarks-management.test.cjs for the rationale (no dangling keep-alive sockets). */
function fetch(url, { method = 'GET', headers = {}, body } = {}) {
	const target = new URL(url);
	const requestBody = body === undefined ? undefined : String(body);
	const requestHeaders = { ...headers };
	if (requestBody !== undefined) {
		requestHeaders['content-type'] ??= 'application/x-www-form-urlencoded;charset=UTF-8';
		requestHeaders['content-length'] = Buffer.byteLength(requestBody);
	}
	requestHeaders.connection = 'close';

	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: target.hostname,
				port: target.port,
				path: target.pathname + target.search,
				method,
				headers: requestHeaders,
				agent: false,
				timeout: REQUEST_TIMEOUT_MS
			},
			(res) => {
				const chunks = [];
				res.on('data', (chunk) => chunks.push(chunk));
				res.on('end', () => {
					const rawBody = Buffer.concat(chunks).toString('utf8');
					const setCookie = res.headers['set-cookie'];
					resolve({
						status: res.statusCode,
						headers: {
							get: (name) => {
								const value = res.headers[name.toLowerCase()];
								return Array.isArray(value) ? value.join(', ') : (value ?? null);
							},
							getSetCookie: () => (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [])
						},
						async text() {
							return rawBody;
						}
					});
				});
				res.on('error', (err) => reject(new Error(`response error for ${url}: ${err.message}`)));
			}
		);
		req.on('timeout', () => req.destroy(new Error(`request to ${url} timed out after ${REQUEST_TIMEOUT_MS}ms`)));
		req.on('error', (err) => reject(new Error(`request error for ${url}: ${err.message}`)));
		if (requestBody !== undefined) req.write(requestBody);
		req.end();
	});
}

const TEST_PASSWORD = 'correct horse battery staple';
const TEST_SESSION_SECRET = 'z'.repeat(32);

/** POST a classic (no-JS) login submission and return the raw response. */
function submitLogin(baseUrl, password = TEST_PASSWORD) {
	return fetch(`${baseUrl}/login`, {
		method: 'POST',
		redirect: 'manual',
		body: new URLSearchParams({ password })
	});
}

/** The `name=value` pair of the distil_session Set-Cookie header, for a subsequent request's Cookie header. */
function extractSessionCookiePair(response) {
	const setCookie = response.headers.getSetCookie();
	const cookie = setCookie.find((c) => c.startsWith('distil_session='));
	assert.ok(cookie, 'expected a distil_session Set-Cookie header from login');
	return cookie.split(';')[0];
}

describe("triggering a synchronisation from the /kb page's sync action (task 6.7)", () => {
	let app;
	let workDir;
	let sourceDir;
	let dbPath;
	let cookie;
	let goodKbId;
	let badKbId;

	before(async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-sync-http-'));
		sourceDir = path.join(workDir, 'source');
		dbPath = path.join(workDir, 'app.db');
		buildFixtureRepo(sourceDir);
		runMigrate(dbPath);

		const repoUrl = pathToFileURL(sourceDir).href;
		const raw = new Database(dbPath);
		raw
			.prepare('INSERT INTO knowledge_bases (name, repo_url, branch, content_subdir) VALUES (?, ?, ?, ?)')
			.run('HTTP KB', repoUrl, 'main', 'content');
		goodKbId = raw.prepare('SELECT last_insert_rowid() AS id').get().id;
		raw
			.prepare('INSERT INTO knowledge_bases (name, repo_url, branch, content_subdir) VALUES (?, ?, ?, ?)')
			.run('Doomed HTTP KB', pathToFileURL(path.join(workDir, 'nope')).href, 'main', 'content');
		badKbId = raw.prepare('SELECT last_insert_rowid() AS id').get().id;
		raw.close();

		app = await startApp({
			APP_PASSWORD: TEST_PASSWORD,
			SESSION_SECRET: TEST_SESSION_SECRET,
			DATABASE_PATH: dbPath
		});

		const loginRes = await submitLogin(app.baseUrl);
		assert.equal(loginRes.status, 303, 'sanity check: login must succeed before exercising the guarded route');
		cookie = extractSessionCookiePair(loginRes);
	});

	after(async () => {
		if (app) await app.stop();
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	function callSync(id, extraHeaders = {}) {
		return fetch(`${app.baseUrl}/kb?/sync`, {
			method: 'POST',
			redirect: 'manual',
			headers: { cookie, accept: 'text/html', ...extraHeaders },
			body: new URLSearchParams({ id: String(id) })
		});
	}

	test('syncing a KB with a reachable repository succeeds and the page shows the added/updated/deactivated report', async () => {
		const res = await callSync(goodKbId);
		assert.equal(res.status, 200);
		const body = await res.text();
		assert.match(body, /Synchronisation complete/i);
		assert.match(body, /3 added/);
		assert.match(body, /0 updated/);
		assert.match(body, /0 deactivated/);
	});

	test('after a successful sync, the KB row has its lastSyncedAt stamped and its cards persisted', async () => {
		const raw = new Database(dbPath);
		const kbRow = raw.prepare('SELECT last_synced_at FROM knowledge_bases WHERE id = ?').get(goodKbId);
		const cardCount = raw.prepare('SELECT COUNT(*) AS n FROM cards WHERE kb_id = ? AND active = 1').get(goodKbId).n;
		raw.close();
		assert.ok(kbRow.last_synced_at !== null);
		assert.equal(cardCount, 3);
	});

	test('syncing a KB with an unreachable repository answers 502, not a crash, and never stamps lastSyncedAt', async () => {
		const res = await callSync(badKbId);
		assert.equal(res.status, 502);

		const raw = new Database(dbPath);
		const kbRow = raw.prepare('SELECT last_synced_at FROM knowledge_bases WHERE id = ?').get(badKbId);
		raw.close();
		assert.equal(kbRow.last_synced_at, null);
	});

	test('sync with a missing/non-numeric id answers 400, not a silent success', async () => {
		const res = await fetch(`${app.baseUrl}/kb?/sync`, {
			method: 'POST',
			redirect: 'manual',
			headers: { cookie, accept: 'text/html' },
			body: new URLSearchParams({ id: 'not-a-number' })
		});
		assert.equal(res.status, 400);
	});

	test('sync for an id that does not exist answers 404, not a silent success', async () => {
		const res = await callSync(999999);
		assert.equal(res.status, 404);
	});

	test('an unauthenticated attempt to trigger a sync is redirected by the guard, never executed', async () => {
		const res = await fetch(`${app.baseUrl}/kb?/sync`, {
			method: 'POST',
			redirect: 'manual',
			headers: { accept: 'text/html' },
			body: new URLSearchParams({ id: String(goodKbId) })
		});
		assert.equal(res.status, 303);
		assert.equal(res.headers.get('location'), '/login?redirectTo=' + encodeURIComponent('/kb?/sync'));
	});
});

test('the ROADMAP checks off tasks 6.1 through 6.7 (synchronisation and ingestion)', () => {
	const roadmap = fs.readFileSync(path.join(ROOT, 'docs', 'ROADMAP.md'), 'utf8');
	for (const taskId of ['6.1', '6.2', '6.3', '6.4', '6.5', '6.6', '6.7']) {
		const escaped = taskId.replace('.', '\\.');
		const line = roadmap.split('\n').find((l) => new RegExp(`\\*\\*${escaped}\\*\\*`).test(l));
		assert.ok(line, `expected to find the "${taskId}" task line in docs/ROADMAP.md`);
		assert.match(line, /^- \[x\]/i, `task ${taskId} must be checked off`);
	}
});
