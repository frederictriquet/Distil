// Access guard (roadmap task 3.3).
//
// Validates the signed session cookie on every request, exposes the result via
// `event.locals.authenticated`, and redirects any unauthenticated request to
// /login. The login and logout routes are public so they stay reachable while
// logged out; static/public assets are served by the adapter before this
// handle runs, so they never need to be whitelisted here.
//
// When an unauthenticated request targets a protected page, the originally
// requested path (with its query) is carried to /login via a `redirectTo`
// query parameter, so the login flow can send the user back where they were
// headed after signing in.

import { redirect, type Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { SESSION_COOKIE, getSessionIssuedAt, isUsableSecret } from '$lib/server/auth';
import { isSessionRevoked } from '$lib/server/session-revocation';
import { registerDbShutdownHooks } from '$lib/server/db';

// Wire the SQLite connection close to process termination once, at server
// startup, so a graceful shutdown checkpoints the WAL instead of leaving stray
// `-wal`/`-shm` files behind. This module is loaded once when the server boots.
registerDbShutdownHooks();

/** Routes reachable without a valid session. */
const PUBLIC_PATHS = ['/login', '/logout'];

function isPublicPath(pathname: string): boolean {
	return PUBLIC_PATHS.some((base) => pathname === base || pathname.startsWith(`${base}/`));
}

// A weak SESSION_SECRET is a silent security hole (the HMAC becomes brute-force
// forgeable), so warn once at first request rather than accepting it quietly.
let warnedWeakSecret = false;

export const handle: Handle = async ({ event, resolve }) => {
	const secret = env.SESSION_SECRET;

	if (typeof secret === 'string' && secret.length > 0 && !isUsableSecret(secret) && !warnedWeakSecret) {
		warnedWeakSecret = true;
		console.warn(
			'SESSION_SECRET is too short or a known placeholder; use a long random value ' +
				'(see .env.example). Sessions are disabled until it is fixed.'
		);
	}

	// A classic (no-JS) login form POST, and any client that omits `Accept`,
	// should get a real HTTP response: a 303 redirect on success or the
	// re-rendered page with its error on failure. Without an explicit
	// `Accept: text/html`, SvelteKit's content negotiation treats the form
	// action as an AJAX call and replies 200 + a JSON envelope instead.
	// Progressive-enhancement submissions (`use:enhance`) set
	// `x-sveltekit-action: true` and genuinely want that JSON envelope, so they
	// are left untouched.
	if (
		event.request.method === 'POST' &&
		event.url.pathname === '/login' &&
		event.request.headers.get('x-sveltekit-action') !== 'true'
	) {
		event.request.headers.set('accept', 'text/html');
	}

	// A session is authentic only when the secret is usable, the token verifies
	// (signature + lifetime), and it has not been revoked by a prior logout.
	const iat = isUsableSecret(secret)
		? getSessionIssuedAt(event.cookies.get(SESSION_COOKIE), secret)
		: null;
	event.locals.authenticated = iat !== null && !isSessionRevoked(iat);

	if (!event.locals.authenticated && !isPublicPath(event.url.pathname)) {
		// Preserve the originally requested path (including query) so the user is
		// returned to it after a successful login.
		const target = event.url.pathname + event.url.search;
		const location =
			target === '/' ? '/login' : `/login?redirectTo=${encodeURIComponent(target)}`;
		redirect(303, location);
	}

	return resolve(event);
};
