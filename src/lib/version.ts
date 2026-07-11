// Runtime application version (roadmap task 13.5).
//
// The value is the build-time string wired into `kit.version.name`
// (see svelte.config.js): "<semver>+<shortSha>", e.g. "1.2.3+abcdef1", where
// the SemVer comes from package.json and the SHA from git (or a build-arg
// fallback). Import this from anywhere in the app (footer 13.6, endpoints, …)
// rather than reaching into `$app/environment` directly.
import { version } from '$app/environment';

export const APP_VERSION = version;
