// Knowledge-base (KB) management logic for Distil (roadmap tasks 4.1–4.3).
//
// This module holds the CRUD core behind the /kb management page: listing KBs
// with their active-card counts, creating a KB from validated form input,
// toggling a KB's study focus, and deleting a KB (which cascade-removes its
// cards via the schema foreign key and purges the local repo cache).
//
// Like `auth.ts`, it is intentionally free of SvelteKit imports: every function
// takes an explicit Drizzle handle (and, where relevant, the cache base dir) so
// the logic stays pure and unit-testable outside a running server. The
// SvelteKit glue (+page.server.ts) reads the request and calls into here.
//
// Cloning/syncing the repo is out of scope here (roadmap section 5): creating a
// KB only persists its configuration, and deleting one only best-effort purges
// an already-present cache directory.

import { eq, sql } from 'drizzle-orm';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { cards, knowledgeBases } from './db/schema';
import type { createDb } from './db';

/** The shared Drizzle database handle type. */
type Db = ReturnType<typeof createDb>;

/**
 * Default base directory holding each KB's local repo cache, laid out as
 * `data/kb-cache/<id>/`. Resolved relative to the working directory, under the
 * gitignored `data/` tree. Section 5 will populate these; deletion only needs
 * to remove them if present.
 */
export const DEFAULT_KB_CACHE_DIR = 'data/kb-cache';

/** Normalised, validated input for creating a knowledge base. */
export interface KnowledgeBaseInput {
	name: string;
	repoUrl: string;
	branch: string;
	contentSubdir: string;
}

/** A KB row enriched with its number of active cards, for the listing page. */
export interface KnowledgeBaseListItem {
	id: number;
	name: string;
	repoUrl: string;
	branch: string;
	contentSubdir: string;
	focus: boolean;
	lastSyncedAt: Date | null;
	activeCardCount: number;
}

/** Field-level validation errors keyed by form field name. */
export interface KnowledgeBaseFormErrors {
	name?: string;
	repoUrl?: string;
	branch?: string;
	contentSubdir?: string;
}

/** Result of validating raw form input for a new knowledge base. */
export type ParseKnowledgeBaseResult =
	| { ok: true; value: KnowledgeBaseInput }
	| { ok: false; errors: KnowledgeBaseFormErrors };

function asString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

/**
 * Accept the git remote URL shapes section 5 will hand to `simple-git clone`:
 * an `http(s)://`, `ssh://` or `git://` URL, or the scp-like `git@host:path`
 * form. Rejecting everything else at creation time gives immediate form
 * feedback and keeps exotic/typo'd transports (e.g. `ext::`, bare local paths)
 * out of the clone command.
 */
function isValidRepoUrl(value: string): boolean {
	return /^(https?|ssh|git):\/\/\S+$/i.test(value) || /^[\w.+-]+@[\w.-]+:\S+$/.test(value);
}

/**
 * A safe git branch/ref name: it must start with an alphanumeric or underscore
 * (never a `-`, which git would otherwise reinterpret as an option when the
 * branch is passed positionally to `git fetch`/`clone`), and contain only word
 * characters, `.`, `/` and `-`, with no `..` sequence. This blocks git
 * argument/option injection (e.g. `--upload-pack=...`) at the boundary while
 * still accepting real branch names like `main`, `develop` or `feature/x`.
 */
function isValidBranch(value: string): boolean {
	return /^\w[\w./-]*$/.test(value) && !value.includes('..');
}

/**
 * A safe content sub-directory: a repo-relative path that stays inside the
 * checkout. It must not be absolute and every segment must be a plain path
 * component (word characters, `.` and `-`, not starting with `-`), never `.`
 * or `..`. This stops path traversal (e.g. `../../etc`) before `contentSubdir`
 * is joined onto the KB cache directory and walked for markdown files.
 */
function isValidContentSubdir(value: string): boolean {
	if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
		return false;
	}
	return value.split(/[\\/]/).every(
		(segment) => /^[\w.-]+$/.test(segment) && segment !== '.' && segment !== '..' && !segment.startsWith('-')
	);
}

/**
 * Validate and normalise raw form values for a new KB.
 *
 * Rules (roadmap 4.2): `name` and `repoUrl` are required and `repoUrl` must be
 * a recognised git URL shape; `branch` defaults to `main` when left empty and,
 * when given, must be a safe git ref shape; `contentSubdir` is optional
 * (defaults to an empty string) and, when given, must be a safe repo-relative
 * path (no traversal outside the checkout). Validating these two here keeps
 * later git arguments and filesystem walks from being fed hostile values.
 * Inputs are trimmed. Returns the normalised value on success, or the per-field
 * errors on failure.
 */
export function parseKnowledgeBaseInput(raw: {
	name?: unknown;
	repoUrl?: unknown;
	branch?: unknown;
	contentSubdir?: unknown;
}): ParseKnowledgeBaseResult {
	const name = asString(raw.name);
	const repoUrl = asString(raw.repoUrl);
	const branch = asString(raw.branch);
	const contentSubdir = asString(raw.contentSubdir);

	const errors: KnowledgeBaseFormErrors = {};
	if (name.length === 0) {
		errors.name = 'Name is required.';
	}
	if (repoUrl.length === 0) {
		errors.repoUrl = 'Repository URL is required.';
	} else if (!isValidRepoUrl(repoUrl)) {
		errors.repoUrl = 'Enter a valid git URL (https://, ssh://, git:// or git@host:path).';
	}
	if (branch.length > 0 && !isValidBranch(branch)) {
		errors.branch = 'Enter a valid branch name (letters, digits, ., -, / — no leading dash).';
	}
	if (contentSubdir.length > 0 && !isValidContentSubdir(contentSubdir)) {
		errors.contentSubdir = 'Enter a path inside the repository (no leading slash, "." or "..").';
	}
	if (errors.name || errors.repoUrl || errors.branch || errors.contentSubdir) {
		return { ok: false, errors };
	}

	return {
		ok: true,
		value: {
			name,
			repoUrl,
			branch: branch.length > 0 ? branch : 'main',
			contentSubdir
		}
	};
}

