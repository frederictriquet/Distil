// Login page server logic (roadmap task 3.2).
//
// The default action verifies the submitted password against APP_PASSWORD and,
// on success, sets a signed session cookie and redirects to the originally
// requested page (or the app home). Both secrets come from the environment.
// Logout lives on its own /logout endpoint, so this route keeps a single
// `default` action and never mixes a default with a named action.

import { fail, redirect, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import {
	SESSION_COOKIE,
	createSessionToken,
	isUsableSecret,
	sessionCookieOptions,
	verifyPassword
} from '$lib/server/auth';
import {
	checkLoginRateLimit,
	clearLoginAttempts,
	recordFailedLogin
} from '$lib/server/rate-limit';
import { safeRedirectPath } from '$lib/server/redirect';

// Fixed delay applied after a failed password attempt. It does not stop a
// determined attacker but raises the cost of online guessing against the single
// static password (constant-time comparison alone does not help there).
const FAILED_LOGIN_DELAY_MS = 500;

export const load: PageServerLoad = async ({ locals, url }) => {
	// Validate the requested post-login target up front so both the "already
	// authenticated" redirect below and the form's hidden field use the same
	// sanitized value (defends against an open-redirect via `?redirectTo=`).
	const redirectTo = safeRedirectPath(url.searchParams.get('redirectTo'));

	// Already logged in? Skip the form and honor the requested target.
	if (locals.authenticated) {
		redirect(303, redirectTo);
	}
	return { redirectTo };
};

export const actions: Actions = {
	default: async ({ request, cookies, url, getClientAddress, setHeaders }) => {
		const appPassword = env.APP_PASSWORD;
		const secret = env.SESSION_SECRET;
		if (!appPassword || !isUsableSecret(secret)) {
			return fail(500, {
				error: 'Server is not configured. Set APP_PASSWORD and a long random SESSION_SECRET.'
			});
		}

		// Throttle brute-force guessing before doing any work: once a client IP is
		// locked out, reject with 429 and advertise the retry delay.
		const clientKey = getClientAddress();
		const now = Date.now();
		const limit = checkLoginRateLimit(clientKey, now);
		if (limit.limited) {
			const retryAfter = Math.ceil(limit.retryAfterMs / 1000);
			setHeaders({ 'retry-after': String(retryAfter) });
			return fail(429, {
				error: `Too many failed login attempts. Try again in ${retryAfter} seconds.`
			});
		}

		const data = await request.formData();
		const password = data.get('password');
		if (typeof password !== 'string' || !verifyPassword(password, appPassword)) {
			recordFailedLogin(clientKey, now);
			await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
			return fail(401, { error: 'Incorrect password.' });
		}

		// Successful login: drop any accumulated failures for this client.
		clearLoginAttempts(clientKey);

		// Re-validate the target from the submitted form (preferred) or the URL;
		// never trust the raw value for the redirect.
		const redirectTo = safeRedirectPath(
			data.get('redirectTo') ?? url.searchParams.get('redirectTo')
		);

		cookies.set(SESSION_COOKIE, createSessionToken(secret), sessionCookieOptions(!dev));
		redirect(303, redirectTo);
	}
};
