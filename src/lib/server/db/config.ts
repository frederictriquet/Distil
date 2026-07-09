// Resolution of the SQLite database location.
//
// The path is configurable through the DATABASE_PATH environment variable and
// defaults to `data/distil.db` (the `data/` directory is gitignored). This is
// read from `process.env` on purpose so the exact same resolution works both
// inside the SvelteKit server runtime (adapter-node) and in the standalone
// drizzle-kit / migration tooling, which run outside the SvelteKit env layer.

/** Default database path, relative to the project root. */
export const DEFAULT_DATABASE_PATH = 'data/distil.db';

/** Resolve the SQLite database path from the environment, with a default. */
export function resolveDatabasePath(): string {
	const fromEnv = process.env.DATABASE_PATH?.trim();
	return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_DATABASE_PATH;
}
