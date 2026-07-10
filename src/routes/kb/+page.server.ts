// KB management page server logic (roadmap tasks 4.1–4.3).
//
// `load` lists the knowledge bases with their active-card counts (4.1). The
// form actions add a KB from validated input (4.2), toggle a KB's focus and
// delete a KB with local-cache purge (4.3). This route sits behind the access
// guard in hooks.server.ts, so it is only reachable with a valid session.

import { fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	createKnowledgeBase,
	deleteKnowledgeBase,
	isDuplicateKnowledgeBaseError,
	listKnowledgeBases,
	parseKnowledgeBaseInput,
	toggleKnowledgeBaseFocus,
	type KnowledgeBaseFormErrors
} from '$lib/server/kb';
import { syncKnowledgeBase } from '$lib/server/sync';
import { knowledgeBases } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

export const load: PageServerLoad = async () => {
	return { knowledgeBases: listKnowledgeBases(db) };
};

/** Parse a required numeric KB id from form data; returns null when invalid. */
function parseId(value: FormDataEntryValue | null): number | null {
	if (typeof value !== 'string') {
		return null;
	}
	const id = Number(value);
	return Number.isInteger(id) && id > 0 ? id : null;
}

/** Read a form field as a plain string, defaulting to '' for missing/file entries. */
function formString(value: FormDataEntryValue | null): string {
	return typeof value === 'string' ? value : '';
}

export const actions: Actions = {
	create: async ({ request }) => {
		const data = await request.formData();
		// Echoed back verbatim on any failure so the form keeps the user's input.
		const values = {
			name: formString(data.get('name')),
			repoUrl: formString(data.get('repoUrl')),
			branch: formString(data.get('branch')),
			contentSubdir: formString(data.get('contentSubdir'))
		};

		const parsed = parseKnowledgeBaseInput(values);
		if (!parsed.ok) {
			return fail(400, { action: 'create', errors: parsed.errors, values });
		}

		try {
			createKnowledgeBase(db, parsed.value);
		} catch (error) {
			// The schema's unique (repoUrl, branch) index rejects duplicates; map
			// that expected failure to a field error rather than a 500.
			if (isDuplicateKnowledgeBaseError(error)) {
				const errors: KnowledgeBaseFormErrors = {
					repoUrl: 'A knowledge base for this repository URL and branch already exists.'
				};
				return fail(400, { action: 'create', errors, values });
			}
			throw error;
		}
		return { action: 'create', success: true };
	},

	toggleFocus: async ({ request }) => {
		const data = await request.formData();
		const id = parseId(data.get('id'));
		if (id === null) {
			return fail(400, { action: 'toggleFocus', error: 'Invalid knowledge base id.' });
		}

		const focus = toggleKnowledgeBaseFocus(db, id);
		if (focus === undefined) {
			return fail(404, { action: 'toggleFocus', error: 'Knowledge base not found.' });
		}
		return { action: 'toggleFocus', success: true, focus };
	},

	delete: async ({ request }) => {
		const data = await request.formData();
		const id = parseId(data.get('id'));
		if (id === null) {
			return fail(400, { action: 'delete', error: 'Invalid knowledge base id.' });
		}

		const removed = deleteKnowledgeBase(db, id);
		if (!removed) {
			return fail(404, { action: 'delete', error: 'Knowledge base not found.' });
		}
		return { action: 'delete', success: true };
	},

	sync: async ({ request }) => {
		const data = await request.formData();
		const id = parseId(data.get('id'));
		if (id === null) {
			return fail(400, { action: 'sync', error: 'Invalid knowledge base id.' });
		}

		const kb = db.select().from(knowledgeBases).where(eq(knowledgeBases.id, id)).get();
		if (!kb) {
			return fail(404, { action: 'sync', error: 'Knowledge base not found.' });
		}

		try {
			const report = await syncKnowledgeBase(db, kb);
			return { action: 'sync', success: true, report };
		} catch (error) {
			// A clone/fetch failure (bad URL, unreachable remote, missing branch)
			// is an expected runtime condition, not a bug: surface it to the user
			// without stamping lastSyncedAt.
			console.warn(`Synchronising knowledge base ${id} failed:`, error);
			return fail(502, {
				action: 'sync',
				error: 'Synchronisation failed. Check the repository URL and branch, then try again.'
			});
		}
	}
};
