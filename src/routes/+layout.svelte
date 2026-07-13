<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { APP_VERSION } from '$lib/version';
	import UpdateNotifier from '$lib/components/UpdateNotifier.svelte';

	let { children } = $props();

	// Primary sections planned by the roadmap. The links are always present;
	// sections that are not built yet simply resolve to their placeholder page,
	// so navigation never breaks.
	const navItems = [
		{ href: '/', label: 'Study' },
		{ href: '/cards', label: 'Cards' },
		{ href: '/kb', label: 'Knowledge bases' },
		{ href: '/bookmarks', label: 'Bookmarks' }
	];

	// The login screen stands on its own, before the app shell is relevant, so it
	// renders without the header/footer chrome.
	const isAuthPage = $derived(page.url.pathname === '/login');

	// Build-time application version (roadmap 13.6), shown discreetly in the
	// footer. The value is "<semver>+<shortSha>"; guard against an empty/unknown
	// value — including one whose SemVer part is missing (a leading "+", e.g.
	// "+unknown") — so we never render a bare "Version " label or an orphaned "+".
	const rawVersion = APP_VERSION?.trim() ?? '';
	const appVersion = rawVersion && !rawVersion.startsWith('+') ? rawVersion : '';

	function isActive(href: string): boolean {
		const path = page.url.pathname;
		if (href === '/') return path === '/';
		return path === href || path.startsWith(`${href}/`);
	}

	let theme = $state<'light' | 'dark'>('light');

	onMount(() => {
		const root = document.documentElement;
		const stored = root.dataset.theme;
		if (stored === 'light' || stored === 'dark') {
			theme = stored;
		} else {
			theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
		}
	});

	function toggleTheme(): void {
		theme = theme === 'dark' ? 'light' : 'dark';
		document.documentElement.dataset.theme = theme;
		try {
			localStorage.setItem('distil-theme', theme);
		} catch {
			// Ignore storage failures (e.g. private mode); the toggle still works
			// for the current session.
		}
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{#if isAuthPage}
	{@render children()}
{:else}
	<div class="app-shell">
		<UpdateNotifier />
		<header class="app-header">
			<div class="app-header__inner">
				<!-- Preloading links to `/` (the study view) is safe: its `load` only
				     draws a card, and the reading is recorded only when the drawn card
				     is actually shown, via the client "card shown" signal the page
				     sends from afterNavigate (see routes/+page.svelte) — never during a
				     preload, which runs `load` without mounting the page. So all links
				     keep the app-wide hover preloading. -->
				<a class="brand" href="/">Distil</a>
				<nav class="nav" aria-label="Primary">
					{#each navItems as item (item.href)}
						<a
							class="nav__link"
							href={item.href}
							aria-current={isActive(item.href) ? 'page' : undefined}
						>
							{item.label}
						</a>
					{/each}
				</nav>
				<div class="app-header__actions">
					<button
						type="button"
						class="theme-toggle"
						onclick={toggleTheme}
						aria-label="Toggle color theme"
						title="Toggle color theme"
					>
						{theme === 'dark' ? '☀' : '☾'}
					</button>
					<form method="POST" action="/logout">
						<button type="submit">Log out</button>
					</form>
				</div>
			</div>
		</header>

		<main class="app-main">
			{@render children()}
		</main>

		<footer class="app-footer">
			<span>Distil — your personal knowledge base study companion</span>
			{#if appVersion}
				<span class="app-footer__version">Version {appVersion}</span>
			{/if}
		</footer>
	</div>
{/if}

<style>
	.app-shell {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
	}

	.app-header {
		border-bottom: 1px solid var(--color-border);
		background-color: var(--color-surface);
		position: sticky;
		top: 0;
		z-index: 10;
	}

	/* Mobile-first: the header stays a compact single bar on small screens.
	   Roomier spacing and larger type are layered in at >=40rem below, matching
	   the rest of the app's mobile-first breakpoint (see +page.svelte). Without
	   this the large gaps and text-lg brand overflow a phone width and wrap the
	   bar onto several lines. */
	.app-header__inner {
		max-width: var(--content-max-width);
		margin: 0 auto;
		padding: var(--space-2) var(--space-3);
		display: flex;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		flex-wrap: wrap;
	}

	.brand {
		font-weight: 700;
		font-size: var(--text-base);
		color: var(--color-text);
	}

	.brand:hover {
		text-decoration: none;
	}

	.nav {
		display: flex;
		gap: var(--space-1);
		flex: 1;
		flex-wrap: wrap;
	}

	.nav__link {
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-md);
		color: var(--color-text-muted);
	}

	.nav__link:hover {
		background-color: var(--color-surface-alt);
		text-decoration: none;
	}

	.nav__link[aria-current='page'] {
		color: var(--color-text);
		background-color: var(--color-surface-alt);
		font-weight: 600;
	}

	.app-header__actions {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		/* Keep the actions pinned to the trailing edge without stretching the
		   nav, so the bar reads brand · nav · actions even when it wraps. */
		margin-left: auto;
	}

	/* Trim the action buttons on mobile so brand + nav + actions fit one row. */
	.app-header__actions :global(button) {
		padding: var(--space-1) var(--space-2);
		font-size: var(--text-sm);
	}

	.theme-toggle {
		line-height: 1;
	}

	/* Desktop and up: restore the original roomy header. */
	@media (min-width: 40rem) {
		.app-header__inner {
			padding: var(--space-3) var(--space-4);
			gap: var(--space-5);
		}

		.brand {
			font-size: var(--text-lg);
		}

		.nav {
			gap: var(--space-2);
		}

		.nav__link {
			padding: var(--space-2) var(--space-3);
		}

		.app-header__actions {
			gap: var(--space-2);
		}

		.app-header__actions :global(button) {
			padding: var(--space-2) var(--space-4);
			font-size: var(--text-base);
		}
	}

	.app-main {
		flex: 1;
		width: 100%;
		padding: var(--space-6) var(--space-4);
	}

	.app-footer {
		border-top: 1px solid var(--color-border);
		padding: var(--space-4);
		text-align: center;
		color: var(--color-text-muted);
		font-size: var(--text-sm);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-1);
	}

	.app-footer__version {
		font-size: var(--text-sm);
		color: var(--color-text-muted);
		opacity: 0.85;
	}
</style>