/**
 * List all knowledge bases with, for each, its number of active cards
 * (cards where `kbId` matches and `active` is true). KBs with no cards report
 * a count of 0. Ordered by creation time, then id, for a stable display.
 */
export function listKnowledgeBases(db: Db): KnowledgeBaseListItem[] {
	return db
		.select({
			id: knowledgeBases.id,
			name: knowledgeBases.name,
			repoUrl: knowledgeBases.repoUrl,
			branch: knowledgeBases.branch,
			contentSubdir: knowledgeBases.contentSubdir,
			focus: knowledgeBases.focus,
			lastSyncedAt: knowledgeBases.lastSyncedAt,
			activeCardCount: sql<number>`COUNT(CASE WHEN ${cards.active} = 1 THEN 1 END)`
		})
		.from(knowledgeBases)
		.leftJoin(cards, eq(cards.kbId, knowledgeBases.id))
		.groupBy(knowledgeBases.id)
		.orderBy(knowledgeBases.createdAt, knowledgeBases.id)
		.all();
}

/**
 * Insert a new knowledge base from validated input and return the created row.
 *
 * The schema enforces a unique `(repoUrl, branch)` pair, so inserting a
 * duplicate throws a SQLite `SQLITE_CONSTRAINT_UNIQUE` error; callers should
 * guard with {@link isDuplicateKnowledgeBaseError} to surface it as a form
 * error rather than an unhandled 500.
 */
export function createKnowledgeBase(db: Db, input: KnowledgeBaseInput) {
	return db
		.insert(knowledgeBases)
		.values({
			name: input.name,
			repoUrl: input.repoUrl,
			branch: input.branch,
			contentSubdir: input.contentSubdir
		})
		.returning()
		.get();
}

/**
 * True when `error` is the SQLite unique-constraint violation raised by
 * creating a KB whose `(repoUrl, branch)` pair already exists. Lets the
 * SvelteKit create action map a duplicate submission to a field-level form
 * error instead of crashing with an HTTP 500.
 *
 * Drizzle can surface the driver error either directly or wrapped (e.g. a
 * `DrizzleQueryError` exposing the original via `cause`), so we walk the
 * `cause` chain rather than only inspecting the top-level error.
 */
export function isDuplicateKnowledgeBaseError(error: unknown): boolean {
	for (let current: unknown = error; current !== null && current !== undefined; ) {
		if (
			typeof current === 'object' &&
			'code' in current &&
			(current as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
		) {
			return true;
		}
		current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
	}
	return false;
}

/**
 * Toggle a KB's `focus` flag. Returns the new focus value, or `undefined` when
 * no KB with that id exists.
 */
export function toggleKnowledgeBaseFocus(db: Db, id: number): boolean | undefined {
	const current = db
		.select({ focus: knowledgeBases.focus })
		.from(knowledgeBases)
		.where(eq(knowledgeBases.id, id))
		.get();
	if (!current) {
		return undefined;
	}
	const next = !current.focus;
	db.update(knowledgeBases).set({ focus: next }).where(eq(knowledgeBases.id, id)).run();
	return next;
}

/**
 * Filesystem error codes we treat as expected best-effort purge failures: a
 * cache directory still held open by another handle (a locked git working copy
 * on Windows, an antivirus scan, a lingering child process). These are the
 * documented failure modes of removing a directory that may be in use.
 */
const EXPECTED_PURGE_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

/** True when `error` is one of the expected, tolerable fs purge failures. */
function isExpectedPurgeError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		EXPECTED_PURGE_ERROR_CODES.has((error as { code?: unknown }).code as string)
	);
}

/**
 * Best-effort removal of a KB's local repo cache directory
 * (`<cacheBaseDir>/<id>/`). Missing directories are ignored so this stays safe
 * before section 5 ever creates one.
 *
 * `rmSync`'s `force` flag only swallows `ENOENT`; a locked working copy (common
 * on Windows, where section 5 will store a git checkout here) still raises
 * `EBUSY`/`EPERM`. Since the DB row is deleted first, we must not let such a
 * purge failure surface as an error for a delete that already succeeded — so we
 * catch the documented, expected fs errors and log a warning instead, honouring
 * the best-effort contract. Any other (truly unexpected) error is re-thrown
 * rather than silently swallowed.
 */
export function purgeKnowledgeBaseCache(id: number, cacheBaseDir: string = DEFAULT_KB_CACHE_DIR): void {
	try {
		rmSync(join(cacheBaseDir, String(id)), { recursive: true, force: true });
	} catch (error) {
		if (!isExpectedPurgeError(error)) {
			throw error;
		}
		console.warn(`Failed to purge local cache for knowledge base ${id}:`, error);
	}
}

/**
 * Delete a knowledge base: remove its DB row (its cards, bookmarks and reading
 * history cascade away through the schema foreign keys) and purge its local
 * repo cache if present. Returns whether a row was actually removed, so callers
 * can report a missing id (mirroring {@link toggleKnowledgeBaseFocus}).
 */
export function deleteKnowledgeBase(
	db: Db,
	id: number,
	cacheBaseDir: string = DEFAULT_KB_CACHE_DIR
): boolean {
	const result = db.delete(knowledgeBases).where(eq(knowledgeBases.id, id)).run();
	purgeKnowledgeBaseCache(id, cacheBaseDir);
	return result.changes > 0;
}
