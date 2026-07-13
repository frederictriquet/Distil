import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import adapter from '@sveltejs/adapter-node';

// Build-time application version resolution (roadmap task 13.5).
//
// The single source of truth for the SemVer number is package.json's `version`
// field. At build time it is combined with the short commit SHA to produce a
// runtime version string "<semver>+<shortSha>" (e.g. "1.2.3+abcdef1"), wired
// into `kit.version.name` below so it is available at runtime via
// `$app/environment`'s `version` export (reused for update detection, 13.7).
//
// This logic is kept inline (rather than imported from scripts/) so the config
// stays self-contained: it only reads package.json and, optionally, git. The
// build must never fail when git is unavailable (e.g. a Docker build where
// `.git` is excluded from the context — see .dockerignore). Two escape hatches
// cover that case:
//   - APP_VERSION : full override of the whole version string.
//   - GIT_SHA     : override of just the short SHA (SemVer still from package.json).
// When neither is set and git cannot be queried, the SHA degrades to "unknown".

const projectRoot = dirname(fileURLToPath(import.meta.url));

/** Read the SemVer number that is the source of truth (package.json `version`). */
export function readPackageVersion(root = projectRoot) {
	return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
}

/**
 * Resolve the short commit SHA. Precedence: GIT_SHA env override, then
 * `git rev-parse --short HEAD`, then "unknown" when git is unavailable
 * (never throws).
 */
export function resolveGitSha(root = projectRoot) {
	const fromEnv = (process.env.GIT_SHA || '').trim();
	if (fromEnv) return fromEnv;

	try {
		return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'ignore']
		})
			.toString()
			.trim();
	} catch {
		return 'unknown';
	}
}

/**
 * Build the runtime version string "<semver>+<shortSha>". A non-empty
 * APP_VERSION env var overrides the whole string. Never throws so a build
 * outside a git checkout still succeeds.
 */
export function getAppVersion(root = projectRoot) {
	const override = (process.env.APP_VERSION || '').trim();
	if (override) return override;

	return `${readPackageVersion(root)}+${resolveGitSha(root)}`;
}

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},

	kit: {
		// adapter-node: `npm run build` produces a standalone Node server in build/,
		// runnable with `node build`.
		// See https://svelte.dev/docs/kit/adapter-node for more information.
		adapter: adapter(),

		// App version injection (roadmap 13.5): see getAppVersion above.
		version: {
			name: getAppVersion(),
			// Update detection (roadmap 13.7): SvelteKit's native mechanism. The
			// client polls this app-version manifest and flips `updated.current`
			// (from `$app/state`) to true once a newer build has been deployed, so
			// we can invite the user to reload. 5 minutes is a reasonable cadence:
			// timely enough after a deploy without being chatty.
			pollInterval: 300000
		}
	}
};

export default config;
