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

// Reject anything outside printable ASCII (0x20..0x7E), plus the backslash.
// Control characters can smuggle in URL/header-parsing surprises, and any code
// point above 0x7E (e.g. a non-Latin-1 character such as "中") makes the
// `Location` header throw a "Cannot convert argument to a ByteString" error
// when the redirect is issued, turning a crafted `redirectTo` into a 500.
// Internal paths are percent-encoded, so they never legitimately carry raw
// non-ASCII bytes.
// eslint-disable-next-line no-control-regex
const UNSAFE_PATH_CHAR = /[^\x20-\x7e]|\\/;

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
