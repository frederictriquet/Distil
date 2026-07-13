<script lang="ts">
	import { updated } from '$app/state';

	// Update detection (roadmap 13.7). SvelteKit's native mechanism polls the
	// app-version manifest (interval set via kit.version.pollInterval in
	// svelte.config.js) and flips `updated.current` to true once a newer build
	// has been deployed. We surface that here as a discreet, dismissible banner
	// inviting the user to reload onto the new version.
	//
	// Unlike the static, SSR-rendered "archived" banner (persistent reference
	// info, no live region), this notice appears asynchronously in response to a
	// background poll, so a polite live region (role="status") is appropriate to
	// announce it without stealing focus.

	let dismissed = $state(false);

	const showBanner = $derived(updated.current && !dismissed);

	async function reload(): Promise<void> {
		// Re-check to make sure we act on the freshest manifest, then hard reload
		// onto the new version (SvelteKit's idiomatic flow).
		try {
			await updated.check();
		} catch {
			// A failed check shouldn't block the user from reloading.
		}
		location.reload();
	}

	function dismiss(): void {
		dismissed = true;
	}
</script>

{#if showBanner}
	<div class="update-banner" role="status" aria-live="polite">
		<span class="update-banner__text">A new version is available</span>
		<div class="update-banner__actions">
			<button type="button" class="update-banner__reload" onclick={reload}>Reload</button>
			<button
				type="button"
				class="update-banner__dismiss"
				onclick={dismiss}
				aria-label="Dismiss update notification"
			>
				✕
			</button>
		</div>
	</div>
{/if}

<style>
	.update-banner {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-4);
		flex-wrap: wrap;
		padding: var(--space-2) var(--space-4);
		background-color: var(--color-surface-alt);
		color: var(--color-text);
		border-bottom: 1px solid var(--color-border);
		font-size: var(--text-sm);
	}

	.update-banner__actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.update-banner__reload {
		background-color: var(--color-primary);
		color: var(--color-primary-contrast);
		border: none;
	}

	.update-banner__dismiss {
		background: none;
		border: 1px solid var(--color-border);
		color: var(--color-text-muted);
		line-height: 1;
	}

	.update-banner__dismiss:hover {
		color: var(--color-text);
	}
</style>
