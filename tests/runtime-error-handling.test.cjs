// Verifies the "runtime-error-handling" debt fix (src/lib/server/kb.ts,
// src/lib/server/db/index.ts, src/routes/kb/+page.server.ts):
//   - deleting a KB purges its local repo cache best-effort: an expected fs
//     error (a locked/permission-denied file, standing in here for the
//     documented EBUSY/EPERM Windows case) must not abort the operation —
//     the KB row is still removed and no error is thrown — while a genuinely
//     unexpected fs error must NOT be silently swallowed.
//   - the shared better-sqlite3 connection is closed once the process
//     actually exits (the portable `process.on('exit', ...)` hook), so the
//     WAL gets checkpointed whenever something else — in production,
//     @sveltejs/adapter-node's own SIGINT/SIGTERM handling, which drains
//     in-flight requests before calling process.exit() itself — lets the
//     process terminate; receiving SIGINT/SIGTERM must NOT itself force an
//     immediate exit, since that would race and abort that graceful drain;
//     the registration is idempotent (no duplicate listeners, and no extra
//     SIGINT/SIGTERM listeners of its own); and closeDb() is safe to call
//     more than once.
//   - a SQLite UNIQUE-constraint violation on creating a duplicate knowledge
//     base (same repoUrl + branch) is recognised as a duplicate and mapped
//     by the real /kb "create" form action to a 400 field error, not an
//     unhandled 500.
//
// Every check here runs the real `src/lib/server/kb.ts`, `src/lib/server/db/
// index.ts` and `src/routes/kb/+page.server.ts` modules out-of-process
// through `tsx` (this project's own transitive dependency via drizzle-kit),
// via small harness scripts written to a throwaway temp file, mirroring the
// pattern already used by tests/kb-management.test.cjs. Every database file
// and cache directory used lives under a fresh `mkdtempSync` directory, so
// this suite never touches the real project `data/` tree.
//
// Run with: node --test tests/
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const TSX_CLI = require.resolve('tsx/cli');
const DRIZZLE_KIT_CLI = path.join(ROOT, 'node_modules', 'drizzle-kit', 'bin.cjs');

