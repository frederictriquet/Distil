<script lang="ts">
	// Annotation list & consultation panel (roadmap 15.6/15.7/15.8), shared by
	// every card route through CardView just like the action bar and the capture
	// popup. It mirrors the bookmark panel (CardActions): a keyboard-accessible
	// modal dialog opened by a trigger button, closed via Escape, the Close
	// button or a backdrop click, with focus moved in on open and restored to the
	// trigger on close, styled entirely with theme tokens and mobile-first.
	//
	//   - 15.6: the trigger doubles as the entry point, showing the annotation
	//     count. Resolved spans are already highlighted server-side in the body
	//     (a `<mark class="annotation-highlight" data-annotation-id>`); clicking
	//     such a highlight surfaces that annotation in the panel (handled here via
	//     a delegated click listener on the body element).
	//   - 15.7: the panel lists each annotation (quoted span + note); selecting
	//     one opens it for consultation (its full quote + note).
	//   - 15.8: from a consultation the note is editable and the annotation
	//     deletable, both reflected client-side without a study-card redraw (no
	//     invalidateAll — the current card stays on screen), mirroring the
	//     bookmark panel.
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';

	type AnnotationView = { id: number; note: string; quote: string; detached: boolean };

	let {
		cardId,
		annotations: initialAnnotations,
		bodyEl
	}: {
		cardId: number;
		annotations: AnnotationView[];
		/** The rendered card-body element; a click on a highlight opens its note. */
		bodyEl: HTMLElement | null;
	} = $props();

	let panelOpen = $state(false);
	// The annotation currently being consulted, or null while showing the list.
	let selectedId = $state<number | null>(null);
	let editNote = $state('');
	let editError = $state<string | null>(null);
	let saveMessage = $state<string | null>(null);
	let saving = $state(false);

	// Client-side mutation overlay (task 15.8) applied on top of the server list,
	// so an edit or delete reflects without a study-card redraw. Kept as a derived
	// over the prop (rather than a $state seeded from it) so the list and count
	// still render during SSR — a $derived runs on the server, an $effect does not.
	let deletedIds = $state<Set<number>>(new Set());
	let noteOverrides = $state<Map<number, string>>(new Map());

	const annotations = $derived(
		(initialAnnotations ?? [])
			.filter((a) => !deletedIds.has(a.id))
			.map((a) => (noteOverrides.has(a.id) ? { ...a, note: noteOverrides.get(a.id) ?? a.note } : a))
	);

	let triggerEl: HTMLButtonElement | null = $state(null);
	let panelEl: HTMLElement | null = $state(null);
	let closeButtonEl: HTMLButtonElement | null = $state(null);

	// Reset the overlay and consultation whenever the card changes: an actual
	// navigation to another card reloads `load`, so the server list becomes
	// authoritative again. Edit/delete run without invalidateAll to keep the
	// current card on screen, so between draws the overlay is what reflects them.
	$effect(() => {
		void cardId;
		deletedIds = new Set();
		noteOverrides = new Map();
		selectedId = null;
		editError = null;
		saveMessage = null;
	});

	const selected = $derived(
		selectedId === null ? null : (annotations.find((a) => a.id === selectedId) ?? null)
	);

	function openPanel(): void {
		if (panelOpen) {
			return;
		}
		panelOpen = true;
		selectedId = null;
		void tick().then(() => closeButtonEl?.focus());
	}

	function closePanel(): void {
		if (!panelOpen) {
			return;
		}
		panelOpen = false;
		void tick().then(() => triggerEl?.focus());
	}

	function consult(id: number): void {
		const annotation = annotations.find((a) => a.id === id);
		if (!annotation) {
			return;
		}
		selectedId = id;
		editNote = annotation.note;
		editError = null;
		saveMessage = null;
	}

	function backToList(): void {
		selectedId = null;
		editError = null;
		saveMessage = null;
	}

	/** Open the panel straight onto the annotation whose highlight was clicked. */
	function surface(id: number): void {
		panelOpen = true;
		consult(id);
		void tick().then(() => closeButtonEl?.focus());
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
			'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
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

	// A click on a highlighted span in the body opens its annotation (task 15.6).
	// Delegated on the body element so it also covers the marks re-rendered when a
	// new card is drawn into the shared CardView. The mark carries the annotation
	// id(s) it covers (space-separated for overlaps); the first is surfaced.
	$effect(() => {
		if (!bodyEl) {
			return;
		}
		const onClick = (event: MouseEvent): void => {
			if (!(event.target instanceof Element)) {
				return;
			}
			const mark = event.target.closest('mark[data-annotation-id]');
			if (!mark) {
				return;
			}
			const id = Number(mark.getAttribute('data-annotation-id')?.split(' ')[0]);
			if (Number.isInteger(id)) {
				surface(id);
			}
		};
		bodyEl.addEventListener('click', onClick);
		return () => bodyEl.removeEventListener('click', onClick);
	});

	// Enhance the update: reflect the new note locally and stay on the
	// consultation (no invalidateAll, so the current card is preserved).
	const updateEnhance: SubmitFunction = () => {
		saving = true;
		return async ({ result }) => {
			saving = false;
			saveMessage = null;
			editError = null;
			if (result.type === 'success' && result.data) {
				const updated = (result.data as { annotation?: { id: number; note: string } }).annotation;
				if (updated) {
					noteOverrides = new Map(noteOverrides).set(updated.id, updated.note);
					editNote = updated.note;
				}
				saveMessage = 'Note updated.';
			} else if (result.type === 'failure') {
				editError = (result.data as { error?: string })?.error ?? 'Could not update the note.';
			} else if (result.type === 'error') {
				editError = 'Could not update the note.';
			}
		};
	};

	// Enhance the delete: drop the annotation locally and return to the list
	// (again without a redraw). The body highlight is server-rendered and stays
	// until the next navigation, mirroring the bookmark panel's no-redraw model.
	const deleteEnhance: SubmitFunction = () => {
		saving = true;
		return async ({ result }) => {
			saving = false;
			if (result.type === 'success' && result.data) {
				const removedId = (result.data as { id?: number }).id;
				if (typeof removedId === 'number') {
					deletedIds = new Set(deletedIds).add(removedId);
				}
				backToList();
			} else if (result.type === 'failure') {
				editError = (result.data as { error?: string })?.error ?? 'Could not delete the annotation.';
			} else if (result.type === 'error') {
				editError = 'Could not delete the annotation.';
			}
		};
	};
</script>

{#if annotations.length > 0}
	<div class="annotations-entry">
		<!-- Entry point signalling the card carries annotations (task 15.6). -->
		<button
			type="button"
			bind:this={triggerEl}
			aria-haspopup="dialog"
			aria-expanded={panelOpen}
			onclick={openPanel}
		>
			Annotations ({annotations.length})
		</button>
	</div>
{/if}

{#if panelOpen}
	<!-- Modal annotations panel (15.7/15.8), same accessibility contract as the
	     bookmark panel: focus trap + Escape via onPanelKeydown, and a mouse-only
	     dismiss button (out of the tab order, hidden from assistive tech) that
	     closes it on a backdrop click. -->
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
			aria-labelledby="annotations-panel-title"
			bind:this={panelEl}
			onkeydown={onPanelKeydown}
		>
			<header class="panel__header">
				<h2 id="annotations-panel-title" class="panel__title">
					{#if selected}Annotation{:else}Annotations{/if}
				</h2>
				<button
					type="button"
					class="panel__close"
					bind:this={closeButtonEl}
					onclick={closePanel}
					aria-label="Close annotations panel"
				>
					×
				</button>
			</header>

			{#if selected}
				<!-- Consultation of a single annotation (15.7) with edit/delete (15.8). -->
				<button type="button" class="link panel__back" onclick={backToList}>← Back to list</button>

				<blockquote class="panel__quote">{selected.quote}</blockquote>
				{#if selected.detached}
					<p class="panel__detached">
						This annotation's text was not found in the current card body, so it is
						not highlighted.
					</p>
				{/if}

				<form
					method="POST"
					action="?/updateAnnotation"
					use:enhance={updateEnhance}
					class="panel__edit"
				>
					<input type="hidden" name="annotationId" value={selected.id} />
					<label class="panel__field">
						<span class="panel__field-label">Note</span>
						<textarea name="note" rows="4" bind:value={editNote} required></textarea>
					</label>
					<div class="panel__edit-actions">
						<button type="submit" class="primary" disabled={saving || editNote.trim().length === 0}>
							Save note
						</button>
					</div>
					{#if saveMessage}
						<p class="panel__message" role="status">{saveMessage}</p>
					{/if}
				</form>

				<form
					method="POST"
					action="?/deleteAnnotation"
					use:enhance={deleteEnhance}
					class="panel__delete"
				>
					<input type="hidden" name="annotationId" value={selected.id} />
					<button type="submit" class="panel__delete-button" disabled={saving}>
						Delete annotation
					</button>
				</form>

				{#if editError}
					<p class="panel__error" role="alert">{editError}</p>
				{/if}
			{:else}
				<!-- The card's annotation list (15.7): quoted span + note per item. -->
				<ul class="panel__list">
					{#each annotations as annotation (annotation.id)}
						<li>
							<button
								type="button"
								class="panel__item"
								onclick={() => consult(annotation.id)}
							>
								<span class="panel__item-quote">{annotation.quote}</span>
								<span class="panel__item-note">{annotation.note}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
{/if}

<style>
	.annotations-entry {
		display: flex;
	}

	/* Same modal treatment as the bookmark panel (8.7): mobile-first, theme
	   tokens only, so it follows light/dark automatically. */
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

	.panel__back {
		align-self: flex-start;
		color: var(--color-primary);
		background: none;
		border: 0;
		padding: 0;
	}

	.panel__list {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.panel__item {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		width: 100%;
		text-align: start;
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background-color: var(--color-surface-alt);
	}

	.panel__item-quote {
		color: var(--color-text-muted);
		font-style: italic;
		font-size: var(--text-sm);
		overflow-wrap: break-word;
	}

	.panel__item-note {
		color: var(--color-text);
		overflow-wrap: break-word;
	}

	.panel__quote {
		margin: 0;
		padding-inline-start: var(--space-2);
		border-inline-start: 3px solid var(--color-primary);
		color: var(--color-text-muted);
		font-style: italic;
		overflow-wrap: break-word;
	}

	.panel__detached {
		margin: 0;
		color: var(--color-text-muted);
		font-size: var(--text-sm);
	}

	.panel__edit,
	.panel__delete {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		margin: 0;
	}

	.panel__field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.panel__field-label {
		font-size: var(--text-sm);
		color: var(--color-text-muted);
	}

	.panel__field textarea {
		width: 100%;
		padding: var(--space-2);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background-color: var(--color-surface-alt);
		color: var(--color-text);
		font: inherit;
		resize: vertical;
	}

	.panel__edit-actions {
		display: flex;
		justify-content: flex-end;
	}

	.panel__delete {
		padding-top: var(--space-3);
		border-top: 1px solid var(--color-border);
	}

	.panel__delete-button {
		align-self: flex-start;
		border-color: var(--color-danger);
		color: var(--color-danger);
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
