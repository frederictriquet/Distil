<script lang="ts">
	// Action bar shown under every card, however it is reached (study draw,
	// internal "see also" link, or bookmark navigation): advance to the next
	// draw (roadmap 8.4), adjust a theme's weight (8.5), and bookmark the card
	// via a keyboard-accessible modal panel (8.7). The mutating actions post to
	// the CURRENT route with relative `?/...` targets, so the same component
	// drives the study route and both consultation routes — each of which binds
	// the shared handlers from $lib/server/card-actions.
	//
	// An optional "Back" control (shown only when `showBack` is set) lets the
	// user return to wherever they came from on a consultation page, where the
	// card was reached by navigation rather than drawn.
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import type { SubmitFunction } from '@sveltejs/kit';

	type Category = { id: number; name: string };

	let {
		card,
		categories: initialCategories,
		bookmarkedCategoryIds: initialBookmarkedIds,
		showBack = false
	}: {
		card: { id: number; theme: string | null };
		categories: Category[];
		bookmarkedCategoryIds: number[];
		showBack?: boolean;
	} = $props();

	// --- Bookmark panel (roadmap 8.7) -------------------------------------------
	// The panel lists the bookmark categories, lets the user pick several (and
	// create new ones inline), and saves the current card into all picks. It is a
	// keyboard-accessible modal dialog: opened by the "Bookmark" button, closed
	// via Escape, the Close button, or a backdrop click, with focus moved in on
	// open and restored to the trigger on close.
	let panelOpen = $state(false);
	let categories = $state<Category[]>([]);
	let selectedIds = $state<Set<number>>(new Set());
	let bookmarkedIds = $state<Set<number>>(new Set());
	let createError = $state<string | null>(null);
	let saveMessage = $state<string | null>(null);

	let triggerEl: HTMLButtonElement | null = $state(null);
	let panelEl: HTMLElement | null = $state(null);
	let closeButtonEl: HTMLButtonElement | null = $state(null);
	let newCategoryInput: HTMLInputElement | null = $state(null);

	// Seed the panel from server truth whenever the card (or its category data)
	// changes. Bookmark actions run without invalidateAll to keep the current card
	// on screen, so between draws the local state is mutated in place from the
	// action results; this only re-syncs on an actual navigation to another card.
	$effect(() => {
		void card.id;
		categories = [...(initialCategories ?? [])];
		bookmarkedIds = new Set(initialBookmarkedIds ?? []);
		selectedIds = new Set();
		createError = null;
		saveMessage = null;
	});

	function sortCategories(list: Category[]): Category[] {
		return [...list].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
	}

	function openPanel(): void {
		if (panelOpen) {
			return;
		}
		panelOpen = true;
		void tick().then(() => closeButtonEl?.focus());
	}

	function closePanel(): void {
		if (!panelOpen) {
			return;
		}
		panelOpen = false;
		void tick().then(() => triggerEl?.focus());
	}

	function toggleSelected(id: number): void {
		const next = new Set(selectedIds);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		selectedIds = next;
	}

	function onPanelKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.stopPropagation();
			closePanel();
			return;
		}
		if (event.key !== 'Tab' || !panelEl) {
			return;
		}
		// Trap focus inside the dialog so keyboard users cannot tab out of the modal.
		const focusable = panelEl.querySelectorAll<HTMLElement>(
			'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
		);
		if (focusable.length === 0) {
			return;
		}
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	// Enhance the create-category form: on success add and pre-select the new
	// category locally (no invalidateAll, so the current card is preserved).
	const createEnhance: SubmitFunction = () => {
		return async ({ result, formElement }) => {
			createError = null;
			if (result.type === 'success' && result.data) {
				const category = (result.data as { category?: Category }).category;
				if (category) {
					categories = sortCategories([
						...categories.filter((c) => c.id !== category.id),
						category
					]);
					selectedIds = new Set(selectedIds).add(category.id);
				}
				formElement.reset();
				void tick().then(() => newCategoryInput?.focus());
			} else if (result.type === 'failure') {
				createError = (result.data as { error?: string })?.error ?? 'Could not create the category.';
			}
		};
	};

	// Enhance the save form: reflect the resulting bookmarked set and clear the
	// pending selection, again without a redraw.
	const saveEnhance: SubmitFunction = () => {
		return async ({ result }) => {
			saveMessage = null;
			if (result.type === 'success' && result.data) {
				const ids = (result.data as { bookmarkedCategoryIds?: number[] }).bookmarkedCategoryIds;
				bookmarkedIds = new Set(ids ?? bookmarkedIds);
				selectedIds = new Set();
				saveMessage = 'Saved to the selected categories.';
			} else if (result.type === 'failure') {
				saveMessage = (result.data as { error?: string })?.error ?? 'Could not save the card.';
			}
		};
	};

	function goBack(): void {
		// Return where the user came from when there is an in-app history entry.
		// A card can also be reached with no prior in-app step (direct URL, a link
		// from an email, a reopened tab), where history.back() would leave the app
		// entirely; fall back to the cards list so Back always stays inside Distil.
		if (history.length > 1) {
			history.back();
		} else {
			void goto('/cards');
		}
	}
</script>

