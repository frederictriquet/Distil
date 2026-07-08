// Login page server logic (roadmap task 3.2).
//
// The default action verifies the submitted password against APP_PASSWORD and,
// on success, sets a signed session cookie and redirects to the app home. The
// `logout` action clears the cookie. Both secrets come from the environment.

import { fail, redirect, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import {
	SESSION_COOKIE,
	createSessionToken,
	sessionCookieOptions,
	verifyPassword
} from '$lib/server/auth';

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
		if (!appPassword || !secret) {
			return fail(500, {
				error: 'Server is not configured. Set APP_PASSWORD and SESSION_SECRET.'
			});
		}

		const data = await request.formData();
		const password = data.get('password');
		if (typeof password !== 'string' || !verifyPassword(password, appPassword)) {
			return fail(401, { error: 'Incorrect password.' });
		}

		cookies.set(SESSION_COOKIE, createSessionToken(secret), sessionCookieOptions(!dev));
		redirect(303, '/');
	},

	logout: async ({ cookies }) => {
		cookies.delete(SESSION_COOKIE, { path: '/' });
		redirect(303, '/login');
	}
};
