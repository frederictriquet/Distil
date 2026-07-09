// Verifies tasks 4.1, 4.2 and 4.3 of docs/ROADMAP.md (section "4. Gestion des
// bases de connaissances (KB)"):
//   - 4.1 knowledge bases can be listed with, for each, its number of active
//     cards (COUNT of cards where kbId matches and active = true), correctly
//     scoped per KB, and a lastSyncedAt that is null ("never synced") until a
//     sync happens.
//   - 4.2 a new KB can be created from validated input: name and repoUrl are
//     required, branch defaults to 'main' when left empty, contentSubdir is
//     optional.
//   - 4.3 a KB's focus flag can be toggled on/off, and deleting a KB removes
//     its row (cascading its cards through the schema foreign key) and
//     best-effort purges its local repo cache directory, tolerating an
//     already-absent cache.
//
// These exercise the real `src/lib/server/kb.ts` module (the logic behind the
// /kb management page) against a real, freshly migrated SQLite database.
// Because that module is TypeScript with extension-less relative imports
// (`./db/schema`, resolved by the bundler/svelte-kit at build time but not by
// plain Node ESM), each check runs it out-of-process through `tsx` — the
// loader already pulled in transitively by this project's own `drizzle-kit`
// dependency — via a small harness script written to a throwaway temp file.
// Every database file and cache directory used here lives under a fresh
// `mkdtempSync` directory, so this suite never touches the real project
// `data/` tree and can run concurrently with the rest of `node --test tests/`.
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
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const TSX_CLI = require.resolve('tsx/cli');
const DRIZZLE_KIT_CLI = path.join(ROOT, 'node_modules', 'drizzle-kit', 'bin.cjs');

/**
 * Run the project's reproducible migration ("npm run db:migrate", task 2.3)
 * by invoking the drizzle-kit CLI's own entry point through the current
 * Node executable, rather than shelling out to `npm run`, so each describe
 * block below starts from a real, freshly migrated schema. Spawning `npm`
 * without `shell: true` fails on Windows (npm is `npm.cmd`, and Node's
 * spawnSync cannot exec a .cmd file directly), which would violate this
 * project's rule that the test suite must run on Windows; invoking the
 * CLI's .cjs file directly via `process.execPath` avoids a shell on every
 * platform.
 */
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

// Harness executed by `tsx` (in a fresh process) so it can load the real
// `src/lib/server/kb.ts` and `src/lib/server/db/index.ts` modules exactly as
// SvelteKit does, dispatch one CRUD action from `kb.ts` against the given
// SQLite file, and print the JSON result on stdout.
const HARNESS_SOURCE = `
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [, , rootDir, dbPath, action, payloadJson] = process.argv;
const payload = JSON.parse(payloadJson || '{}');

const dbIndexUrl = pathToFileURL(path.join(rootDir, 'src', 'lib', 'server', 'db', 'index.ts')).href;
const kbUrl = pathToFileURL(path.join(rootDir, 'src', 'lib', 'server', 'kb.ts')).href;

const { createSqliteConnection, createDb } = await import(dbIndexUrl);
const kb = await import(kbUrl);

const sqlite = createSqliteConnection(dbPath);
const db = createDb(sqlite);

function run() {
	switch (action) {
		case 'create':
			return kb.createKnowledgeBase(db, payload);
		case 'list':
			return kb.listKnowledgeBases(db);
		case 'toggleFocus':
			return { focus: kb.toggleKnowledgeBaseFocus(db, payload.id) };
		case 'delete':
			kb.deleteKnowledgeBase(db, payload.id, payload.cacheBaseDir);
			return { ok: true };
		case 'parse':
			return kb.parseKnowledgeBaseInput(payload);
		default:
			throw new Error('unknown harness action: ' + action);
	}
}

try {
	const result = run();
	process.stdout.write(JSON.stringify(result === undefined ? null : result));
} finally {
	sqlite.close();
}
`;

let harnessDir;
let harnessPath;

before(() => {
	harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-kb-harness-'));
	harnessPath = path.join(harnessDir, 'kb-harness.mjs');
	fs.writeFileSync(harnessPath, HARNESS_SOURCE, 'utf8');
});

