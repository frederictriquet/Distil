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
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveDatabasePath } from './config';
import * as schema from './schema';

export { schema };

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
			connection = createSqliteConnection(resolveDatabasePath());
			database = createDb(connection);
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

let shutdownHooksRegistered = false;

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
 * The guard below only prevents this single module instance from stacking
 * duplicate listeners across repeated calls; it does not survive a Vite SSR
 * hot-reload, which re-instantiates the module (resetting the flag) while the
 * previously registered listener persists on the global `process` object.
 * {@link closeDb} is itself safe to call repeatedly, so a stale duplicate is
 * harmless if one does accumulate.
 */
export function registerDbShutdownHooks(): void {
	if (shutdownHooksRegistered) {
		return;
	}
	shutdownHooksRegistered = true;

	process.on('exit', () => {
		closeDb();
	});
}
