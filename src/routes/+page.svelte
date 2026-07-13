<script lang="ts">
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { afterNavigate } from '$app/navigation';
	import type { SubmitFunction } from '@sveltejs/kit';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import Card from '$lib/components/Card.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { detectSwipe, type SwipePoint } from '$lib/swipe';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Progressive enhancement (roadmap 8.6): a left swipe on the card advances to
	// the next card, doing exactly what the "Next card" button does. Rather than
	// duplicating any draw logic, the swipe submits the existing `?/next` form
	// programmatically, so it flows through the same use:enhance POST-redirect-GET
	// and the afterNavigate "card shown" reading signal stays intact. The button
	// remains present and functional; the swipe is an addition, not a replacement.
	let nextForm: HTMLFormElement | null = $state(null);

	// Only touch pointers arm a swipe, so mouse text selection and clicks on
	// desktop are never mistaken for one. The gesture decision itself lives in the
	// pure `detectSwipe` helper (unit-tested); here we only capture endpoints.
	let swipeStart: SwipePoint | null = null;

	function isInteractive(target: EventTarget | null): boolean {
		return target instanceof Element && target.closest('a, button, input, textarea, select') !== null;
	}

	function onPointerDown(event: PointerEvent): void {
		// Ignore non-touch pointers and gestures starting on a link/button so we
		// never hijack an internal card link, a tap on an action, or text selection.
		if (event.pointerType !== 'touch' || isInteractive(event.target)) {
			swipeStart = null;
			return;
		}
		swipeStart = { x: event.clientX, y: event.clientY };
	}

	function onPointerUp(event: PointerEvent): void {
		if (!swipeStart) {
			return;
		}
		const start = swipeStart;
		swipeStart = null;
		const direction = detectSwipe(start, { x: event.clientX, y: event.clientY });
		// 8.6: a left swipe advances to the next card. 8.7: a right swipe opens the
		// bookmark panel. Both reuse the same pure `detectSwipe` classifier, so the
		// two gestures never conflict — the sign of the horizontal travel decides.
		if (direction === 'left') {
			nextForm?.requestSubmit();
		} else if (direction === 'right') {
			openPanel();
		}
	}

	// --- Bookmark panel (roadmap 8.7) -------------------------------------------
	// The panel lists the bookmark categories, lets the user pick several (and
	// create new ones inline), and saves the current card into all picks. It is a
	// keyboard-accessible modal dialog: opened by a right swipe or the "Bookmark"
	// button, closed via Escape, the Close button, or a backdrop click, with focus
	// moved in on open and restored to the trigger on close.
	type Category = { id: number; name: string };

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

	// Seed the panel from server truth whenever the drawn card (or its category
	// data) changes. Bookmark actions run without invalidateAll to keep the current
	// card on screen, so between draws the local state is mutated in place from the
	// action results; this only re-syncs on an actual redraw navigation.
	$effect(() => {
		void data.card?.id;
		categories = [...(data.categories ?? [])];
		bookmarkedIds = new Set(data.bookmarkedCategoryIds ?? []);
		selectedIds = new Set();
		createError = null;
		saveMessage = null;
	});

	function sortCategories(list: Category[]): Category[] {
		return [...list].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
	}

	function openPanel(): void {
		if (panelOpen || !data.card) {
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

	// Recording a reading is decoupled from drawing (the phantom-readings fix):
	// `load` only draws, so a hover/tap preload or a programmatic preload — which
	// run `load` but never mount this component — records nothing. The reading is
	// instead recorded by an explicit "this card was really shown" signal sent
	// once the drawn card is on screen: `afterNavigate` fires only after a real
	// navigation mounts/updates the page (never for a bare preload), and we POST
	// the card's id to the dedicated /readings endpoint. Server-side validation
	// there is the boundary that decides what is recorded (see
	// src/routes/readings/+server.ts).
	afterNavigate(() => {
		const cardId = data.card?.id;
		if (typeof cardId !== 'number') {
			return;
		}
		// Fire-and-forget: the study flow does not block on the signal, and
		// `keepalive` lets it complete even if the user advances immediately.
		void fetch('/readings', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ cardId }),
			keepalive: true
		});
	});
</script>

<svelte:head>
	<title>Study — Distil</title>
</svelte:head>

