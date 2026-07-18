<script lang="ts">
	// Global annotations page (roadmap task 15.12): list every annotation across
	// all cards, each showing its note, its original quoted span and the card it
	// belongs to (with a link to that card's consultation page). From here a note
	// can be edited and an annotation deleted, reusing the same shared server
	// handlers — and thus the same status semantics — as the per-card panel
	// (task 15.8). Modelled on the /bookmarks page (task 9.3): the same load ->
	// list -> empty-state structure, named-action forms and EmptyState usage.
	//
	// The forms use a bare `use:enhance`, whose default behavior applies the
	// action result and re-runs `load`, so an edit or delete refreshes the list
	// in place (unlike the study view's panel, this page has no "current card" to
	// preserve, so a reload is exactly what we want).
	import { enhance } from '$app/forms';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const hasAnnotations = $derived(data.annotations.length > 0);

	/**
	 * Failure message from an edit or delete action — e.g. a blank note, or an
	 * annotation another tab already removed. Surfaced as a page-level banner.
	 */
	const actionError = $derived(
		form &&
			(form.action === 'updateAnnotation' || form.action === 'deleteAnnotation') &&
			!form.success
			? form.error
			: undefined
	);

	/** Display label for a card: its title, falling back to slug, then its id. */
	function cardLabel(annotation: PageData['annotations'][number]): string {
		return annotation.cardTitle || annotation.cardSlug || `Card ${annotation.cardId}`;
	}
</script>

<svelte:head>
	<title>Annotations — Distil</title>
</svelte:head>

<PageContainer title="Annotations">
	{#if actionError}
		<p class="error" role="alert">{actionError}</p>
	{/if}

	{#if !hasAnnotations}
		<EmptyState
			title="No annotations yet"
			description="Annotations you capture while studying a card will appear here, with the quoted span they anchor to and the card they belong to."
		/>
	{:else}
		<ul class="annotations">
			{#each data.annotations as annotation (annotation.id)}
				<li class="annotation">
					<div class="annotation__card">
						<a href="/cards/{annotation.cardId}">{cardLabel(annotation)}</a>
						{#if !annotation.cardActive}
							<span class="badge">inactive</span>
						{/if}
					</div>

					<blockquote class="annotation__quote">{annotation.quote}</blockquote>

					<form method="POST" action="?/updateAnnotation" class="annotation__edit" use:enhance>
						<input type="hidden" name="annotationId" value={annotation.id} />
						<label class="visually-hidden" for="note-{annotation.id}">
							Note for {cardLabel(annotation)}
						</label>
						<textarea id="note-{annotation.id}" name="note" rows="3" required>{annotation.note}</textarea>
						<div class="annotation__actions">
							<button type="submit">Save note</button>
						</div>
					</form>

					<form
						method="POST"
						action="?/deleteAnnotation"
						class="annotation__delete"
						use:enhance={({ cancel }) => {
							if (!confirm('Delete this annotation? This cannot be undone.')) {
								cancel();
							}
						}}
					>
						<input type="hidden" name="annotationId" value={annotation.id} />
						<button
							type="submit"
							class="danger"
							aria-label="Delete annotation on {cardLabel(annotation)}"
						>
							Delete
						</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}
</PageContainer>

<style>
	.annotations {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.annotation {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		padding: var(--space-4);
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.annotation__card {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.annotation__quote {
		margin: 0;
		padding-inline-start: var(--space-2);
		border-inline-start: 3px solid var(--color-primary);
		color: var(--color-text-muted);
		font-style: italic;
		overflow-wrap: break-word;
	}

	.annotation__edit {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin: 0;
	}

	.annotation__edit textarea {
		width: 100%;
		padding: var(--space-2);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background-color: var(--color-surface-alt);
		color: var(--color-text);
		font: inherit;
		resize: vertical;
	}

	.annotation__actions {
		display: flex;
		justify-content: flex-end;
	}

	.annotation__delete {
		margin: 0;
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