/**
 * Run the project's reproducible migration against an isolated database
 * path, invoking the drizzle-kit CLI's own entry point through the current
 * Node executable (not `npm run`, which needs a shell/`.cmd` on Windows).
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

// Dispatch harness for the pure kb.ts / db/index.ts logic. Uses the real
// lazy `db` singleton (via DATABASE_PATH), exactly like the SvelteKit route
// code, so closeDb()/registerDbShutdownHooks() operate on the same
// connection the rest of the app would use.
const MAIN_HARNESS_SOURCE = `
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [, , rootDir, action, payloadJson] = process.argv;
const payload = JSON.parse(payloadJson || '{}');

const dbMod = await import(pathToFileURL(path.join(rootDir, 'src', 'lib', 'server', 'db', 'index.ts')).href);
const kb = await import(pathToFileURL(path.join(rootDir, 'src', 'lib', 'server', 'kb.ts')).href);

function run() {
	switch (action) {
		case 'createKb':
			return kb.createKnowledgeBase(dbMod.db, payload);
		case 'purgeCache':
			try {
				kb.purgeKnowledgeBaseCache(payload.id, payload.cacheBaseDir);
				return { threw: false };
			} catch (error) {
				return { threw: true, code: error && error.code };
			}
		case 'deleteKb':
			try {
				const result = kb.deleteKnowledgeBase(dbMod.db, payload.id, payload.cacheBaseDir);
				return { threw: false, result };
			} catch (error) {
				return { threw: true, code: error && error.code };
			}
		case 'createDuplicateRaw':
			kb.createKnowledgeBase(dbMod.db, payload);
			try {
				kb.createKnowledgeBase(dbMod.db, payload);
				return { secondThrew: false };
			} catch (error) {
				return { secondThrew: true, recognizedAsDuplicate: kb.isDuplicateKnowledgeBaseError(error) };
			}
		case 'listenerCounts': {
			const before = {
				sigterm: process.listenerCount('SIGTERM'),
				sigint: process.listenerCount('SIGINT'),
				exit: process.listenerCount('exit')
			};
			dbMod.registerDbShutdownHooks();
			dbMod.registerDbShutdownHooks();
			const after = {
				sigterm: process.listenerCount('SIGTERM'),
				sigint: process.listenerCount('SIGINT'),
				exit: process.listenerCount('exit')
			};
			return { before, after };
		}
		case 'closeDbSafe':
			dbMod.closeDb(); // never opened yet — must be a safe no-op
			kb.listKnowledgeBases(dbMod.db); // opens the lazy connection
			dbMod.closeDb();
			dbMod.closeDb(); // already closed — must still not throw
			return { ok: true };
		default:
			throw new Error('unknown harness action: ' + action);
	}
}

const result = run();
process.stdout.write(JSON.stringify(result === undefined ? null : result));
`;

// Separate harness for the real /kb route action (not the internal kb.ts
// helpers), to prove the user-facing "create" form action itself maps a
// duplicate submission to a 400 rather than throwing.
const ACTION_HARNESS_SOURCE = `
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [, , rootDir, action, payloadJson] = process.argv;
const payload = JSON.parse(payloadJson || '{}');

const mod = await import(pathToFileURL(path.join(rootDir, 'src', 'routes', 'kb', '+page.server.ts')).href);

function fakeRequest(fields) {
	const fd = new FormData();
	for (const [key, value] of Object.entries(fields)) fd.set(key, value);
	return { formData: async () => fd };
}

async function run() {
	switch (action) {
		case 'createDuplicateViaAction': {
			const first = await mod.actions.create({ request: fakeRequest(payload.fields) });
			const second = await mod.actions.create({ request: fakeRequest(payload.fields) });
			return { first, second };
		}
		default:
			throw new Error('unknown harness action: ' + action);
	}
}

process.stdout.write(JSON.stringify(await run()));
`;

// Standalone (non-dispatch) harness for the process-shutdown tests: it
// registers the shutdown hooks, opens the lazy `db` singleton and performs
// one write (so a WAL file actually exists to be checkpointed), then prints a
// READY marker and idles so the parent test can act at a known point instead
// of racing process startup. Writing "EXIT\n" to its stdin makes it call
// process.exit(0) itself — standing in for @sveltejs/adapter-node calling
// process.exit() once its own graceful drain (triggered by the signal it
// caught) has finished, which is the only thing that should make this
// process actually terminate.
const SHUTDOWN_HARNESS_SOURCE = `
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [, , rootDir] = process.argv;

const dbMod = await import(pathToFileURL(path.join(rootDir, 'src', 'lib', 'server', 'db', 'index.ts')).href);
const kb = await import(pathToFileURL(path.join(rootDir, 'src', 'lib', 'server', 'kb.ts')).href);

dbMod.registerDbShutdownHooks();

kb.createKnowledgeBase(dbMod.db, {
	name: 'shutdown-probe',
	repoUrl: 'https://example.test/shutdown-probe.git',
	branch: 'main',
	contentSubdir: ''
});

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
	if (chunk.includes('EXIT')) {
		process.exit(0);
	}
});

process.stdout.write('READY\\n');
setInterval(() => {}, 1000);
`;

let harnessDir;
let mainHarnessPath;
let actionHarnessPath;
let shutdownHarnessPath;

before(() => {
	harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-runtime-errors-harness-'));
	mainHarnessPath = path.join(harnessDir, 'main-harness.mjs');
	actionHarnessPath = path.join(harnessDir, 'action-harness.mjs');
	shutdownHarnessPath = path.join(harnessDir, 'shutdown-harness.mjs');
	fs.writeFileSync(mainHarnessPath, MAIN_HARNESS_SOURCE, 'utf8');
	fs.writeFileSync(actionHarnessPath, ACTION_HARNESS_SOURCE, 'utf8');
	fs.writeFileSync(shutdownHarnessPath, SHUTDOWN_HARNESS_SOURCE, 'utf8');
});

after(() => {
	if (harnessDir) fs.rmSync(harnessDir, { recursive: true, force: true });
});

/** Run one dispatch action against a given database, via the real `db` singleton (DATABASE_PATH). */
function runMain(databasePath, action, payload) {
	const result = spawnSync(
		process.execPath,
		[TSX_CLI, mainHarnessPath, ROOT, action, JSON.stringify(payload ?? {})],
		{ cwd: ROOT, encoding: 'utf8', timeout: 30 * 1000, env: { ...process.env, DATABASE_PATH: databasePath } }
	);

	if (result.error) {
		throw new Error(`running main harness action "${action}" failed to spawn: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`main harness action "${action}" exited with ${result.status}:\n${result.stdout}\n${result.stderr}`);
	}
	const output = result.stdout.trim();
	return output.length > 0 ? JSON.parse(output) : undefined;
}

/** Run one dispatch action against the real /kb route module, via the real `db` singleton (DATABASE_PATH). */
function runAction(databasePath, action, payload) {
	const result = spawnSync(
		process.execPath,
		[TSX_CLI, actionHarnessPath, ROOT, action, JSON.stringify(payload ?? {})],
		{ cwd: ROOT, encoding: 'utf8', timeout: 30 * 1000, env: { ...process.env, DATABASE_PATH: databasePath } }
	);

	if (result.error) {
		throw new Error(`running route action "${action}" failed to spawn: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`route action "${action}" exited with ${result.status}:\n${result.stdout}\n${result.stderr}`);
	}
	const output = result.stdout.trim();
	return output.length > 0 ? JSON.parse(output) : undefined;
}

