<script lang="ts">
	// Cards index (roadmap section 11): browse, search and filter the active
	// cards of the knowledge bases in focus, then open one for consultation.
	//
	// This lives at /browse (not /cards) so it does not shadow the existing
	// single-card route /cards/<id>: mounting an index at /cards would turn the
	// trailing-slash URL /cards/ into a redirect to the list instead of the 404
	// that /cards/<id> answers for a structurally invalid id.
	//
	// The search + filter form submits with GET, so the current state is written
	// to the URL query string (11.4). Opening a card navigates to the existing
	// consultation page (/cards/<id>); the browser back button returns here with
	// the same query, preserving the search and filters without re-entering them.
	import PageContainer from '$lib/components/PageContainer.svelte';
	import Card from '$lib/components/Card.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// No knowledge base in focus owns any active card: the perimeter itself is
	// empty, which is different from a search that simply matched nothing.
	const perimeterEmpty = $derived(data.facets.knowledgeBases.length === 0);
	const hasResults = $derived(data.cards.length > 0);
</script>

<svelte:head>
	<title>Cards — Distil</title>
</svelte:head>

<PageContainer title="Cards">
	{#if perimeterEmpty}
		<EmptyState
			title="No cards available"
			description="Put a knowledge base in focus with active cards to browse and search cards here."
		>
			{#snippet action()}
				<a class="cta" href="/kb">Manage knowledge bases</a>
			{/snippet}
		</EmptyState>
	{:else}
		<form method="GET" class="filters" role="search" aria-label="Search and filter cards">
			<div class="filters__field filters__field--search">
				<label for="cards-q">Search</label>
				<input
					id="cards-q"
					name="q"
					type="search"
					value={data.filters.q}
					placeholder="Search title, theme or content"
				/>
			</div>

			<div class="filters__field">
				<label for="cards-kb">Knowledge base</label>
				<select id="cards-kb" name="kb">
					<option value="">All</option>
					{#each data.facets.knowledgeBases as kb (kb.id)}
						<option value={kb.id} selected={data.filters.kbId === kb.id}>{kb.name}</option>
					{/each}
				</select>
			</div>

			<div class="filters__field">
				<label for="cards-theme">Theme</label>
				<select id="cards-theme" name="theme">
					<option value="">All</option>
					{#each data.facets.themes as theme (theme)}
						<option value={theme} selected={data.filters.theme === theme}>{theme}</option>
					{/each}
				</select>
			</div>

			<div class="filters__field">
				<label for="cards-level">Level</label>
				<select id="cards-level" name="level">
					<option value="">All</option>
					{#each data.facets.levels as level (level)}
						<option value={level} selected={data.filters.level === level}>{level}</option>
					{/each}
				</select>
			</div>

			<div class="filters__actions">
				<button type="submit" class="primary">Apply</button>
				<a class="reset" href="/browse">Reset</a>
			</div>
		</form>

		{#if hasResults}
			<ul class="cards">
				{#each data.cards as card (card.id)}
					<li>
						<Card>
							<article class="card-item">
								<h2 class="card-item__title">
									<a href="/cards/{card.id}">{card.title}</a>
								</h2>
								<dl class="card-item__meta">
									{#if card.theme}
										<div class="card-item__meta-item">
											<dt>Theme</dt>
											<dd>{card.theme}</dd>
										</div>
									{/if}
									{#if card.source}
										<div class="card-item__meta-item">
											<dt>Source</dt>
											<dd>{card.source}</dd>
										</div>
									{/if}
								</dl>
							</article>
						</Card>
					</li>
				{/each}
			</ul>
		{:else}
			<EmptyState
				title="No cards match"
				description="No card in focus matches your search and filters. Try different keywords or reset the filters."
			>
				{#snippet action()}
					<a class="cta" href="/browse">Reset filters</a>
				{/snippet}
			</EmptyState>
		{/if}
	{/if}
</PageContainer>

<style>
	.filters {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-3);
	}

	.filters__field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.filters__field--search {
		flex: 1 1 16rem;
	}

	.filters__field--search input {
		width: 100%;
	}

	.filters__field label {
		font-size: var(--text-sm);
		color: var(--color-text-muted);
	}

	.filters__actions {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}

	.cards {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.card-item {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.card-item__title {
		margin: 0;
		font-size: var(--text-lg);
	}

	.card-item__meta {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-5);
		margin: 0;
	}

	.card-item__meta-item {
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.card-item__meta dt {
		font-size: var(--text-sm);
		color: var(--color-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.card-item__meta dd {
		margin: 0;
		color: var(--color-text);
		font-weight: 600;
	}

	.cta,
	.reset {
		display: inline-block;
		padding: var(--space-2) var(--space-4);
		border-radius: var(--radius-md);
	}

	.cta {
		background-color: var(--color-primary);
		color: var(--color-primary-contrast);
	}

	.cta:hover,
	.reset:hover {
		text-decoration: none;
	}

	.reset {
		color: var(--color-text-muted);
	}
</style>
