<script lang="ts">
	import { enhance } from '$app/forms';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import Card from '$lib/components/Card.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
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
			<article class="fiche">
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
			<form method="POST" action="?/next" use:enhance>
				<button type="submit" class="primary">Next card</button>
			</form>

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
	{:else}
		<EmptyState
			title="No card to study"
			description="Put a knowledge base in focus with active cards to start drawing cards for study."
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

	.study-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	.study-actions form {
		margin: 0;
	}

	.error {
		color: var(--color-danger, #b00020);
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
</style>
