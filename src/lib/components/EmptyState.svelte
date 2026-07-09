<script lang="ts">
	// Foundation for empty states (no knowledge base, no bookmark, ...). It only
	// renders a title, an optional description and an optional action slot; the
	// business logic that decides when to show it lives in the feature pages.
	import type { Snippet } from 'svelte';

	let {
		title,
		description,
		action
	}: { title: string; description?: string; action?: Snippet } = $props();
</script>

<div class="empty-state">
	<h2>{title}</h2>
	{#if description}
		<p>{description}</p>
	{/if}
	{#if action}
		<div class="empty-state__action">{@render action()}</div>
	{/if}
</div>

<style>
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: var(--space-3);
		padding: var(--space-8) var(--space-4);
		border: 1px dashed var(--color-border);
		border-radius: var(--radius-lg);
		color: var(--color-text-muted);
	}

	.empty-state h2 {
		color: var(--color-text);
	}

	.empty-state p {
		max-width: 32rem;
	}

	.empty-state__action {
		margin-top: var(--space-2);
	}
</style>
