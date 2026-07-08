// Access guard (roadmap task 3.3).
//
// Validates the signed session cookie on every request, exposes the result via
// `event.locals.authenticated`, and redirects any unauthenticated request to
// /login. The login route is public so it stays reachable while logged out;
// static/public assets are served by the adapter before this handle runs, so
// they never need to be whitelisted here.

import { redirect, type Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { SESSION_COOKIE, isValidSession } from '$lib/server/auth';

/** Routes reachable without a valid session. */
const PUBLIC_PATHS = ['/login'];

function isPublicPath(pathname: string): boolean {
	return PUBLIC_PATHS.some((base) => pathname === base || pathname.startsWith(`${base}/`));
}

export const handle: Handle = async ({ event, resolve }) => {
	const secret = env.SESSION_SECRET;
	const token = event.cookies.get(SESSION_COOKIE);
	event.locals.authenticated = Boolean(secret) && isValidSession(token, secret ?? '');

	if (!event.locals.authenticated && !isPublicPath(event.url.pathname)) {
		redirect(303, '/login');
	}

	return resolve(event);
};
