<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	/** Human-readable last-sync label: a formatted date, or 'never'. */
	function formatLastSynced(value: Date | string | null): string {
		if (value === null) {
			return 'never';
		}
		const date = value instanceof Date ? value : new Date(value);
		return Number.isNaN(date.getTime()) ? 'never' : date.toLocaleString('en-US');
	}

	const createErrors = $derived(form?.action === 'create' ? form.errors : undefined);
	const createValues = $derived(form?.action === 'create' ? form.values : undefined);

	/**
	 * Failure message from a toggle-focus or delete action (e.g. a stale tab
	 * acting on a KB another tab already removed). Surfaced as a page-level
	 * banner since those actions have no per-field form.
	 */
	const actionError = $derived(
		form && (form.action === 'toggleFocus' || form.action === 'delete' || form.action === 'sync')
			? form.error
			: undefined
	);

	/**
	 * Report from a successful synchronisation (6.7): how many cards were added,
	 * updated and deactivated. Shown as a single page-level banner above the list.
	 */
	const syncReport = $derived(
		form && form.action === 'sync' && form.success ? form.report : undefined
	);
</script>

<svelte:head>
	<title>Knowledge bases — Distil</title>
</svelte:head>

<main class="kb">
	<h1>Knowledge bases</h1>

	{#if actionError}
		<p class="error" role="alert">{actionError}</p>
	{/if}

	{#if syncReport}
		<p class="report" role="status">
			Synchronisation complete: {syncReport.added} added, {syncReport.updated} updated,
			{syncReport.deactivated} deactivated.
		</p>
	{/if}

	<section aria-labelledby="kb-list-heading">
		<h2 id="kb-list-heading">Configured knowledge bases</h2>

		{#if data.knowledgeBases.length === 0}
			<p class="empty">No knowledge base yet. Add one below to get started.</p>
		{:else}
			<table>
				<thead>
					<tr>
						<th scope="col">Name</th>
						<th scope="col">Repository</th>
						<th scope="col">Branch</th>
						<th scope="col">Sub-directory</th>
						<th scope="col">Last synced</th>
						<th scope="col">Focus</th>
						<th scope="col">Active cards</th>
						<th scope="col">Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each data.knowledgeBases as kb (kb.id)}
						<tr>
							<td>{kb.name}</td>
							<td class="repo">{kb.repoUrl}</td>
							<td>{kb.branch}</td>
							<td>{kb.contentSubdir || '—'}</td>
							<td>{formatLastSynced(kb.lastSyncedAt)}</td>
							<td>{kb.focus ? 'On' : 'Off'}</td>
							<td>{kb.activeCardCount}</td>
							<td class="actions">
								<form method="POST" action="?/sync" use:enhance>
									<input type="hidden" name="id" value={kb.id} />
									<button type="submit">Sync</button>
								</form>
								<form method="POST" action="?/toggleFocus" use:enhance>
									<input type="hidden" name="id" value={kb.id} />
									<button type="submit">{kb.focus ? 'Unfocus' : 'Focus'}</button>
								</form>
								<form
									method="POST"
									action="?/delete"
									use:enhance={({ cancel }) => {
										// Deleting a KB hard-cascades its cards, bookmarks and reading
										// history, so require an explicit confirmation first.
										if (
											!confirm(
												`Delete "${kb.name}"? This permanently removes its cards, bookmarks and reading history.`
											)
										) {
											cancel();
										}
									}}
								>
									<input type="hidden" name="id" value={kb.id} />
									<button type="submit" class="danger">Delete</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>

	<section aria-labelledby="kb-add-heading">
		<h2 id="kb-add-heading">Add a knowledge base</h2>

		<form method="POST" action="?/create" use:enhance>
			<label for="name">Name</label>
			<input id="name" name="name" type="text" required value={createValues?.name ?? ''} />
			{#if createErrors?.name}
				<p class="error" role="alert">{createErrors.name}</p>
			{/if}

			<label for="repoUrl">Repository URL</label>
			<input
				id="repoUrl"
				name="repoUrl"
				type="text"
				required
				value={createValues?.repoUrl ?? ''}
			/>
			{#if createErrors?.repoUrl}
				<p class="error" role="alert">{createErrors.repoUrl}</p>
			{/if}

			<label for="branch">Branch</label>
			<input
				id="branch"
				name="branch"
				type="text"
				placeholder="main"
				value={createValues?.branch ?? ''}
			/>

			<label for="contentSubdir">Content sub-directory</label>
			<input
				id="contentSubdir"
				name="contentSubdir"
				type="text"
				value={createValues?.contentSubdir ?? ''}
			/>

			<button type="submit">Add knowledge base</button>
		</form>
	</section>
</main>

<style>
	.kb {
		max-width: 60rem;
		margin: 2rem auto;
		padding: 0 1rem;
		display: flex;
		flex-direction: column;
		gap: 2rem;
	}

	table {
		width: 100%;
		border-collapse: collapse;
	}

	th,
	td {
		text-align: left;
		padding: 0.5rem;
		border-bottom: 1px solid #ddd;
		vertical-align: top;
	}

	.repo {
		word-break: break-all;
	}

	.actions {
		display: flex;
		gap: 0.5rem;
	}

	.actions form {
		margin: 0;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.danger {
		color: #b00020;
	}

	.error {
		color: #b00020;
		margin: 0;
	}

	.empty {
		color: #555;
	}

	.report {
		color: #0b6b3a;
		margin: 0;
	}
</style>