/**
 * Spawn the shutdown harness against `databasePath`, wait for its READY
 * marker, then write "EXIT\n" to its stdin so it calls process.exit(0)
 * itself — standing in for adapter-node's own eventual exit once its
 * graceful drain completes — and resolve with how the process terminated.
 * A guard timeout rejects instead of hanging the suite if it never exits.
 */
function runShutdownHarnessUntilExit(databasePath) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [TSX_CLI, shutdownHarnessPath, ROOT], {
			cwd: ROOT,
			env: { ...process.env, DATABASE_PATH: databasePath }
		});

		let stdout = '';
		let stderr = '';
		let exitRequested = false;
		const guard = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`shutdown harness did not exit after requesting EXIT.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
		}, 10 * 1000);

		child.stdout.on('data', (chunk) => {
			stdout += chunk.toString();
			if (!exitRequested && stdout.includes('READY')) {
				exitRequested = true;
				child.stdin.write('EXIT\n');
			}
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString();
		});
		child.on('error', (error) => {
			clearTimeout(guard);
			reject(error);
		});
		child.on('exit', (code, signal) => {
			clearTimeout(guard);
			resolve({ code, signal, stdout, stderr });
		});
	});
}

/**
 * Spawn the shutdown harness against `databasePath`, wait for its READY
 * marker, then deliver `signal` and confirm the process does NOT terminate
 * on its own: registerDbShutdownHooks() must not force an immediate exit on
 * SIGINT/SIGTERM, since in production that would race and abort
 * adapter-node's own graceful drain of in-flight requests. The child is
 * force-killed afterwards purely as test cleanup, not as an assertion.
 */
function runShutdownHarnessSignalMustNotExit(databasePath, signal) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [TSX_CLI, shutdownHarnessPath, ROOT], {
			cwd: ROOT,
			env: { ...process.env, DATABASE_PATH: databasePath }
		});

		let stdout = '';
		let stderr = '';
		let signalSent = false;
		let settled = false;

		const guard = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill('SIGKILL');
			reject(new Error(`shutdown harness never became ready.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
		}, 10 * 1000);

		child.stdout.on('data', (chunk) => {
			stdout += chunk.toString();
			if (!signalSent && stdout.includes('READY')) {
				signalSent = true;
				child.kill(signal);
				setTimeout(() => {
					if (settled) return;
					settled = true;
					clearTimeout(guard);
					child.kill('SIGKILL');
					resolve({ stayedAlive: true, stdout, stderr });
				}, 500);
			}
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString();
		});
		child.on('error', (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(guard);
			reject(error);
		});
		child.on('exit', (code, receivedSignal) => {
			if (settled) return;
			settled = true;
			clearTimeout(guard);
			reject(
				new Error(
					`the process exited (code=${code}, signal=${receivedSignal}) in reaction to ${signal} instead of staying alive for a graceful drain.\nstdout:\n${stdout}\nstderr:\n${stderr}`
				)
			);
		});
	});
}