after(() => {
	if (harnessDir) fs.rmSync(harnessDir, { recursive: true, force: true });
});

/** Run one `kb.ts` action, out-of-process via tsx, and return its parsed JSON result. */
function runKb(databasePath, action, payload) {
	const result = spawnSync(
		process.execPath,
		[TSX_CLI, harnessPath, ROOT, databasePath, action, JSON.stringify(payload ?? {})],
		{ cwd: ROOT, encoding: 'utf8', timeout: 30 * 1000 }
	);

	if (result.error) {
		throw new Error(`running kb action "${action}" failed to spawn: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`kb action "${action}" exited with ${result.status}:\n${result.stdout}\n${result.stderr}`);
	}
	const output = result.stdout.trim();
	return output.length > 0 ? JSON.parse(output) : undefined;
}

describe('validating new-KB input (task 4.2)', () => {
	let workDir;
	let dbPath;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-kb-parse-'));
		// parseKnowledgeBaseInput never touches the database, so no migration
		// is needed for these cases; the harness still opens a throwaway file.
		dbPath = path.join(workDir, 'unused.db');
	});

	after(() => {
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('rejects an empty name and an empty repository URL', () => {
		const result = runKb(dbPath, 'parse', { name: '', repoUrl: '', branch: '', contentSubdir: '' });
		assert.equal(result.ok, false);
		assert.match(result.errors.name, /required/i);
		assert.match(result.errors.repoUrl, /required/i);
	});

	test('rejects a whitespace-only name and repository URL (trimmed to empty)', () => {
		const result = runKb(dbPath, 'parse', { name: '   ', repoUrl: '  \t ', branch: 'main', contentSubdir: '' });
		assert.equal(result.ok, false);
		assert.ok(result.errors.name);
		assert.ok(result.errors.repoUrl);
	});

	test('reports only the missing field when just one of name/repoUrl is present', () => {
		const result = runKb(dbPath, 'parse', { name: 'My KB', repoUrl: '', branch: '', contentSubdir: '' });
		assert.equal(result.ok, false);
		assert.equal(result.errors.name, undefined);
		assert.ok(result.errors.repoUrl);
	});

	test('defaults branch to "main" when left empty, and accepts a valid name + repoUrl', () => {
		const result = runKb(dbPath, 'parse', {
			name: 'My KB',
			repoUrl: 'https://example.test/repo.git',
			branch: '',
			contentSubdir: ''
		});
		assert.equal(result.ok, true);
		assert.equal(result.value.name, 'My KB');
		assert.equal(result.value.repoUrl, 'https://example.test/repo.git');
		assert.equal(result.value.branch, 'main');
		assert.equal(result.value.contentSubdir, '');
	});

	test('keeps an explicit branch and contentSubdir, trimmed', () => {
		const result = runKb(dbPath, 'parse', {
			name: '  My KB  ',
			repoUrl: '  https://example.test/repo.git  ',
			branch: '  develop  ',
			contentSubdir: '  docs/cards  '
		});
		assert.equal(result.ok, true);
		assert.equal(result.value.name, 'My KB');
		assert.equal(result.value.repoUrl, 'https://example.test/repo.git');
		assert.equal(result.value.branch, 'develop');
		assert.equal(result.value.contentSubdir, 'docs/cards');
	});
});

describe('creating and listing knowledge bases with active-card counts (task 4.1 & 4.2)', () => {
	let workDir;
	let dbPath;
	let raw;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-kb-list-'));
		dbPath = path.join(workDir, 'kb.db');
		runMigrate(dbPath);
	});

	after(() => {
		if (raw) raw.close();
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	/** Open a short-lived raw connection to insert test fixtures directly. */
	function withRawDb(fn) {
		const conn = new Database(dbPath);
		try {
			return fn(conn);
		} finally {
			conn.close();
		}
	}

	let kbAId;
	let kbBId;

	test('creating a KB persists it with focus off and never synced', () => {
		const created = runKb(dbPath, 'create', {
			name: 'KB Alpha',
			repoUrl: 'https://example.test/alpha.git',
			branch: 'main',
			contentSubdir: 'content'
		});
		assert.ok(Number.isInteger(created.id));
		assert.equal(created.name, 'KB Alpha');
		assert.equal(created.repoUrl, 'https://example.test/alpha.git');
		assert.equal(created.branch, 'main');
		assert.equal(created.contentSubdir, 'content');
		assert.equal(created.focus, false);
		assert.equal(created.lastSyncedAt, null);
		kbAId = created.id;
	});

	test('a freshly created KB with no cards lists with an active-card count of 0', () => {
		const list = runKb(dbPath, 'list', {});
		const kb = list.find((row) => row.id === kbAId);
		assert.ok(kb, 'expected the created KB to appear in the listing');
		assert.equal(kb.activeCardCount, 0);
		assert.equal(kb.lastSyncedAt, null);
	});

	test('active-card count only counts cards where active = true, scoped to that KB', () => {
		withRawDb((conn) => {
			conn
				.prepare(
					'INSERT INTO cards (kb_id, slug, title, active) VALUES (?, ?, ?, 1)'
				)
				.run(kbAId, 'card-1', 'Card One');
			conn
				.prepare(
					'INSERT INTO cards (kb_id, slug, title, active) VALUES (?, ?, ?, 1)'
				)
				.run(kbAId, 'card-2', 'Card Two');
			conn
				.prepare(
					'INSERT INTO cards (kb_id, slug, title, active) VALUES (?, ?, ?, 0)'
				)
				.run(kbAId, 'card-3-inactive', 'Card Three (inactive)');
		});

		const list = runKb(dbPath, 'list', {});
		const kb = list.find((row) => row.id === kbAId);
		assert.equal(kb.activeCardCount, 2, 'inactive cards must not be counted');
	});

	test('a second KB with its own active cards reports an independent count, not conflated with the first', () => {
		const createdB = runKb(dbPath, 'create', {
			name: 'KB Beta',
			repoUrl: 'https://example.test/beta.git',
			branch: 'main',
			contentSubdir: ''
		});
		kbBId = createdB.id;

		withRawDb((conn) => {
			conn
				.prepare('INSERT INTO cards (kb_id, slug, title, active) VALUES (?, ?, ?, 1)')
				.run(kbBId, 'beta-card-1', 'Beta Card One');
		});

		const list = runKb(dbPath, 'list', {});
		const kbA = list.find((row) => row.id === kbAId);
		const kbB = list.find((row) => row.id === kbBId);
		assert.equal(kbA.activeCardCount, 2, 'KB Alpha count must be unaffected by KB Beta cards');
		assert.equal(kbB.activeCardCount, 1);
	});
});

describe('toggling a KB focus flag (task 4.3)', () => {
	let workDir;
	let dbPath;
	let raw;
	let kbId;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-kb-focus-'));
		dbPath = path.join(workDir, 'kb.db');
		runMigrate(dbPath);

		const created = runKb(dbPath, 'create', {
			name: 'Focus KB',
			repoUrl: 'https://example.test/focus.git',
			branch: 'main',
			contentSubdir: ''
		});
		kbId = created.id;
	});

	after(() => {
		if (raw) raw.close();
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('a newly created KB starts with focus off', () => {
		raw = new Database(dbPath);
		const row = raw.prepare('SELECT focus FROM knowledge_bases WHERE id = ?').get(kbId);
		assert.equal(row.focus, 0);
		raw.close();
		raw = undefined;
	});

	test('toggling turns focus on and reports the new value', () => {
		const result = runKb(dbPath, 'toggleFocus', { id: kbId });
		assert.equal(result.focus, true);

		raw = new Database(dbPath);
		const row = raw.prepare('SELECT focus FROM knowledge_bases WHERE id = ?').get(kbId);
		assert.equal(row.focus, 1);
		raw.close();
		raw = undefined;
	});

	test('toggling again turns focus back off', () => {
		const result = runKb(dbPath, 'toggleFocus', { id: kbId });
		assert.equal(result.focus, false);

		raw = new Database(dbPath);
		const row = raw.prepare('SELECT focus FROM knowledge_bases WHERE id = ?').get(kbId);
		assert.equal(row.focus, 0);
		raw.close();
		raw = undefined;
	});

	test('toggling an unknown KB id reports no focus value (not found)', () => {
		const result = runKb(dbPath, 'toggleFocus', { id: kbId + 999 });
		assert.equal(result.focus, undefined);
	});
});

describe('deleting a KB cascades its cards and purges its local cache (task 4.3)', () => {
	let workDir;
	let dbPath;
	let cacheBaseDir;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-kb-delete-'));
		dbPath = path.join(workDir, 'kb.db');
		cacheBaseDir = path.join(workDir, 'kb-cache');
		runMigrate(dbPath);
	});

	after(() => {
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('deleting a KB removes its row and cascades its cards, and purges an existing cache directory', () => {
		const created = runKb(dbPath, 'create', {
			name: 'Doomed KB',
			repoUrl: 'https://example.test/doomed.git',
			branch: 'main',
			contentSubdir: ''
		});
		const kbId = created.id;

		const raw = new Database(dbPath);
		raw.prepare('INSERT INTO cards (kb_id, slug, title, active) VALUES (?, ?, ?, 1)').run(kbId, 'c1', 'C1');
		raw.prepare('INSERT INTO cards (kb_id, slug, title, active) VALUES (?, ?, ?, 0)').run(kbId, 'c2', 'C2');
		assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM cards WHERE kb_id = ?').get(kbId).n, 2);
		raw.close();

		const kbCacheDir = path.join(cacheBaseDir, String(kbId));
		fs.mkdirSync(kbCacheDir, { recursive: true });
		fs.writeFileSync(path.join(kbCacheDir, 'README.md'), 'cached repo content', 'utf8');
		assert.ok(fs.existsSync(kbCacheDir), 'sanity check: the fake cache directory should exist before deletion');

		const result = runKb(dbPath, 'delete', { id: kbId, cacheBaseDir });
		assert.equal(result.ok, true);

		const rawAfter = new Database(dbPath);
		assert.equal(
			rawAfter.prepare('SELECT COUNT(*) AS n FROM knowledge_bases WHERE id = ?').get(kbId).n,
			0,
			'the knowledge base row must be removed'
		);
		assert.equal(
			rawAfter.prepare('SELECT COUNT(*) AS n FROM cards WHERE kb_id = ?').get(kbId).n,
			0,
			'deleting a knowledge base must cascade-delete its cards, including inactive ones'
		);
		rawAfter.close();

		assert.ok(!fs.existsSync(kbCacheDir), 'the local repo cache directory must be purged');
	});

	test('deleting a KB with no local cache directory does not fail (nothing to purge)', () => {
		const created = runKb(dbPath, 'create', {
			name: 'Never Synced KB',
			repoUrl: 'https://example.test/never-synced.git',
			branch: 'main',
			contentSubdir: ''
		});
		const kbId = created.id;

		// No cache directory was ever created for this KB under cacheBaseDir.
		const result = runKb(dbPath, 'delete', { id: kbId, cacheBaseDir });
		assert.equal(result.ok, true);

		const raw = new Database(dbPath);
		assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM knowledge_bases WHERE id = ?').get(kbId).n, 0);
		raw.close();
	});
});

test('the ROADMAP checks off tasks 4.1, 4.2 and 4.3 (knowledge base management)', () => {
	const roadmap = fs.readFileSync(path.join(ROOT, 'docs', 'ROADMAP.md'), 'utf8');
	for (const taskId of ['4.1', '4.2', '4.3']) {
		const escaped = taskId.replace('.', '\\.');
		const line = roadmap.split('\n').find((l) => new RegExp(`\\*\\*${escaped}\\*\\*`).test(l));
		assert.ok(line, `expected to find the "${taskId}" task line in docs/ROADMAP.md`);
		assert.match(line, /^- \[x\]/i, `task ${taskId} must be checked off`);
	}
});