<div class="study-actions">
	{#if showBack}
		<button type="button" class="back" onclick={goBack}>Back</button>
	{/if}

	<form method="POST" action="?/next" use:enhance>
		<button type="submit" class="primary">Next card</button>
	</form>

	<!-- Trigger for the bookmark panel (8.7). -->
	<button
		type="button"
		bind:this={triggerEl}
		aria-haspopup="dialog"
		aria-expanded={panelOpen}
		onclick={openPanel}
	>
		Bookmark
	</button>

	{#if card.theme}
		<form method="POST" action="?/more" use:enhance>
			<input type="hidden" name="theme" value={card.theme} />
			<button type="submit">More of this theme</button>
		</form>
		<form method="POST" action="?/less" use:enhance>
			<input type="hidden" name="theme" value={card.theme} />
			<button type="submit">Less of this theme</button>
		</form>
	{/if}
</div>

{#if panelOpen}
	<!-- Modal bookmark panel (8.7). The dialog traps focus and handles Escape
	     via onPanelKeydown; a mouse-only dismiss button (kept out of the tab
	     order and hidden from assistive tech) closes it on a backdrop click. -->
	<div class="panel-backdrop">
		<button
			type="button"
			class="panel-backdrop__dismiss"
			tabindex="-1"
			aria-hidden="true"
			onclick={closePanel}
		></button>
		<div
			class="panel"
			role="dialog"
			tabindex="-1"
			aria-modal="true"
			aria-labelledby="bookmark-panel-title"
			bind:this={panelEl}
			onkeydown={onPanelKeydown}
		>
			<header class="panel__header">
				<h2 id="bookmark-panel-title" class="panel__title">Save to bookmarks</h2>
				<button
					type="button"
					class="panel__close"
					bind:this={closeButtonEl}
					onclick={closePanel}
					aria-label="Close bookmark panel"
				>
					×
				</button>
			</header>

			<form
				method="POST"
				action="?/addBookmarks"
				use:enhance={saveEnhance}
				class="panel__save"
			>
				<input type="hidden" name="cardId" value={card.id} />

				{#if categories.length === 0}
					<p class="panel__empty">
						No categories yet. Create one below to bookmark this card.
					</p>
				{:else}
					<fieldset class="panel__categories">
						<legend class="panel__legend">Categories</legend>
						{#each categories as category (category.id)}
							<label class="panel__option">
								<input
									type="checkbox"
									name="categoryId"
									value={category.id}
									checked={selectedIds.has(category.id)}
									onchange={() => toggleSelected(category.id)}
								/>
								<span class="panel__option-name">{category.name}</span>
								{#if bookmarkedIds.has(category.id)}
									<span class="panel__badge">Saved</span>
								{/if}
							</label>
						{/each}
					</fieldset>
				{/if}

				<button type="submit" class="primary" disabled={selectedIds.size === 0}>
					Save to selected
				</button>
				{#if saveMessage}
					<p class="panel__message" role="status">{saveMessage}</p>
				{/if}
			</form>

			<form
				method="POST"
				action="?/createCategory"
				use:enhance={createEnhance}
				class="panel__create"
			>
				<label class="panel__field">
					<span>New category</span>
					<input
						type="text"
						name="name"
						bind:this={newCategoryInput}
						placeholder="Category name"
						required
					/>
				</label>
				<button type="submit">Create category</button>
				{#if createError}
					<p class="panel__error" role="alert">{createError}</p>
				{/if}
			</form>
		</div>
	</div>
{/if}

<style>
	.study-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	.study-actions form {
		margin: 0;
	}

	.back {
		margin-inline-end: auto;
	}

	/* Bookmark panel (8.7): a mobile-first modal styled entirely with theme
	   tokens, so it follows light/dark mode automatically. */
	.panel-backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: flex;
		align-items: flex-end;
		justify-content: center;
		padding: var(--space-3);
		background-color: var(--color-scrim);
	}

	.panel-backdrop__dismiss {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: default;
	}

	.panel {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		width: 100%;
		max-width: 32rem;
		max-height: 85vh;
		overflow-y: auto;
		padding: var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background-color: var(--color-surface);
		color: var(--color-text);
		box-shadow: var(--shadow-md);
	}

	.panel__header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.panel__title {
		margin: 0;
		font-size: var(--text-lg);
	}

	.panel__close {
		flex: none;
		width: 2rem;
		height: 2rem;
		padding: 0;
		font-size: var(--text-xl);
		line-height: 1;
	}

	.panel__save,
	.panel__create {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		margin: 0;
	}

	.panel__create {
		padding-top: var(--space-3);
		border-top: 1px solid var(--color-border);
	}

	.panel__categories {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		border: 0;
	}

	.panel__legend {
		padding: 0;
		font-size: var(--text-sm);
		color: var(--color-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.panel__option {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.panel__option-name {
		flex: 1;
	}

	.panel__badge {
		font-size: var(--text-sm);
		color: var(--color-success);
	}

	.panel__field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.panel__field span {
		font-size: var(--text-sm);
		color: var(--color-text-muted);
	}

	.panel__field input {
		padding: var(--space-2);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background-color: var(--color-surface-alt);
		color: var(--color-text);
	}

	.panel__empty {
		margin: 0;
		color: var(--color-text-muted);
	}

	.panel__message {
		margin: 0;
		color: var(--color-success);
	}

	.panel__error {
		margin: 0;
		color: var(--color-danger);
	}

	@media (min-width: 40rem) {
		.panel-backdrop {
			align-items: center;
		}
	}
</style>
