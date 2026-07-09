// Single-user authentication primitives for Distil (roadmap task 3.1).
//
// The session is stateless: instead of a server-side session table we issue a
// signed cookie. The cookie value is `<payload>.<signature>` where the
// signature is an HMAC-SHA256 of the payload keyed with SESSION_SECRET. Any
// tampering with the payload invalidates the signature, so the server can
// trust a well-signed cookie without persisting anything.
//
// This module is intentionally free of SvelteKit imports: it only depends on
// `node:crypto` and takes every secret as an explicit argument. That keeps the
// crypto core pure and unit-testable outside a running server; the SvelteKit
// glue (hooks, form actions) reads the environment and calls into here.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Name of the session cookie set on successful login. */
export const SESSION_COOKIE = 'distil_session';

/** Session lifetime, in seconds (30 days). Enforced both as a cookie attribute
 * (client-side) and server-side against the token's signed issue time. */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * Minimum length accepted for SESSION_SECRET. A short secret makes the HMAC
 * feasibly forgeable, so anything shorter is treated as a misconfiguration.
 */
export const MIN_SESSION_SECRET_LENGTH = 16;

/**
 * Known-placeholder guard for SESSION_SECRET. A value that ships in the
 * template (e.g. `change-me-to-a-long-random-string`) is long enough to pass
 * the length check yet gives no real security, so it is rejected explicitly.
 * The word separators are matched as an optional base64url character
 * (`-` or `_`) so placeholders written in either style are still caught. The
 * leading boundary is "start of string OR any non-alphanumeric character": in
 * the base64url alphabet the only non-alphanumeric characters are `-` and `_`,
 * which are exactly the separators a human uses between placeholder words
 * (`my-app-placeholder-secret`, `staging_example_secret`), so they count as
 * word boundaries rather than being swallowed as part of a token.
 */
export const PLACEHOLDER_SECRET_PATTERN =
	/(^|[^A-Za-z0-9])(change[-_]?me|placeholder|example|to[-_]?a[-_]?long[-_]?random)/i;

/**
 * Whether a SESSION_SECRET is present, long enough, and not a known
 * placeholder, i.e. safe to use for signing sessions.
 */
export function isUsableSecret(secret: string | undefined): secret is string {
	return (
		typeof secret === 'string' &&
		secret.length >= MIN_SESSION_SECRET_LENGTH &&
		!PLACEHOLDER_SECRET_PATTERN.test(secret)
	);
}

/**
 * Compare a submitted password against the expected one in constant time.
 *
 * Both inputs are hashed to a fixed-length digest first so that
 * `timingSafeEqual` always receives equal-length buffers and the comparison
 * leaks neither the password length nor an early-mismatch position.
 */
export function verifyPassword(submitted: string, expected: string): boolean {
	const submittedHash = createHash('sha256').update(submitted, 'utf8').digest();
	const expectedHash = createHash('sha256').update(expected, 'utf8').digest();
	return timingSafeEqual(submittedHash, expectedHash);
}

/** HMAC-SHA256 of `payload` keyed with `secret`, encoded as base64url. */
function sign(payload: string, secret: string): string {
	return createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
}

/**
 * Build a signed session token: `<payload>.<signature>`.
 *
 * The payload encodes the issue time so the token is not a fixed constant, but
 * its only security property is being HMAC-signed with SESSION_SECRET.
 */
export function createSessionToken(secret: string): string {
	const payload = Buffer.from(JSON.stringify({ v: 1, iat: Date.now() }), 'utf8').toString(
		'base64url'
	);
	return `${payload}.${sign(payload, secret)}`;
}

/**
 * Verify a session token's signature in constant time and enforce its
 * server-side lifetime.
 *
 * Returns the token's signed issue time (`iat`, ms epoch) when the signature is
 * valid AND the token was issued within SESSION_MAX_AGE, or `null` when the
 * token is malformed, the signature does not match, or it has expired. Checking
 * the signed `iat` here (not just the client-controlled cookie Max-Age) means a
 * leaked cookie stops working once it ages past the window instead of remaining
 * valid forever. The `iat` is returned (not the raw payload) so callers do not
 * have to decode and re-validate it a second time.
 */
export function verifySessionToken(token: string, secret: string): number | null {
	const dot = token.lastIndexOf('.');
	if (dot <= 0 || dot === token.length - 1) {
		return null;
	}
	const payload = token.slice(0, dot);
	const signature = token.slice(dot + 1);
	const expected = sign(payload, secret);

	const signatureBuf = Buffer.from(signature, 'utf8');
	const expectedBuf = Buffer.from(expected, 'utf8');
	if (signatureBuf.length !== expectedBuf.length) {
		return null;
	}
	if (!timingSafeEqual(signatureBuf, expectedBuf)) {
		return null;
	}

	// Signature is authentic; now enforce the lifetime encoded in the payload.
	let decoded: unknown;
	try {
		decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
	} catch {
		return null;
	}
	const iat = (decoded as { iat?: unknown })?.iat;
	if (typeof iat !== 'number' || !Number.isFinite(iat)) {
		return null;
	}
	const age = Date.now() - iat;
	if (age < 0 || age > SESSION_MAX_AGE * 1000) {
		return null;
	}

	return iat;
}

/** Whether a cookie value carries a valid, correctly-signed session. */
export function isValidSession(token: string | undefined, secret: string): boolean {
	return typeof token === 'string' && verifySessionToken(token, secret) !== null;
}

/**
 * Return the signed issue time (`iat`, ms epoch) of a valid, unexpired token,
 * or `null` when the token is missing, malformed, unsigned, or expired.
 *
 * The auth guard uses this to enforce server-side revocation: a token is only
 * accepted when it authenticates here AND was issued after the revocation
 * epoch, so a logout can invalidate an otherwise still-valid stateless token.
 */
export function getSessionIssuedAt(token: string | undefined, secret: string): number | null {
	if (typeof token !== 'string') {
		return null;
	}
	return verifySessionToken(token, secret);
}

/**
 * Cookie options for the session cookie. `secure` is enabled in production
 * (over HTTPS) and disabled in dev so login still works over plain HTTP.
 */
export function sessionCookieOptions(secure: boolean) {
	return {
		path: '/',
		httpOnly: true,
		sameSite: 'lax' as const,
		secure,
		maxAge: SESSION_MAX_AGE
	};
}
