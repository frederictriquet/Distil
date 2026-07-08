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

/** Session lifetime, in seconds (30 days). */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

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
 * Verify a session token's signature in constant time.
 *
 * Returns the decoded payload string when the signature is valid, or `null`
 * when the token is malformed or the signature does not match.
 */
export function verifySessionToken(token: string, secret: string): string | null {
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
	return payload;
}

/** Whether a cookie value carries a valid, correctly-signed session. */
export function isValidSession(token: string | undefined, secret: string): boolean {
	return typeof token === 'string' && verifySessionToken(token, secret) !== null;
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
