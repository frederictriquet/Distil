// SQLite connection client, exposed to the rest of the app.
//
// Import the shared `db` handle from server-side code only (this module lives
// under `$lib/server`, so SvelteKit keeps it out of the client bundle):
//
//   import { db } from '$lib/server/db';
//
// The underlying file is opened lazily on first use so importing this module
// never has the side effect of creating the database file (important for the
// migration tooling and tests, which control when/where the file is created).
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveDatabasePath } from './config';
import * as schema from './schema';

export { schema };

// Folder holding the generated drizzle migrations (0000_*.sql + meta/). It sits
// at the project root and is resolved from the working directory, matching how
// the standalone `npm run db:migrate` (drizzle-kit) locates it.
const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

/**
 * Apply any pending drizzle migrations to the given database.
 *
 * This is idempotent: drizzle records applied migrations in its own bookkeeping
 * table, so re-running it against an already-migrated database is a no-op. It is
 * what guarantees the schema exists on a fresh database (e.g. a dev or freshly
 * deployed environment where `data/distil.db` is created on the fly), so the
 * first query against a table like `cards` no longer fails with "no such table".
 *
 * If the migrations folder is absent from the working directory (e.g. a runtime
 * whose database schema is already provisioned out of band and that ships
 * without the `drizzle/` sources), there is nothing to apply: skip rather than
 * fail, since drizzle's migrator would otherwise throw on the missing folder.
 */
export function runMigrations(database: ReturnType<typeof createDb>): void {
	if (!existsSync(MIGRATIONS_FOLDER)) {
		// Log rather than skip silently: if the schema was NOT provisioned out of
		// band, the app will reproduce the original "no such table" 500 and this
		// line is the only clue that migrations were deliberately not applied.
		console.warn(
			`[db] migrations folder not found at ${MIGRATIONS_FOLDER}; skipping automatic migrations. ` +
				'The database schema must already be provisioned out of band, otherwise queries will fail with "no such table".'
		);
		return;
	}
	migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
}

/** Open a better-sqlite3 connection with the recommended pragmas applied. */
export function createSqliteConnection(databasePath: string): Database.Database {
	// Ensure the parent directory (e.g. `data/`) exists before opening.
	mkdirSync(dirname(databasePath), { recursive: true });
	const sqlite = new Database(databasePath);
	// Enforce foreign keys (off by default in SQLite) and use WAL for
	// better concurrent read/write behaviour.
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('foreign_keys = ON');
	return sqlite;
}

/** Build a Drizzle client bound to the given SQLite connection. */
export function createDb(sqlite: Database.Database) {
	return drizzle(sqlite, { schema });
}

let connection: Database.Database | undefined;
let database: ReturnType<typeof createDb> | undefined;

/** The shared Drizzle database handle, opened lazily on first access. */
export const db = new Proxy({} as ReturnType<typeof createDb>, {
	get(_target, prop, receiver) {
		if (!database) {
			// Ensure the schema is in place before the first query. Opening the
			// connection stays lazy (this only runs on first real use, never at
			// import time), so the migration tooling and tests that build their
			// own connection via createDb() are unaffected.
			//
			// Migrate into local variables and only publish them to the shared
			// singleton once runMigrations() succeeds. If it throws (a partial or
			// failed migration, disk full, SQLITE_BUSY from a concurrent process on
			// the same fresh file...), leaving a truthy-but-unmigrated `database`
			// behind would make every later access skip this init, never retry the
			// migration, and silently return to "no such table" errors until the
			// process restarts. Instead we close the half-open connection and
			// rethrow so the next access retries from scratch.
			const nextConnection = createSqliteConnection(resolveDatabasePath());
			const nextDatabase = createDb(nextConnection);
			try {
				runMigrations(nextDatabase);
			} catch (err) {
				nextConnection.close();
				throw err;
			}
			connection = nextConnection;
			database = nextDatabase;
		}
		return Reflect.get(database, prop, receiver);
	}
});

/**
 * Close the shared SQLite connection, if it was opened.
 *
 * With WAL enabled an unclean exit leaves `-wal`/`-shm` files un-checkpointed,
 * so this should be called on graceful shutdown (e.g. from an adapter-node
 * SIGTERM/SIGINT handler). The lazy `db` handle reopens a fresh connection on
 * its next access, so calling this is always safe.
 */
export function closeDb(): void {
	if (connection) {
		connection.close();
		connection = undefined;
		database = undefined;
	}
}

// Guard kept on `globalThis` (not a module-local flag) so it survives a Vite
// SSR hot-reload, which re-instantiates this module while the previously
// registered `exit` listener persists on the shared `process` object. Keying
// off the module instance instead would let a long dev session accumulate one
// `exit` listener per reload and eventually hit MaxListenersExceededWarning.
const SHUTDOWN_HOOKS_REGISTERED = Symbol.for('distil.db.shutdownHooksRegistered');

/**
 * Wire {@link closeDb} to process termination so a graceful shutdown checkpoints
 * the WAL instead of leaving `-wal`/`-shm` files behind.
 *
 * We only register a `process.on('exit')` listener: it fires on any clean exit
 * and runs synchronously, which suits better-sqlite3's synchronous `close()`.
 * We deliberately do NOT install our own `SIGINT`/`SIGTERM` handlers. In
 * production this app runs under `@sveltejs/adapter-node`, which owns graceful
 * signal handling — it drains in-flight requests before calling `process.exit()`
 * itself. Closing the connection and forcing an exit from a signal handler here
 * would race and abort that drain (and, in dev, preempt Vite's own Ctrl+C
 * cleanup). Letting the process reach a normal `exit` is enough: the `exit`
 * hook then checkpoints the WAL.
 *
 * Registration is idempotent across repeated calls and across hot-reloads, so
 * exactly one `exit` listener is ever added. {@link closeDb} is itself safe to
 * call repeatedly regardless.
 */
export function registerDbShutdownHooks(): void {
	const guard = globalThis as Record<symbol, unknown>;
	if (guard[SHUTDOWN_HOOKS_REGISTERED]) {
		return;
	}
	guard[SHUTDOWN_HOOKS_REGISTERED] = true;

	process.on('exit', () => {
		closeDb();
	});
}
