// Server-side session revocation (auth-session-security debt item).
//
// Session tokens are stateless: they stay valid until their signed `iat` ages
// past SESSION_MAX_AGE, so a logout has no server-side effect on its own — the
// same cookie keeps authenticating for up to 30 days. This module adds a
// revocation epoch enforced by the auth guard. Distil is single-user, so
// logging out revokes every session token issued at or before the logout
// instant; the (only) active token is then rejected on the next request.
//
// The epoch lives in process memory, which is sufficient for the single
// adapter-node process that serves the app. It is intentionally free of
// SvelteKit imports so it can be unit-tested in isolation.

/** Latest revocation instant (ms epoch): tokens issued at or before this are revoked. */
let revokedBefore = 0;

/**
 * Revoke every session token issued at or before `timestamp` (ms epoch).
 * Monotonic: an earlier timestamp never widens the set of valid tokens.
 */
export function revokeSessionsIssuedBefore(timestamp: number): void {
	if (Number.isFinite(timestamp) && timestamp > revokedBefore) {
		revokedBefore = timestamp;
	}
}

/** Whether a token issued at `iat` (ms epoch) has been revoked by a logout. */
export function isSessionRevoked(iat: number): boolean {
	return iat <= revokedBefore;
}

/** Reset the revocation epoch. Intended for tests only. */
export function resetRevocationStore(): void {
	revokedBefore = 0;
}
