// Bookmarks page server logic (roadmap tasks 9.1–9.3).
//
// `load` lists the bookmark categories with their bookmarked cards (9.3). The
// form actions cover: category CRUD — create, rename, delete (9.1); and the
// reusable bookmark link — add and remove a (cardId, categoryId) bookmark
// (9.2), which the future study view (section 8) will call. This route sits
// behind the access guard in hooks.server.ts, so it is only reachable with a
// valid session.

import { fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	addBookmark,
	createBookmarkCategory,
	deleteBookmarkCategory,
	isUniqueConstraintError,
	listBookmarksByCategory,
	parseCategoryName,
	removeBookmark,
	renameBookmarkCategory
} from '$lib/server/bookmarks';

export const load: PageServerLoad = async () => {
	return { categories: listBookmarksByCategory(db) };
};

/** Parse a required positive-integer id from form data; returns null when invalid. */
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
	createCategory: async ({ request }) => {
		const data = await request.formData();
		const name = formString(data.get('name'));

		const parsed = parseCategoryName(name);
		if (!parsed.ok) {
			return fail(400, { action: 'createCategory', error: parsed.error, name });
		}

		try {
			createBookmarkCategory(db, parsed.value);
		} catch (error) {
			// The schema's unique name index rejects duplicates; map that expected
			// failure to a form error rather than a 500.
			if (isUniqueConstraintError(error)) {
				return fail(400, {
					action: 'createCategory',
					error: 'A category with this name already exists.',
					name
				});
			}
			throw error;
		}
		return { action: 'createCategory', success: true };
	},

	renameCategory: async ({ request }) => {
		const data = await request.formData();
		const id = parseId(data.get('id'));
		if (id === null) {
			return fail(400, { action: 'renameCategory', error: 'Invalid category id.' });
		}

		const name = formString(data.get('name'));
		const parsed = parseCategoryName(name);
		if (!parsed.ok) {
			return fail(400, { action: 'renameCategory', error: parsed.error, id, name });
		}

		let renamed;
		try {
			renamed = renameBookmarkCategory(db, id, parsed.value);
		} catch (error) {
			if (isUniqueConstraintError(error)) {
				return fail(400, {
					action: 'renameCategory',
					error: 'A category with this name already exists.',
					id,
					name
				});
			}
			throw error;
		}
		if (renamed === undefined) {
			return fail(404, { action: 'renameCategory', error: 'Category not found.' });
		}
		return { action: 'renameCategory', success: true };
	},

	deleteCategory: async ({ request }) => {
		const data = await request.formData();
		const id = parseId(data.get('id'));
		if (id === null) {
			return fail(400, { action: 'deleteCategory', error: 'Invalid category id.' });
		}

		if (!deleteBookmarkCategory(db, id)) {
			return fail(404, { action: 'deleteCategory', error: 'Category not found.' });
		}
		return { action: 'deleteCategory', success: true };
	},

	addBookmark: async ({ request }) => {
		const data = await request.formData();
		const cardId = parseId(data.get('cardId'));
		const categoryId = parseId(data.get('categoryId'));
		if (cardId === null || categoryId === null) {
			return fail(400, { action: 'addBookmark', error: 'Invalid card or category id.' });
		}

		const result = addBookmark(db, cardId, categoryId);
		if (!result.ok) {
			if (result.reason === 'missing-reference') {
				// The referenced card or category no longer exists (foreign-key
				// violation, e.g. a stale study tab); report it as a handled 404
				// rather than letting it crash with a 500.
				return fail(404, {
					action: 'addBookmark',
					error: 'The card or category no longer exists.'
				});
			}
			// The (cardId, categoryId) pair is already bookmarked; treat as a 4xx
			// no-op rather than letting the unique constraint crash with a 500.
			return fail(409, { action: 'addBookmark', error: 'This card is already bookmarked in this category.' });
		}
		return { action: 'addBookmark', success: true };
	},

	removeBookmark: async ({ request }) => {
		const data = await request.formData();
		const cardId = parseId(data.get('cardId'));
		const categoryId = parseId(data.get('categoryId'));
		if (cardId === null || categoryId === null) {
			return fail(400, { action: 'removeBookmark', error: 'Invalid card or category id.' });
		}

		if (!removeBookmark(db, cardId, categoryId)) {
			return fail(404, { action: 'removeBookmark', error: 'Bookmark not found.' });
		}
		return { action: 'removeBookmark', success: true };
	}
};
