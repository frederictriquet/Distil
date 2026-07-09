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
 * `exit` fires on any clean exit and runs synchronously, which suits
 * better-sqlite3's synchronous `close()`. Signals (`SIGINT`/`SIGTERM`) do not
 * trigger `exit` on their own, so we close explicitly and then exit for those.
 *
 * Registration is guarded so calling this more than once (e.g. on a dev
 * hot-reload) does not stack duplicate listeners, and {@link closeDb} is itself
 * safe to call repeatedly, so the hooks are idempotent.
 */
export function registerDbShutdownHooks(): void {
	if (shutdownHooksRegistered) {
		return;
	}
	shutdownHooksRegistered = true;

	process.on('exit', () => {
		closeDb();
	});

	for (const signal of ['SIGINT', 'SIGTERM'] as const) {
		process.once(signal, () => {
			closeDb();
			process.exit(0);
		});
	}
}
