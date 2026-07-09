// Logout endpoint.
//
// A dedicated POST endpoint (rather than a form action on /login, which would
// force mixing a named action with the login page's `default` action) that
// revokes the presented session server-side, clears the session cookie, and
// redirects (303) back to the login page. Being an endpoint and not a form
// action, it always answers with a real HTTP redirect — no content negotiation
// to worry about for classic (no-JS) form submissions.

import { redirect, type RequestHandler } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { SESSION_COOKIE, getSessionIssuedAt, isUsableSecret } from '$lib/server/auth';
import { revokeSessionsIssuedBefore } from '$lib/server/session-revocation';

export const POST: RequestHandler = ({ cookies }) => {
	// Revoke the presented token server-side before clearing the cookie, so the
	// stateless token cannot keep authenticating even if it is replayed after
	// logout. Distil is single-user, so revoking everything issued at or before
	// this token's issue time invalidates the active session.
	const secret = env.SESSION_SECRET;
	if (isUsableSecret(secret)) {
		const iat = getSessionIssuedAt(cookies.get(SESSION_COOKIE), secret);
		if (iat !== null) {
			revokeSessionsIssuedBefore(iat);
		}
	}

	// Mirror the attributes the cookie was set with so the browser matches and
	// removes it; `secure` follows the same dev/prod split as on login.
	cookies.delete(SESSION_COOKIE, { path: '/', secure: !dev });
	redirect(303, '/login');
};
