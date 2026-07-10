// Knowledge-base synchronisation and ingestion for Distil (roadmap tasks
// 6.1–6.7).
//
// This module clones (then, on later passes, updates) a KB's git repository
// into the local cache, walks the markdown files under its content
// sub-directory, filters the real study cards out of generated index/root
// files, derives each card's theme, and reconciles the result with the
// database: new cards are inserted, changed ones updated, and cards that
// disappeared from the repo are soft-deleted (active = false) so the user's
// bookmarks and reading history are preserved.
//
// Like `kb.ts` and `bookmarks.ts`, the ingestion/reconciliation core is free of
// SvelteKit imports and takes an explicit Drizzle handle so it stays unit-
// testable outside a running server. The git step (6.1) is isolated in
// {@link cloneOrUpdateRepo} so the pure ingestion of an already-checked-out tree
// (6.2–6.6) can be exercised without any network access.

import matter from 'gray-matter';
import simpleGit from 'simple-git';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { eq } from 'drizzle-orm';
import { cards, knowledgeBases, themePreferences } from './db/schema';
import type { createDb } from './db';
import { DEFAULT_KB_CACHE_DIR } from './kb';

/** The shared Drizzle database handle type. */
type Db = ReturnType<typeof createDb>;

/** The transaction handle passed to a `db.transaction(...)` callback. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The subset of a knowledge-base row the sync needs to clone and ingest it. */
export interface SyncableKnowledgeBase {
	id: number;
	repoUrl: string;
	branch: string;
	contentSubdir: string;
}

/** A study card parsed from a markdown file, before reconciliation. */
export interface ParsedCard {
	/** Path of the file relative to the repository root, in posix form. */
	sourcePath: string;
	slug: string;
	title: string;
	theme: string;
	level: string | null;
	content: string;
}

/** Tally of what a synchronisation changed, surfaced to the user (6.7). */
export interface SyncReport {
	added: number;
	updated: number;
	deactivated: number;
}

/** Normalise a filesystem path to posix separators for stable storage/keys. */
function toPosix(p: string): string {
	return p.split(/[\\/]/).join('/');
}

/**
 * Clone the KB repository on the first pass, or update it on later passes
 * (roadmap 6.1).
 *
 * The checkout lives at `<cacheBaseDir>/<kb.id>/` (consistent with the delete
 * purge in `kb.ts`). A first sync clones `repoUrl` at `branch`; a subsequent
 * sync fetches and hard-resets the working copy onto `origin/<branch>` so the
 * local tree exactly matches the remote (dropping any local drift and picking
 * up force-pushes). Network/git failures reject and are surfaced to the caller
 * rather than being swallowed. Returns the absolute path of the checkout.
 */
export async function cloneOrUpdateRepo(
	kb: SyncableKnowledgeBase,
	cacheBaseDir: string = DEFAULT_KB_CACHE_DIR
): Promise<string> {
	const repoDir = join(cacheBaseDir, String(kb.id));

	if (existsSync(join(repoDir, '.git'))) {
		const git = simpleGit(repoDir);
		await git.fetch('origin', kb.branch);
		await git.reset(['--hard', `origin/${kb.branch}`]);
		return repoDir;
	}

	// Start from a clean directory: a previous clone that failed after writing
	// partial content but before creating `.git` would otherwise leave a
	// non-empty, `.git`-less directory that git refuses to clone into, wedging
	// every future sync. Removing it first makes retries self-healing.
	rmSync(repoDir, { recursive: true, force: true });
	mkdirSync(repoDir, { recursive: true });
	await simpleGit().clone(kb.repoUrl, repoDir, ['--branch', kb.branch, '--single-branch']);
	return repoDir;
}

/** Recursively collect the paths of every `.md` file under `dir`. */
function collectMarkdownFiles(dir: string): string[] {
	if (!existsSync(dir)) {
		return [];
	}
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...collectMarkdownFiles(full));
		} else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
			found.push(full);
		}
	}
	return found;
}

function asTrimmedString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

/**
 * Parse the real study cards out of the repository's content sub-directory
 * (roadmap 6.2–6.4).
 *
 * Walks every `.md` file under `<repoDir>/<contentSubdir>`, reads its YAML
 * frontmatter (gray-matter), and keeps only genuine cards: files whose
 * frontmatter `type` is `index` are excluded, and so are files sitting directly
 * at the root of the content sub-directory (e.g. `home`, `index`, `themes-index`,
 * `tools-hub`) — only files nested in a content sub-folder (`concepts/`,
 * `guides/`, `tools/`, …) are kept. Each kept card's theme (6.4) is its
 * frontmatter `theme` when present, otherwise the name of its first sub-folder.
 */
