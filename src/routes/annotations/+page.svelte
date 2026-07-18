<script lang="ts">
	// Global annotations page (roadmap task 15.12): list every annotation across
	// all cards, each showing its note, its original quoted span and the card it
	// belongs to (with a link to that card's consultation page). From here a note
	// can be edited and an annotation deleted, reusing the same shared server
	// handlers — and thus the same status semantics — as the per-card panel
	// (task 15.8). Modelled on the /bookmarks page (task 9.3): the same load ->
	// list -> empty-state structure and EmptyState usage.
	//
	// Every row shows its own textarea at once (unlike the per-card panel's
	// single-selection modal), so an edit/delete must not `invalidateAll`: doing
	// so would reload `data.annotations` and reset every OTHER row's textarea to
	// its last-saved value, discarding any unsaved edit in progress there.
	// Instead each form's `use:enhance` reflects its own result into a local
	// overlay (mirroring the per-card panel's noteOverrides/deletedIds), and a
	// failure is attached to the row it belongs to rather than a page-level
	// banner detached from the annotation that actually failed.
	import { enhance } from '$app/forms';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let deletedIds = $state<Set<number>>(new Set());
	let noteOverrides = $state<Map<number, string>>(new Map());
	let rowErrors = $state<Map<number, string>>(new Map());

	const annotations = $derived(
		data.annotations
			.filter((a) => !deletedIds.has(a.id))
			.map((a) => (noteOverrides.has(a.id) ? { ...a, note: noteOverrides.get(a.id) ?? a.note } : a))
	);

	const hasAnnotations = $derived(annotations.length > 0);

	/** Display label for a card: its title, falling back to slug, then its id. */
	function cardLabel(annotation: PageData['annotations'][number]): string {
		return annotation.cardTitle || annotation.cardSlug || `Card ${annotation.cardId}`;
	}

	/** Immutable removal of a row's error, so an unrelated row's error map entry is untouched. */
	function withoutError(map: Map<number, string>, id: number): Map<number, string> {
		if (!map.has(id)) {
			return map;
		}
		const next = new Map(map);
		next.delete(id);
		return next;
	}

	/** Reflect an edit's result into this row alone, without invalidateAll (see header). */
	function updateEnhanceFor(id: number): SubmitFunction {
		return () => {
			return async ({ result }) => {
				if (result.type === 'success' && result.data) {
					const updated = (result.data as { annotation?: { id: number; note: string } }).annotation;
					if (updated) {
						noteOverrides = new Map(noteOverrides).set(updated.id, updated.note);
					}
					rowErrors = withoutError(rowErrors, id);
				} else if (result.type === 'failure') {
					rowErrors = new Map(rowErrors).set(
						id,
						(result.data as { error?: string })?.error ?? 'Could not update the note.'
					);
				} else if (result.type === 'error') {
					rowErrors = new Map(rowErrors).set(id, 'Could not update the note.');
				}
			};
		};
	}

	/** Reflect a delete's result into this row alone, without invalidateAll (see header). */
	function deleteEnhanceFor(id: number): SubmitFunction {
		return ({ cancel }) => {
			if (!confirm('Delete this annotation? This cannot be undone.')) {
				cancel();
				return;
			}
			return async ({ result }) => {
				if (result.type === 'success') {
					deletedIds = new Set(deletedIds).add(id);
					rowErrors = withoutError(rowErrors, id);
				} else if (result.type === 'failure') {
					rowErrors = new Map(rowErrors).set(
						id,
						(result.data as { error?: string })?.error ?? 'Could not delete the annotation.'
					);
				} else if (result.type === 'error') {
					rowErrors = new Map(rowErrors).set(id, 'Could not delete the annotation.');
				}
			};
		};
	}
</script>

<svelte:head>
	<title>Annotations — Distil</title>
</svelte:head>

<PageContainer title="Annotations">
	{#if !hasAnnotations}
		<EmptyState
			title="No annotations yet"
			description="Annotations you capture while studying a card will appear here, with the quoted span they anchor to and the card they belong to."
		/>
	{:else}
		<ul class="annotations">
			{#each annotations as annotation (annotation.id)}
				<li class="annotation">
					<div class="annotation__card">
						<a href="/cards/{annotation.cardId}">{cardLabel(annotation)}</a>
						{#if !annotation.cardActive}
							<span class="badge">inactive</span>
						{/if}
					</div>

					<blockquote class="annotation__quote">{annotation.quote}</blockquote>

					<form
						method="POST"
						action="?/updateAnnotation"
						class="annotation__edit"
						use:enhance={updateEnhanceFor(annotation.id)}
					>
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
						use:enhance={deleteEnhanceFor(annotation.id)}
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

					{#if rowErrors.has(annotation.id)}
						<p class="annotation__error" role="alert">{rowErrors.get(annotation.id)}</p>
					{/if}
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

	.annotation__error {
		margin: 0;
		color: var(--color-danger);
		font-size: var(--text-sm);
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
