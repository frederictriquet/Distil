<script lang="ts">
	// Bookmarks page (roadmap tasks 9.1 & 9.3): manage bookmark categories and
	// browse bookmarks grouped by category. Adding a bookmark (task 9.2) is a
	// reusable server action the future study view (section 8) will call; there
	// is no "current card" screen yet, so this page only surfaces the removal of
	// existing bookmarks. Cards link to /cards/[id], the single-card page that
	// section 10 will implement.
	import { enhance } from '$app/forms';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const createError = $derived(form?.action === 'createCategory' ? form.error : undefined);

	/**
	 * Failure message from a per-category or per-bookmark action (rename, delete,
	 * remove) — e.g. a stale tab acting on something another tab already changed.
	 * Surfaced as a page-level banner.
	 */
	const actionError = $derived(
		form &&
			(form.action === 'renameCategory' ||
				form.action === 'deleteCategory' ||
				form.action === 'removeBookmark' ||
				form.action === 'addBookmark') &&
			!form.success
			? form.error
			: undefined
	);

	const hasCategories = $derived(data.categories.length > 0);
	const totalBookmarks = $derived(
		data.categories.reduce((sum, category) => sum + category.bookmarks.length, 0)
	);
</script>

<svelte:head>
	<title>Bookmarks — Distil</title>
</svelte:head>

<PageContainer title="Bookmarks">
	{#if actionError}
		<p class="error" role="alert">{actionError}</p>
	{/if}

	<section aria-labelledby="bookmark-add-category-heading">
		<h2 id="bookmark-add-category-heading">Add a category</h2>
		<form method="POST" action="?/createCategory" class="inline-form" use:enhance>
			<label for="category-name">Category name</label>
			<input id="category-name" name="name" type="text" required />
			<button type="submit">Add category</button>
		</form>
		{#if createError}
			<p class="error" role="alert">{createError}</p>
		{/if}
	</section>

	<section aria-labelledby="bookmark-list-heading">
		<h2 id="bookmark-list-heading">Bookmarks by category</h2>

		{#if !hasCategories}
			<EmptyState
				title="No categories yet"
				description="Create a category above, then bookmark cards into it while studying."
			/>
		{:else if totalBookmarks === 0}
			<EmptyState
				title="No bookmarks yet"
				description="You have categories, but no bookmarked cards. Cards you bookmark while studying will appear here, grouped by category."
			/>
		{/if}

		{#if hasCategories}
			<ul class="categories">
				{#each data.categories as category (category.id)}
					<li class="category">
						<div class="category__header">
							<h3>{category.name}</h3>
							<div class="category__actions">
								<form method="POST" action="?/renameCategory" class="rename-form" use:enhance>
									<input type="hidden" name="id" value={category.id} />
									<label class="visually-hidden" for="rename-{category.id}">
										New name for {category.name}
									</label>
									<input
										id="rename-{category.id}"
										name="name"
										type="text"
										required
										placeholder="Rename category"
									/>
									<button type="submit">Rename</button>
								</form>
								<form
									method="POST"
									action="?/deleteCategory"
									use:enhance={({ cancel }) => {
										// Deleting a category cascade-removes all its bookmarks, so
										// require an explicit confirmation first.
										if (
											!confirm(
												`Delete "${category.name}"? This removes the category and all its bookmarks.`
											)
										) {
											cancel();
										}
									}}
								>
									<input type="hidden" name="id" value={category.id} />
									<button type="submit" class="danger">Delete</button>
								</form>
							</div>
						</div>

						{#if category.bookmarks.length === 0}
							<p class="empty">No bookmarks in this category.</p>
						{:else}
							<ul class="bookmarks">
								{#each category.bookmarks as bookmark (bookmark.bookmarkId)}
									<li class="bookmark">
										<a href="/cards/{bookmark.cardId}">
											{bookmark.cardTitle || bookmark.cardSlug || `Card ${bookmark.cardId}`}
										</a>
										{#if !bookmark.cardActive}
											<span class="badge">inactive</span>
										{/if}
										<form method="POST" action="?/removeBookmark" use:enhance>
											<input type="hidden" name="cardId" value={bookmark.cardId} />
											<input type="hidden" name="categoryId" value={category.id} />
											<button
												type="submit"
												class="danger"
												aria-label="Remove {bookmark.cardTitle ||
													bookmark.cardSlug ||
													`Card ${bookmark.cardId}`} from {category.name}"
											>
												Remove
											</button>
										</form>
									</li>
								{/each}
							</ul>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</PageContainer>

<style>
	section {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.inline-form,
	.rename-form {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: center;
	}

	.categories {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}

	.category {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		padding: var(--space-4);
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.category__header {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-3);
	}

	.category__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.category__actions form {
		margin: 0;
	}

	.bookmarks {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.bookmark {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}

	.bookmark a {
		flex: 1;
	}

	.badge {
		font-size: var(--text-sm);
		color: var(--color-text-muted);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		padding: 0 var(--space-2);
	}

	.danger {
		color: var(--color-danger);
	}

	.error {
		color: var(--color-danger);
		margin: 0;
	}

	.empty {
		color: var(--color-text-muted);
		margin: 0;
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
