// Access guard (roadmap task 3.3) plus the logout endpoint.
//
// Validates the signed session cookie on every request, exposes the result via
// `event.locals.authenticated`, and redirects any unauthenticated request to
// /login. The login route is public so it stays reachable while logged out;
// static/public assets are served by the adapter before this handle runs, so
// they never need to be whitelisted here.
//
// Logout is handled here rather than as a `/login` form action: SvelteKit
// forbids combining a default action (used by the login form) with a named
// action on the same route, so the logout POST (`/login?/logout`) is
// intercepted before it reaches the page and answered with a cookie-clearing
// redirect.

import { redirect, type Handle } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import {
	SESSION_COOKIE,
	isUsableSecret,
	isValidSession,
	serializeClearedSessionCookie
} from '$lib/server/auth';

/** Routes reachable without a valid session. */
const PUBLIC_PATHS = ['/login'];

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
			'SESSION_SECRET is too short to be safe; use a long random value (see .env.example). ' +
				'Sessions are disabled until it is fixed.'
		);
	}

	// Logout clears the cookie and sends the user back to the login page. It is
	// handled here (not as a form action) because SvelteKit forbids a default
	// action alongside a named one on /login.
	const isLogoutRequest =
		event.request.method === 'POST' &&
		event.url.pathname === '/login' &&
		event.url.searchParams.has('/logout');
	if (isLogoutRequest) {
		return new Response(null, {
			status: 303,
			headers: {
				location: '/login',
				'set-cookie': serializeClearedSessionCookie(!dev)
			}
		});
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

	event.locals.authenticated =
		isUsableSecret(secret) && isValidSession(event.cookies.get(SESSION_COOKIE), secret);

	if (!event.locals.authenticated && !isPublicPath(event.url.pathname)) {
		redirect(303, '/login');
	}

	return resolve(event);
};
