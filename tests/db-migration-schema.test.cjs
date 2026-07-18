// Verifies tasks 2.1, 2.2 and 2.3 of docs/ROADMAP.md (section "2. Base de
// données"):
//   - 2.1 the Drizzle schema defines knowledge bases, cards, per-theme
//     preferences, bookmark categories, bookmarks and reading history, with
//     coherent primary/foreign keys, and deactivating a card must not
//     destroy the bookmarks/reading history that reference it.
//   - 2.2 Drizzle is configured with a drizzle-kit config file and a SQLite
//     client, and the database path is configurable through the
//     DATABASE_PATH environment variable (defaulting under data/, which is
//     gitignored).
//   - 2.3 the first migration, once applied through a reproducible
//     script/command (`npm run db:migrate`), creates the SQLite database
//     file with the expected tables.
//
// Every migration run in this file targets a throwaway temp directory via
// the DATABASE_PATH env var (or a temp cwd, for the "default path" case),
// so this suite never creates or touches the real data/ directory and can
// run concurrently with the rest of `node --test tests/`.
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

function readJson(relPath) {
	return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function readText(relPath) {
	return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

/**
 * Run the project's reproducible migration command (`npm run db:migrate`,
 * task 2.3) against an isolated database path, from the real project root
 * (so it picks up the committed drizzle.config.ts and drizzle/ migrations),
 * but always pointed at a throwaway location via DATABASE_PATH so it never
 * touches the real data/ directory.
 */
function runMigrate(databasePath, extraEnv) {
	const result = spawnSync('npm', ['run', 'db:migrate'], {
		cwd: ROOT,
		encoding: 'utf8',
		timeout: 60 * 1000,
		env: { ...process.env, DATABASE_PATH: databasePath, ...extraEnv }
	});

	if (result.error) {
		throw new Error(`spawning "npm run db:migrate" failed: ${result.error.message}`);
	}

	return result;
}

const EXPECTED_TABLES = [
	'knowledge_bases',
	'cards',
	'theme_preferences',
	'bookmark_categories',
	'bookmarks',
	'reading_history',
	'annotations'
].sort();

describe('applying the migration creates the SQLite database with the expected tables (task 2.3)', () => {
	let workDir;
	let databasePath;
	let migrateResult;
	let db;
	let Database;
	let realDbSnapshotBefore;
	const realDbPath = path.join(ROOT, 'data', 'distil.db');

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-db-migrate-'));
		databasePath = path.join(workDir, 'nested', 'distil-test.db');

		// Snapshot the real project database (if any) BEFORE running the
		// isolated migration below, so we can assert this suite never
		// creates or modifies it, without assuming it is absent: a
		// developer may legitimately already have data/distil.db locally
		// from running `npm run db:migrate` themselves.
		realDbSnapshotBefore = fs.existsSync(realDbPath)
			? { existed: true, mtimeMs: fs.statSync(realDbPath).mtimeMs, size: fs.statSync(realDbPath).size }
			: { existed: false };

		migrateResult = runMigrate(databasePath);

		// better-sqlite3 is a real runtime dependency of the app (not a test
		// mock): use it directly to inspect the file the migration produced.
		Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
	});

	after(() => {
		if (db) db.close();
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('the migrate command exits successfully', () => {
		assert.equal(
			migrateResult.status,
			0,
			`npm run db:migrate failed:\n${migrateResult.stdout}\n${migrateResult.stderr}`
		);
	});

	test('the database file is created at the DATABASE_PATH location, including missing parent directories', () => {
		assert.ok(
			fs.existsSync(databasePath),
			`expected the migration to create the database file at ${databasePath}`
		);
	});

	test('the isolated migration run does not create or modify the real project data/distil.db', () => {
		if (!realDbSnapshotBefore.existed) {
			assert.ok(
				!fs.existsSync(realDbPath),
				'the isolated migration run must never create the real data/distil.db'
			);
			return;
		}

		const after = fs.statSync(realDbPath);
		assert.equal(
			after.mtimeMs,
			realDbSnapshotBefore.mtimeMs,
			'the isolated migration run must never modify a pre-existing real data/distil.db'
		);
		assert.equal(
			after.size,
			realDbSnapshotBefore.size,
			'the isolated migration run must never modify a pre-existing real data/distil.db'
		);
	});

	test('all expected tables exist after migration', () => {
		db = new Database(databasePath);
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
			.all()
			.map((row) => row.name)
			.filter((name) => name !== '__drizzle_migrations')
			.sort();

		assert.deepEqual(tables, EXPECTED_TABLES);
	});

	test('package.json exposes reproducible db:generate / db:migrate scripts', () => {
		const pkg = readJson('package.json');
		assert.ok(pkg.scripts?.['db:migrate'], 'package.json should define a "db:migrate" script');
		assert.match(pkg.scripts['db:migrate'], /drizzle-kit/);
		assert.ok(pkg.scripts?.['db:generate'], 'package.json should define a "db:generate" script');
	});

	test('a committed SQL migration file exists under drizzle/', () => {
		const migrationFiles = fs
			.readdirSync(path.join(ROOT, 'drizzle'))
			.filter((f) => f.endsWith('.sql'));
		assert.ok(migrationFiles.length > 0, 'expected at least one .sql migration file under drizzle/');
	});
});

describe('the DATABASE_PATH environment variable configures where the database is created (task 2.2)', () => {
	test('a custom DATABASE_PATH is honoured by the migration command', () => {
		const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-db-path-'));
		try {
			const customPath = path.join(workDir, 'custom-name.sqlite3');
			const result = runMigrate(customPath);

			assert.equal(result.status, 0, `migration failed:\n${result.stdout}\n${result.stderr}`);
			assert.ok(fs.existsSync(customPath), 'the database should be created at the custom DATABASE_PATH');
		} finally {
			fs.rmSync(workDir, { recursive: true, force: true });
		}
	});

	test('without DATABASE_PATH, the database defaults under a data/ directory relative to the working directory', () => {
		// Reproduce a minimal fresh-checkout layout (package.json, the
		// drizzle config/migrations and the db module, whose relative
		// "schema"/"out" paths in drizzle.config.ts are resolved against the
		// working directory) inside a throwaway temp directory, with
		// node_modules symlinked in rather than copied. This exercises the
		// default DATABASE_PATH resolution exactly like `npm run db:migrate`
		// would on a real checkout, without ever writing into the real
		// project's data/ directory or paying the cost of copying
		// node_modules.
		const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-db-default-'));
		try {
			fs.mkdirSync(path.join(workDir, 'src', 'lib', 'server', 'db'), { recursive: true });
			fs.mkdirSync(path.join(workDir, 'drizzle'), { recursive: true });
			fs.cpSync(path.join(ROOT, 'package.json'), path.join(workDir, 'package.json'));
			fs.cpSync(path.join(ROOT, 'drizzle.config.ts'), path.join(workDir, 'drizzle.config.ts'));
			fs.cpSync(path.join(ROOT, 'drizzle'), path.join(workDir, 'drizzle'), { recursive: true });
			fs.cpSync(path.join(ROOT, 'src', 'lib', 'server', 'db'), path.join(workDir, 'src', 'lib', 'server', 'db'), {
				recursive: true
			});
			fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(workDir, 'node_modules'), 'dir');

			const result = spawnSync('npm', ['run', 'db:migrate'], {
				cwd: workDir,
				encoding: 'utf8',
				timeout: 60 * 1000,
				env: { ...process.env, DATABASE_PATH: '' }
			});
			if (result.error) {
				throw new Error(`spawning "npm run db:migrate" failed: ${result.error.message}`);
			}

			assert.equal(result.status, 0, `migration failed:\n${result.stdout}\n${result.stderr}`);
			assert.ok(
				fs.existsSync(path.join(workDir, 'data', 'distil.db')),
				'expected the default database path to be "data/distil.db" relative to the working directory'
			);
		} finally {
			fs.rmSync(workDir, { recursive: true, force: true });
		}
	});

	test('the default path lives under data/, which .gitignore excludes', () => {
		const gitignore = readText('.gitignore');
		assert.match(gitignore, /(^|\n)\/?data\//, '.gitignore should exclude the data/ directory');
	});
});

describe('schema integrity: foreign keys and coherent design (task 2.1)', () => {
	let workDir;
	let databasePath;
	let db;
	let Database;
	let kbId;
	let categoryId;
	let cardId;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-db-integrity-'));
		databasePath = path.join(workDir, 'integrity.db');

		const migrateResult = runMigrate(databasePath);
		assert.equal(
			migrateResult.status,
			0,
			`npm run db:migrate failed:\n${migrateResult.stdout}\n${migrateResult.stderr}`
		);

		Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
		db = new Database(databasePath);
		// Matches the pragma applied by the app's real connection helper
		// (src/lib/server/db/index.ts): foreign keys are off by default in
		// SQLite and must be turned on explicitly.
		db.pragma('foreign_keys = ON');
	});

	after(() => {
		if (db) db.close();
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('cards.kb_id is declared as a foreign key to knowledge_bases.id', () => {
		const fks = db.prepare('PRAGMA foreign_key_list(cards)').all();
		const kbFk = fks.find((fk) => fk.table === 'knowledge_bases');
		assert.ok(kbFk, 'cards should declare a foreign key to knowledge_bases');
		assert.equal(kbFk.from, 'kb_id');
		assert.equal(kbFk.to, 'id');
	});

	test('bookmarks.card_id and bookmarks.category_id are declared as foreign keys', () => {
		const fks = db.prepare('PRAGMA foreign_key_list(bookmarks)').all();
		const cardFk = fks.find((fk) => fk.table === 'cards');
		const categoryFk = fks.find((fk) => fk.table === 'bookmark_categories');
		assert.ok(cardFk, 'bookmarks should declare a foreign key to cards');
		assert.equal(cardFk.from, 'card_id');
		assert.ok(categoryFk, 'bookmarks should declare a foreign key to bookmark_categories');
		assert.equal(categoryFk.from, 'category_id');
	});

	test('reading_history.card_id is declared as a foreign key to cards.id', () => {
		const fks = db.prepare('PRAGMA foreign_key_list(reading_history)').all();
		const cardFk = fks.find((fk) => fk.table === 'cards');
		assert.ok(cardFk, 'reading_history should declare a foreign key to cards');
		assert.equal(cardFk.from, 'card_id');
		assert.equal(cardFk.to, 'id');
	});

	test('foreign keys are enforced: inserting a card with an unknown kb_id is rejected', () => {
		assert.throws(() => {
			db.prepare(
				"INSERT INTO cards (kb_id, slug, title) VALUES (999999, 'orphan-slug', 'Orphan card')"
			).run();
		}, /FOREIGN KEY constraint failed/i);
	});

	test('set up a KB, a bookmark category, a card, a bookmark and a reading-history entry', () => {
		kbId = db
			.prepare(
				"INSERT INTO knowledge_bases (name, repo_url, branch, content_subdir) VALUES ('Test KB', 'https://example.test/repo.git', 'main', 'content') RETURNING id"
			)
			.get().id;

		categoryId = db.prepare("INSERT INTO bookmark_categories (name) VALUES ('Favorites') RETURNING id").get().id;

		cardId = db
			.prepare(
				'INSERT INTO cards (kb_id, slug, title, theme, active) VALUES (?, ?, ?, ?, 1) RETURNING id'
			)
			.get(kbId, 'card-1', 'Card One', 'general').id;

		db.prepare('INSERT INTO bookmarks (card_id, category_id) VALUES (?, ?)').run(cardId, categoryId);
		db.prepare('INSERT INTO reading_history (card_id) VALUES (?)').run(cardId);

		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE card_id = ?').get(cardId).n, 1);
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reading_history WHERE card_id = ?').get(cardId).n, 1);
	});

	test('deactivating a card does NOT destroy its bookmarks or reading history', () => {
		db.prepare('UPDATE cards SET active = 0 WHERE id = ?').run(cardId);

		const card = db.prepare('SELECT active FROM cards WHERE id = ?').get(cardId);
		assert.equal(card.active, 0, 'the card should now be inactive');

		assert.equal(
			db.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE card_id = ?').get(cardId).n,
			1,
			'deactivating a card must not delete its bookmarks'
		);
		assert.equal(
			db.prepare('SELECT COUNT(*) AS n FROM reading_history WHERE card_id = ?').get(cardId).n,
			1,
			'deactivating a card must not delete its reading history'
		);
	});

	test('deleting the knowledge base cascades to its cards (genuine hard delete)', () => {
		db.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(kbId);

		assert.equal(
			db.prepare('SELECT COUNT(*) AS n FROM cards WHERE id = ?').get(cardId).n,
			0,
			'deleting a knowledge base should cascade-delete its cards'
		);
	});
});

test('the ROADMAP checks off tasks 2.1, 2.2 and 2.3 (database)', () => {
	const roadmap = readText('docs/ROADMAP.md');
	for (const taskId of ['2.1', '2.2', '2.3']) {
		const escaped = taskId.replace('.', '\\.');
		const line = roadmap.split('\n').find((l) => new RegExp(`\\*\\*${escaped}\\*\\*`).test(l));
		assert.ok(line, `expected to find the "${taskId}" task line in docs/ROADMAP.md`);
		assert.match(line, /^- \[x\]/i, `task ${taskId} must be checked off`);
	}
});