describe('best-effort local-cache purge is non-fatal on expected fs errors', () => {
	let workDir;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-purge-'));
	});

	after(() => {
		// Restore write permission before cleanup, else rmSync itself would
		// hit the very same EACCES this suite is exercising.
		fs.chmodSync(path.join(workDir, 'cache-expected', '1'), 0o755);
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('purgeKnowledgeBaseCache swallows an expected fs error (EACCES) and does not throw', () => {
		const cacheBaseDir = path.join(workDir, 'cache-expected');
		const lockedDir = path.join(cacheBaseDir, '1');
		fs.mkdirSync(lockedDir, { recursive: true });
		fs.writeFileSync(path.join(lockedDir, 'locked-file.txt'), 'still cloning', 'utf8');
		fs.chmodSync(lockedDir, 0o555); // no write permission: unlinking a file inside fails with EACCES

		const result = runMain(path.join(workDir, 'unused-expected.db'), 'purgeCache', { id: 1, cacheBaseDir });
		assert.equal(result.threw, false, 'an expected best-effort purge failure must not throw');
	});

	test('purgeKnowledgeBaseCache does not swallow a genuinely unexpected fs error', () => {
		const cacheBaseDirAsFile = path.join(workDir, 'not-a-directory');
		fs.writeFileSync(cacheBaseDirAsFile, 'this is a file, not the cache base dir', 'utf8');

		// Joining a file path with a further segment and trying to remove it
		// raises ENOTDIR, which is not one of the documented expected purge
		// error codes (EBUSY/EPERM/EACCES/ENOTEMPTY).
		const result = runMain(path.join(workDir, 'unused-unexpected.db'), 'purgeCache', {
			id: 42,
			cacheBaseDir: cacheBaseDirAsFile
		});
		assert.equal(result.threw, true, 'a genuinely unexpected fs error must not be silently swallowed');
		assert.equal(result.code, 'ENOTDIR');
	});
});

describe('deleting a KB completes despite a best-effort purge failure, but not silently on an unexpected one', () => {
	let workDir;
	let dbPathExpected;
	let dbPathUnexpected;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-delete-purge-'));
		dbPathExpected = path.join(workDir, 'expected.db');
		dbPathUnexpected = path.join(workDir, 'unexpected.db');
		runMigrate(dbPathExpected);
		runMigrate(dbPathUnexpected);
	});

	after(() => {
		fs.chmodSync(path.join(workDir, 'cache-expected', '1'), 0o755);
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('deleting a KB removes its row and reports success even though the cache purge hits an expected fs error', () => {
		const created = runMain(dbPathExpected, 'createKb', {
			name: 'Locked Cache KB',
			repoUrl: 'https://example.test/locked.git',
			branch: 'main',
			contentSubdir: ''
		});

		const cacheBaseDir = path.join(workDir, 'cache-expected');
		const lockedDir = path.join(cacheBaseDir, String(created.id));
		fs.mkdirSync(lockedDir, { recursive: true });
		fs.writeFileSync(path.join(lockedDir, 'in-use.txt'), 'still cloning', 'utf8');
		fs.chmodSync(lockedDir, 0o555);

		const result = runMain(dbPathExpected, 'deleteKb', { id: created.id, cacheBaseDir });
		assert.equal(result.threw, false, 'an expected purge failure must not abort the delete with an error');
		assert.equal(result.result, true, 'deleteKnowledgeBase must report the row as removed');

		const raw = new Database(dbPathExpected);
		try {
			assert.equal(
				raw.prepare('SELECT COUNT(*) AS n FROM knowledge_bases WHERE id = ?').get(created.id).n,
				0,
				'the KB row must be gone even though its cache purge failed'
			);
		} finally {
			raw.close();
		}
	});

	test('deleting a KB still removes its row when the cache purge hits an unexpected fs error, but does not hide the error', () => {
		const created = runMain(dbPathUnexpected, 'createKb', {
			name: 'Broken Cache Path KB',
			repoUrl: 'https://example.test/broken-cache.git',
			branch: 'main',
			contentSubdir: ''
		});

		const cacheBaseDirAsFile = path.join(workDir, 'broken-cache-base');
		fs.writeFileSync(cacheBaseDirAsFile, 'not a directory', 'utf8');

		const result = runMain(dbPathUnexpected, 'deleteKb', { id: created.id, cacheBaseDir: cacheBaseDirAsFile });
		assert.equal(result.threw, true, 'a genuinely unexpected purge failure must surface, not be swallowed');
		assert.equal(result.code, 'ENOTDIR');

		const raw = new Database(dbPathUnexpected);
		try {
			assert.equal(
				raw.prepare('SELECT COUNT(*) AS n FROM knowledge_bases WHERE id = ?').get(created.id).n,
				0,
				'the row deletion (which runs before the purge attempt) must still have taken effect'
			);
		} finally {
			raw.close();
		}
	});
});

