<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
</script>

<svelte:head>
	<title>Log in — Distil</title>
</svelte:head>

<main class="login">
	<h1>Log in</h1>

	<form method="POST" use:enhance>
		<label for="password">Password</label>
		<input
			id="password"
			name="password"
			type="password"
			autocomplete="current-password"
			required
		/>

		{#if form?.error}
			<p class="error" role="alert">{form.error}</p>
		{/if}

		<button type="submit">Log in</button>
	</form>
</main>

<style>
	.login {
		max-width: 20rem;
		margin: 4rem auto;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.error {
		color: #b00020;
		margin: 0;
	}
</style>
