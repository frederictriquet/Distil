<script lang="ts">
	// Centers page content within a readable max width. Business pages wrap their
	// content in this so spacing stays consistent across the app.
	import type { Snippet } from 'svelte';

	let { title, children }: { title?: string; children: Snippet } = $props();
</script>

<section class="page">
	{#if title}
		<h1>{title}</h1>
	{/if}
	{@render children()}
</section>

<style>
	.page {
		width: 100%;
		max-width: var(--content-max-width);
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}
</style>