describe('a duplicate (repoUrl, branch) knowledge base maps to a 4xx form error, not a 500', () => {
	let workDir;
	let dbPath;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-duplicate-kb-'));
		dbPath = path.join(workDir, 'dup.db');
		runMigrate(dbPath);
	});

	after(() => {
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('creating the same (repoUrl, branch) pair twice throws an error recognised by isDuplicateKnowledgeBaseError', () => {
		const result = runMain(dbPath, 'createDuplicateRaw', {
			name: 'Duplicate KB',
			repoUrl: 'https://example.test/duplicate.git',
			branch: 'main',
			contentSubdir: ''
		});
		assert.equal(result.secondThrew, true, 'the unique index should reject the second insert');
		assert.equal(result.recognizedAsDuplicate, true, 'isDuplicateKnowledgeBaseError should recognise the violation');
	});

	test('the real /kb "create" form action returns a 400 field error for a duplicate submission, not an unhandled 500', () => {
		const fields = {
			name: 'Route Duplicate KB',
			repoUrl: 'https://example.test/route-duplicate.git',
			branch: 'main',
			contentSubdir: ''
		};
		const { first, second } = runAction(dbPath, 'createDuplicateViaAction', { fields });

		assert.equal(first.success, true, 'the first submission should succeed');
		assert.equal(second.status, 400, 'a duplicate submission must be reported as a 4xx, not crash the action');
		assert.match(
			second.data.errors.repoUrl,
			/already exists/i,
			'the duplicate must be reported as a repoUrl field error'
		);
	});
});

describe('the SQLite connection is closed on process shutdown', () => {
	let workDir;

	before(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-shutdown-'));
	});

	after(() => {
		if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
	});

	test('the exit hook checkpoints the WAL once the process actually exits (e.g. after adapter-node\'s graceful drain calls process.exit())', async () => {
		const dbPath = path.join(workDir, 'hooked-exit.db');
		runMigrate(dbPath);

		const outcome = await runShutdownHarnessUntilExit(dbPath);
		assert.equal(outcome.code, 0, 'requesting a clean exit should let the process close the db and exit with code 0');
		assert.ok(!fs.existsSync(`${dbPath}-wal`), 'closing the connection must checkpoint and remove the WAL file');
	});

	test(
		'receiving SIGTERM must not itself terminate the process',
		{
			skip:
				process.platform === 'win32' &&
				"sending POSIX signals via child.kill() unconditionally terminates the target process on Windows, so this process-survival assertion cannot be exercised there"
		},
		async () => {
			const dbPath = path.join(workDir, 'sigterm-survives.db');
			runMigrate(dbPath);

			const outcome = await runShutdownHarnessSignalMustNotExit(dbPath, 'SIGTERM');
			assert.equal(
				outcome.stayedAlive,
				true,
				'registerDbShutdownHooks() must not force an immediate exit on SIGTERM: adapter-node owns graceful SIGTERM handling (draining in-flight requests) and calls process.exit() itself once done, which is what should trigger the checkpoint'
			);
		}
	);

	test(
		'receiving SIGINT must not itself terminate the process',
		{
			skip:
				process.platform === 'win32' &&
				"sending POSIX signals via child.kill() unconditionally terminates the target process on Windows, so this process-survival assertion cannot be exercised there"
		},
		async () => {
			const dbPath = path.join(workDir, 'sigint-survives.db');
			runMigrate(dbPath);

			const outcome = await runShutdownHarnessSignalMustNotExit(dbPath, 'SIGINT');
			assert.equal(
				outcome.stayedAlive,
				true,
				'registerDbShutdownHooks() must not force an immediate exit on SIGINT, for the same reason as SIGTERM'
			);
		}
	);

	test('registerDbShutdownHooks() is idempotent and registers only the portable exit hook, not its own SIGINT/SIGTERM listeners', () => {
		const dbPath = path.join(workDir, 'idempotent.db');
		runMigrate(dbPath);

		const { before: countsBefore, after: countsAfter } = runMain(dbPath, 'listenerCounts', {});
		assert.equal(countsAfter.exit, countsBefore.exit + 1, 'exactly one exit listener should be added, not two');
		assert.equal(
			countsAfter.sigterm,
			countsBefore.sigterm,
			'registerDbShutdownHooks() must not add its own SIGTERM listener — adapter-node already owns graceful SIGTERM handling and forcing exit here would abort its drain'
		);
		assert.equal(
			countsAfter.sigint,
			countsBefore.sigint,
			'registerDbShutdownHooks() must not add its own SIGINT listener, for the same reason as SIGTERM'
		);
	});

	test('closeDb() is safe to call more than once, including before any connection was ever opened', () => {
		const dbPath = path.join(workDir, 'close-safe.db');
		runMigrate(dbPath);

		const result = runMain(dbPath, 'closeDbSafe', {});
		assert.equal(result.ok, true, 'repeated closeDb() calls must not throw');
	});
});
