<script lang="ts">
	// Card display used by the consultation page (roadmap section 10): the card's
	// metadata (title, theme, level, source) and its markdown body rendered to
	// sanitized HTML (section 7). This mirrors the study view's card presentation
	// so a card reads the same however it is reached.
	import Card from '$lib/components/Card.svelte';

	interface CardView {
		title: string;
		theme: string | null;
		level: string | null;
		source: string | null;
		bodyHtml: string;
	}

	let { card }: { card: CardView } = $props();
</script>

<Card>
	<article class="fiche">
		<header class="fiche__header">
			<h2 class="fiche__title">{card.title}</h2>
			<dl class="fiche__meta">
				{#if card.theme}
					<div class="fiche__meta-item">
						<dt>Theme</dt>
						<dd>{card.theme}</dd>
					</div>
				{/if}
				{#if card.level}
					<div class="fiche__meta-item">
						<dt>Level</dt>
						<dd>{card.level}</dd>
					</div>
				{/if}
				{#if card.source}
					<div class="fiche__meta-item">
						<dt>Source</dt>
						<dd>{card.source}</dd>
					</div>
				{/if}
			</dl>
		</header>

		{#if card.bodyHtml}
			<!-- Body is server-rendered markdown, already sanitized with DOMPurify
			     in $lib/server/markdown (roadmap section 7), so injecting it as HTML
			     here is safe. -->
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			<div class="fiche__body">{@html card.bodyHtml}</div>
		{:else}
			<p class="fiche__body fiche__body--empty">This card has no content yet.</p>
		{/if}
	</article>
</Card>

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
		background-color: var(--color-surface-muted, rgba(0, 0, 0, 0.04));
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
</style>
