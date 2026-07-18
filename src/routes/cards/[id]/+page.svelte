<script lang="ts">
	// Card consultation page reached by numeric id (bookmark navigation, task
	// 9.3). It renders the identified card through the shared CardView, reusing
	// the study view's metadata and content presentation (section 7 / 8).
	import PageContainer from '$lib/components/PageContainer.svelte';
	import CardView from '$lib/components/CardView.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.card.title} — Distil</title>
</svelte:head>

<PageContainer>
	<CardView
		card={data.card}
		categories={data.categories}
		bookmarkedCategoryIds={data.bookmarkedCategoryIds}
		annotations={data.annotations}
		showBack
	/>
</PageContainer>
