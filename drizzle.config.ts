// drizzle-kit configuration.
//
// `npm run db:generate` reads the schema below and emits SQL migrations into
// ./drizzle; `npm run db:migrate` applies them to the database pointed at by
// DATABASE_PATH (defaulting to data/distil.db).
//
// This module is intentionally side-effect free: it is loaded by every
// drizzle-kit command (including `generate`, which never opens the database),
// so creating the database's parent directory happens in the migrate path only
// (the `db:migrate` script mkdirs the parent before invoking drizzle-kit).
import { defineConfig } from 'drizzle-kit';
import { resolveDatabasePath } from './src/lib/server/db/config';

export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	dialect: 'sqlite',
	dbCredentials: {
		url: resolveDatabasePath()
	}
});