export function parseCards(repoDir: string, contentSubdir: string): ParsedCard[] {
	const contentRoot = join(repoDir, contentSubdir);
	const parsed: ParsedCard[] = [];

	for (const filePath of collectMarkdownFiles(contentRoot)) {
		// Path relative to the content root drives the root/sub-folder filter and
		// the folder-derived theme; the path relative to the repo root is the
		// stable reconciliation key stored in cards.sourcePath.
		const contentRelParts = toPosix(relative(contentRoot, filePath)).split('/');

		// 6.3: skip files sitting directly at the content-root (no sub-folder).
		if (contentRelParts.length < 2) {
			continue;
		}

		const raw = readFileSync(filePath, 'utf8');

		// Ingesting arbitrary external-repo content means a single file with
		// broken YAML frontmatter is an expected failure mode, not a bug: gray-
		// matter throws a YAMLException on it. Translate that into a handled
		// result — skip just that file (logged) — so one malformed card can never
		// abort ingestion of the whole KB.
		let data: Record<string, unknown>;
		let content: string;
		try {
			({ data, content } = matter(raw) as { data: Record<string, unknown>; content: string });
		} catch (error) {
			console.warn(
				`Skipping card with unparseable frontmatter at ${toPosix(relative(repoDir, filePath))}:`,
				error instanceof Error ? error.message : error
			);
			continue;
		}

		// 6.3: skip generated index files, flagged by `type: index` frontmatter.
		if (asTrimmedString(data.type).toLowerCase() === 'index') {
			continue;
		}

		const firstFolder = contentRelParts[0];
		const fileName = contentRelParts[contentRelParts.length - 1];
		const baseName = fileName.replace(/\.md$/i, '');

		// 6.4: explicit frontmatter theme wins, else the first sub-folder name.
		const theme = asTrimmedString(data.theme) || firstFolder;
		const title = asTrimmedString(data.title) || baseName;
		const level = asTrimmedString(data.level) || null;

		parsed.push({
			sourcePath: toPosix(relative(repoDir, filePath)),
			slug: toPosix(relative(contentRoot, filePath)).replace(/\.md$/i, ''),
			title,
			theme,
			level,
			content
		});
	}

	return parsed;
}

/**
 * Ensure a `themePreferences` row exists for `theme`, created with its default
 * weight the first time the theme is seen (roadmap 6.6). Existing rows (and the
 * user's tuned weight) are left untouched.
 */
function ensureThemePreference(tx: Tx, theme: string): void {
	tx.insert(themePreferences).values({ theme }).onConflictDoNothing().run();
}

/**
 * Reconcile the parsed cards with the database for one KB (roadmap 6.5–6.6).
 *
 * Cards are keyed by their `sourcePath` (repo-relative path). New paths are
 * inserted (active = true), previously-seen paths are updated in place (and
 * reactivated if they had been soft-deleted), and rows whose path is no longer
 * in the repo are soft-deleted (active = false) — never hard-deleted — so the
 * bookmarks and reading history referencing them survive. A theme preference is
 * created for every theme encountered for the first time. Runs in a single
 * transaction and returns the added/updated/deactivated tally.
 */
export function reconcileCards(db: Db, kbId: number, parsed: ParsedCard[]): SyncReport {
	return db.transaction((tx) => {
		const existing = tx.select().from(cards).where(eq(cards.kbId, kbId)).all();
		const existingByPath = new Map(existing.map((row) => [row.sourcePath, row]));
		const seenPaths = new Set<string>();

		const report: SyncReport = { added: 0, updated: 0, deactivated: 0 };
		const seenThemes = new Set<string>();

		for (const card of parsed) {
			seenPaths.add(card.sourcePath);
			if (!seenThemes.has(card.theme)) {
				seenThemes.add(card.theme);
				ensureThemePreference(tx, card.theme);
			}

			const current = existingByPath.get(card.sourcePath);
			if (!current) {
				tx.insert(cards)
					.values({
						kbId,
						slug: card.slug,
						title: card.title,
						theme: card.theme,
						level: card.level,
						sourcePath: card.sourcePath,
						content: card.content,
						active: true
					})
					.run();
				report.added += 1;
				continue;
			}

			// Only count (and write) a real change: identical, still-active cards
			// are left alone so a no-op re-sync reports nothing. `slug` is derived
			// deterministically from `sourcePath` (the match key), so it can never
			// diverge for a matched row and is not part of the comparison.
			const changed =
				current.title !== card.title ||
				current.theme !== card.theme ||
				current.level !== card.level ||
				current.content !== card.content ||
				current.active !== true;
			if (changed) {
				tx.update(cards)
					.set({
						slug: card.slug,
						title: card.title,
						theme: card.theme,
						level: card.level,
						content: card.content,
						active: true
					})
					.where(eq(cards.id, current.id))
					.run();
				report.updated += 1;
			}
		}

		// Soft-delete the cards that vanished from the repo (still active only).
		for (const row of existing) {
			if (row.sourcePath !== null && !seenPaths.has(row.sourcePath) && row.active) {
				tx.update(cards).set({ active: false }).where(eq(cards.id, row.id)).run();
				report.deactivated += 1;
			}
		}

		return report;
	});
}

/**
 * Full synchronisation of one KB (roadmap 6.1–6.7): clone or update its repo,
 * ingest and reconcile its cards, then stamp `lastSyncedAt`. Returns the report
 * shown to the user. Any git/network failure propagates to the caller (the /kb
 * action) so it can be reported without touching `lastSyncedAt`.
 */
export async function syncKnowledgeBase(
	db: Db,
	kb: SyncableKnowledgeBase,
	cacheBaseDir: string = DEFAULT_KB_CACHE_DIR
): Promise<SyncReport> {
	const repoDir = await cloneOrUpdateRepo(kb, cacheBaseDir);
	const parsed = parseCards(repoDir, kb.contentSubdir);
	const report = reconcileCards(db, kb.id, parsed);
	db.update(knowledgeBases).set({ lastSyncedAt: new Date() }).where(eq(knowledgeBases.id, kb.id)).run();
	return report;
}
