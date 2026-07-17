<script lang="ts">
	import { afterNavigate } from '$app/navigation';
	import PageContainer from '$lib/components/PageContainer.svelte';
	import CardView from '$lib/components/CardView.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Recording a reading is decoupled from drawing (the phantom-readings fix):
	// `load` only draws, so a hover/tap preload or a programmatic preload — which
	// run `load` but never mount this component — records nothing. The reading is
	// instead recorded by an explicit "this card was really shown" signal sent
	// once the drawn card is on screen: `afterNavigate` fires only after a real
	// navigation mounts/updates the page (never for a bare preload), and we POST
	// the card's id to the dedicated /readings endpoint. Server-side validation
	// there is the boundary that decides what is recorded (see
	// src/routes/readings/+server.ts). This lives only on the study route: a
	// consultation view (a "see also" link or a bookmark) is not a study draw and
	// must not feed the recency exclusion.
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
		<!-- The drawn card renders through the shared CardView, which also carries
		     the action bar (next / bookmark / theme weighting). No Back control
		     here: the study view is the root, there is nowhere to return to. -->
		<CardView
			card={data.card}
			categories={data.categories}
			bookmarkedCategoryIds={data.bookmarkedCategoryIds}
		/>
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
