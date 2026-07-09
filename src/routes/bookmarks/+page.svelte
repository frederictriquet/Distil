<script lang="ts">
	import PageContainer from '$lib/components/PageContainer.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
</script>

<svelte:head>
	<title>Bookmarks — Distil</title>
</svelte:head>

<PageContainer title="Bookmarks">
	<EmptyState
		title="No bookmarks yet"
		description="Cards you bookmark while studying will be grouped by category here."
	/>
</PageContainer>