<PageContainer title="Study">
	{#if data.card}
		{#if form?.error}
			<p class="error" role="alert">{form.error}</p>
		{/if}

		<Card>
			<!-- Swipe target (8.6): pointer listeners feed the pure detector; a
			     left swipe submits the ?/next form below. The card stays fully
			     scrollable — only horizontally dominant gestures count. -->
			<article
				class="fiche"
				onpointerdown={onPointerDown}
				onpointerup={onPointerUp}
				onpointercancel={() => (swipeStart = null)}
			>
				<header class="fiche__header">
					<h2 class="fiche__title">{data.card.title}</h2>
					<dl class="fiche__meta">
						{#if data.card.theme}
							<div class="fiche__meta-item">
								<dt>Theme</dt>
								<dd>{data.card.theme}</dd>
							</div>
						{/if}
						{#if data.card.level}
							<div class="fiche__meta-item">
								<dt>Level</dt>
								<dd>{data.card.level}</dd>
							</div>
						{/if}
						{#if data.card.source}
							<div class="fiche__meta-item">
								<dt>Source</dt>
								<dd>{data.card.source}</dd>
							</div>
						{/if}
					</dl>
				</header>

				{#if data.card.bodyHtml}
					<!-- Body is server-rendered markdown, already sanitized with
					     DOMPurify in $lib/server/markdown (roadmap section 7), so
					     injecting it as HTML here is safe. -->
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					<div class="fiche__body">{@html data.card.bodyHtml}</div>
				{:else}
					<p class="fiche__body fiche__body--empty">This card has no content yet.</p>
				{/if}
			</article>
		</Card>

		<div class="study-actions">
			<form method="POST" action="?/next" use:enhance bind:this={nextForm}>
				<button type="submit" class="primary">Next card</button>
			</form>

			<!-- Non-touch trigger for the bookmark panel (8.7): the right swipe is a
			     progressive enhancement, this button makes the panel reachable with a
			     mouse or keyboard too. -->
			<button
				type="button"
				bind:this={triggerEl}
				aria-haspopup="dialog"
				aria-expanded={panelOpen}
				onclick={openPanel}
			>
				Bookmark
			</button>

			{#if data.card.theme}
				<form method="POST" action="?/more" use:enhance>
					<input type="hidden" name="theme" value={data.card.theme} />
					<button type="submit">More of this theme</button>
				</form>
				<form method="POST" action="?/less" use:enhance>
					<input type="hidden" name="theme" value={data.card.theme} />
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
						<input type="hidden" name="cardId" value={data.card.id} />

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
	{:else if data.kb && data.kb.total === 0}
		<!-- No card to study, and the reason is precise (task 12.2): no knowledge
		     base is configured yet, so guide the user to add one. The title is
		     kept stable across every empty case; the description and action carry
		     the state-specific guidance. -->
		<EmptyState
			title="No card to study"
			description="You have no knowledge base yet. Add one and sync it to start studying its cards."
		>
			{#snippet action()}
				<a class="cta" href="/kb">Add a knowledge base</a>
			{/snippet}
		</EmptyState>
	{:else if data.kb && data.kb.focused === 0}
		<!-- Knowledge bases exist but none is in focus: the study pool is empty
		     until at least one is focused (task 12.2). -->
		<EmptyState
			title="No card to study"
			description="No knowledge base is in focus. Put at least one in focus to start drawing its cards for study."
		>
			{#snippet action()}
				<a class="cta" href="/kb">Manage knowledge bases</a>
			{/snippet}
		</EmptyState>
	{:else}
		<!-- A knowledge base is in focus but holds no active card yet (never
		     synced, or every card was deactivated): guide the user to sync. -->
		<EmptyState
			title="No card to study"
			description="The knowledge bases in focus have no active cards yet. Sync a knowledge base to ingest its cards."
		>
			{#snippet action()}
				<a class="cta" href="/kb">Manage knowledge bases</a>
			{/snippet}
		</EmptyState>
	{/if}
</PageContainer>

<style>
	.fiche {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.fiche__title {
		margin: 0;
	}

	.fiche__meta {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-5);
		margin: var(--space-2) 0 0;
	}

	.fiche__meta-item {
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.fiche__meta dt {
		font-size: var(--text-sm);
		color: var(--color-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.fiche__meta dd {
		margin: 0;
		color: var(--color-text);
		font-weight: 600;
	}

	.fiche__body {
		margin: 0;
		color: var(--color-text);
		overflow-wrap: break-word;
	}

	.fiche__body :global(pre) {
		overflow-x: auto;
		padding: var(--space-3);
		border-radius: var(--radius-md);
		background-color: var(--color-surface-muted);
		font-size: var(--text-sm);
	}

	.fiche__body :global(code) {
		font-family: var(--font-mono, monospace);
	}

	.fiche__body :global(.broken-link) {
		color: var(--color-text-muted);
		text-decoration: line-through;
		cursor: not-allowed;
	}

	.fiche__body--empty {
		color: var(--color-text-muted);
	}

	.study-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	.study-actions form {
		margin: 0;
	}

	.error {
		color: var(--color-danger);
		margin: 0;
	}

	.cta {
		display: inline-block;
		padding: var(--space-2) var(--space-4);
		border-radius: var(--radius-md);
		background-color: var(--color-primary);
		color: var(--color-primary-contrast);
	}

	.cta:hover {
		text-decoration: none;
		filter: brightness(1.05);
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
