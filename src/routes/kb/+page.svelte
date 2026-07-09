<script lang="ts">
	import PageContainer from '$lib/components/PageContainer.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
</script>

<svelte:head>
	<title>Knowledge bases — Distil</title>
</svelte:head>

<PageContainer title="Knowledge bases">
	<EmptyState
		title="No knowledge bases yet"
		description="Knowledge bases you add will appear here with their sync status and card count."
	/>
</PageContainer>
