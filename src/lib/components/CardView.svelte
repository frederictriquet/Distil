<script lang="ts">
	// Card display used by the consultation page (roadmap section 10): the card's
	// metadata (title, theme, level, source) and its markdown body rendered to
	// sanitized HTML (section 7). This mirrors the study view's card presentation
	// so a card reads the same however it is reached — including the same action
	// bar (next / bookmark / theme weighting) on every card, wired through
	// CardActions to the current route's shared handlers.
	import Card from '$lib/components/Card.svelte';
	import CardActions from '$lib/components/CardActions.svelte';
	import AnnotationCapture from '$lib/components/AnnotationCapture.svelte';
	import AnnotationsPanel from '$lib/components/AnnotationsPanel.svelte';

	interface CardView {
		id: number;
		title: string;
		theme: string | null;
		level: string | null;
		source: string | null;
		/**
		 * Whether the card is still active; inactive cards render with an archived
		 * banner. Defaults to active for callers (the study view) that only ever
		 * pass freshly drawn, active cards.
		 */
		active?: boolean;
		bodyHtml: string;
	}

	type Category = { id: number; name: string };
	type AnnotationView = { id: number; note: string; quote: string; detached: boolean };

	let {
		card,
		categories,
		bookmarkedCategoryIds,
		annotations = [],
		showBack = false
	}: {
		card: CardView;
		categories: Category[];
		bookmarkedCategoryIds: number[];
		/** The card's annotations (tasks 15.6/15.7), tagged resolved/detached. */
		annotations?: AnnotationView[];
		showBack?: boolean;
	} = $props();

	// The rendered body element, handed to the annotation capture popup (task
	// 15.4) so it only captures selections made inside the card body.
	let bodyEl: HTMLElement | null = $state(null);
</script>

<Card>
	<article class="fiche">
		{#if card.active === false}
			<!-- The card was deactivated by a sync (its file left the repo), but the
			     link, bookmark or direct URL that led here still resolves: show it
			     read-only with a clear archived banner rather than 404-ing or
			     pretending it is a live card. -->
			<p class="fiche__banner">
				This card is archived. It was removed from its knowledge base during a
				sync and is shown here for reference only.
			</p>
		{/if}
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
			<div class="fiche__body" bind:this={bodyEl}>{@html card.bodyHtml}</div>
		{:else}
			<p class="fiche__body fiche__body--empty">This card has no content yet.</p>
		{/if}
	</article>
</Card>

<CardActions {card} {categories} {bookmarkedCategoryIds} {showBack} />

<!-- Text-selection capture popup (task 15.4), shared by every card route through
     CardView just like the action bar. -->
<AnnotationCapture cardId={card.id} {bodyEl} />

<!-- Annotation list & consultation panel (tasks 15.6/15.7/15.8): the entry point
     (count), the list, and per-annotation edit/delete. Clicking a highlighted
     span in the body (decorated server-side) also surfaces its annotation. -->
<AnnotationsPanel cardId={card.id} {annotations} {bodyEl} />

<style>
	.fiche {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.fiche__banner {
		margin: 0;
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--color-primary);
		border-radius: var(--radius-md);
		background-color: var(--color-surface-alt);
		color: var(--color-text-muted);
		font-size: var(--text-sm);
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

	/* Resolved annotation highlight (task 15.6), server-rendered as a
	   <mark class="annotation-highlight"> around the annotated span. Styled with
	   theme tokens only so it stays legible in light and dark; clickable to open
	   the annotation (handled by AnnotationsPanel). */
	.fiche__body :global(mark.annotation-highlight) {
		background-color: var(--color-surface-muted);
		color: inherit;
		border-bottom: 2px solid var(--color-primary);
		border-radius: var(--radius-sm);
		padding: 0 0.1em;
		cursor: pointer;
	}

	.fiche__body--empty {
		color: var(--color-text-muted);
	}
</style>
