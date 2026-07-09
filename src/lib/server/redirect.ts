// Post-login redirect validation.
//
// The access guard propagates the originally requested URL to /login via a
// `redirectTo` query parameter so the user lands back where they were headed
// after signing in. That value is attacker-controllable (it rides in a URL),
// so it must be treated as untrusted: only a same-origin, absolute *path* is
// allowed. Anything that could steer the browser off-origin — a scheme
// (`https://evil`), a protocol-relative `//evil`, or a backslash trick
// (`/\evil`) that some browsers normalize into `//evil` — is rejected and
// falls back to the app home.

/** Default landing path when no valid `redirectTo` is supplied. */
export const DEFAULT_REDIRECT = '/';

// Backslash or ASCII control character (NUL..US); either can smuggle in
// URL/header-parsing surprises, so a path containing one is rejected.
// eslint-disable-next-line no-control-regex
const UNSAFE_PATH_CHAR = /[\\\x00-\x1f]/;

/**
 * Validate a `redirectTo` value as an internal, same-origin path.
 *
 * Returns the value unchanged when it is a single-slash-rooted path with no
 * open-redirect vectors, otherwise returns {@link DEFAULT_REDIRECT}.
 */
export function safeRedirectPath(value: unknown): string {
	if (typeof value !== 'string' || value.length === 0) {
		return DEFAULT_REDIRECT;
	}
	// Must be an absolute path on this origin: exactly one leading slash.
	if (value[0] !== '/') {
		return DEFAULT_REDIRECT;
	}
	// Reject protocol-relative ("//host") and backslash tricks ("/\host") that a
	// browser may resolve to an off-origin destination.
	if (value[1] === '/' || value[1] === '\\') {
		return DEFAULT_REDIRECT;
	}
	// Reject any backslash or control character anywhere in the path.
	if (UNSAFE_PATH_CHAR.test(value)) {
		return DEFAULT_REDIRECT;
	}
	return value;
}
