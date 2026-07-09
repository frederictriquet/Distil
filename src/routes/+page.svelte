<script lang="ts">
	import PageContainer from '$lib/components/PageContainer.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
</script>

<svelte:head>
	<title>Study — Distil</title>
</svelte:head>

<PageContainer title="Study">
	<EmptyState
		title="No knowledge base in focus"
		description="Add a knowledge base and put it in focus to start drawing cards for study."
	>
		{#snippet action()}
			<a class="cta" href="/kb">Manage knowledge bases</a>
		{/snippet}
	</EmptyState>
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
