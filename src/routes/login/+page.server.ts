// Login page server logic (roadmap task 3.2).
//
// The default action verifies the submitted password against APP_PASSWORD and,
// on success, sets a signed session cookie and redirects to the app home. Both
// secrets come from the environment. Logout is not a form action here: because
// SvelteKit forbids mixing a default action with a named one on the same route,
// the logout POST (`/login?/logout`) is handled in hooks.server.ts instead.

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

// Fixed delay applied after a failed password attempt. It does not stop a
// determined attacker but raises the cost of online guessing against the single
// static password (constant-time comparison alone does not help there).
const FAILED_LOGIN_DELAY_MS = 500;

export const load: PageServerLoad = async ({ locals }) => {
	// Already logged in? Skip the form and go home.
	if (locals.authenticated) {
		redirect(303, '/');
	}
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const appPassword = env.APP_PASSWORD;
		const secret = env.SESSION_SECRET;
		if (!appPassword || !isUsableSecret(secret)) {
			return fail(500, {
				error: 'Server is not configured. Set APP_PASSWORD and a long random SESSION_SECRET.'
			});
		}

		const data = await request.formData();
		const password = data.get('password');
		if (typeof password !== 'string' || !verifyPassword(password, appPassword)) {
			await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
			return fail(401, { error: 'Incorrect password.' });
		}

		cookies.set(SESSION_COOKIE, createSessionToken(secret), sessionCookieOptions(!dev));
		redirect(303, '/');
	}
};
