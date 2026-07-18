<script lang="ts">
	// Annotation capture popup (roadmap 15.4). When the user selects a run of text
	// INSIDE the card body, a minimal popup appears near the selection to type a
	// note; Save posts the note together with the anchor derived from the DOM
	// selection to the current route's shared `annotate` action (15.5). Because it
	// lives in CardView it is reached by every card route (study `/` and both
	// consultation routes) exactly like the shared action bar — never duplicated.
	//
	// The anchor is a W3C TextQuoteSelector, the same shape the server module and
	// the resolver expect (see $lib/server/annotations and annotation-anchor): the
	// exact selected text (quote), short prefix/suffix context, and the character
	// offset of the selection start. All are computed in the body's PLAIN-TEXT
	// coordinate space (Range/textContent, tags dropped, no synthetic whitespace)
	// so they line up with the resolver, which works on the rendered body's
	// `textContent`.
	//
	// The popup is dismissible the snappy ways — Cancel, Escape, or a click
	// outside — moves focus into the input on open, and is styled entirely with
	// theme tokens so it follows light/dark mode and stays usable on mobile.
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';

	let {
		cardId,
		bodyEl
	}: {
		cardId: number;
		/** The rendered card-body element; selections are only captured inside it. */
		bodyEl: HTMLElement | null;
	} = $props();

	/** Characters of surrounding context stored on each side of the quote. */
	const CONTEXT_LENGTH = 32;

	interface Anchor {
		quote: string;
		prefix: string;
		suffix: string;
		startOffset: number;
	}

	let open = $state(false);
	let note = $state('');
	let anchor = $state<Anchor | null>(null);
	let error = $state<string | null>(null);
	let saving = $state(false);
	// Viewport coordinates (position: fixed) of the popup, near the selection.
	let top = $state(0);
	let left = $state(0);

	let popupEl: HTMLElement | null = $state(null);
	let noteInput: HTMLTextAreaElement | null = $state(null);

	/**
	 * Build the TextQuoteSelector anchor from a selection range, in the body's
	 * plain-text coordinate space. `Range.toString()` and `textContent` both
	 * concatenate the contained text nodes without inserting synthetic whitespace,
	 * so the offsets computed here match what the resolver sees. Returns null for a
	 * blank (whitespace-only) selection, which is not worth annotating.
	 */
	function buildAnchor(root: HTMLElement, range: Range): Anchor | null {
		const quote = range.toString();
		if (quote.trim().length === 0) {
			return null;
		}
		// Length of the body text preceding the selection start = its offset.
		const pre = document.createRange();
		pre.selectNodeContents(root);
		pre.setEnd(range.startContainer, range.startOffset);
		const startOffset = pre.toString().length;

		const fullText = root.textContent ?? '';
		const end = startOffset + quote.length;
		return {
			quote,
			prefix: fullText.slice(Math.max(0, startOffset - CONTEXT_LENGTH), startOffset),
			suffix: fullText.slice(end, end + CONTEXT_LENGTH),
			startOffset
		};
	}

	function close(): void {
		open = false;
		note = '';
		anchor = null;
		error = null;
	}

	/** Evaluate the current selection and (re)open the popup when it is inside the body. */
	async function evaluateSelection(): Promise<void> {
		if (!bodyEl) {
			return;
		}
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
			return;
		}
		const range = selection.getRangeAt(0);
		// Only capture selections wholly contained in the card body; anything else
		// (the popup's own textarea, other page chrome) is left alone.
		if (!bodyEl.contains(range.commonAncestorContainer)) {
			return;
		}
		const next = buildAnchor(bodyEl, range);
		if (!next) {
			return;
		}
		anchor = next;
		error = null;

		const rect = range.getBoundingClientRect();
		// Place the popup just below the selection, clamped into the viewport so it
		// stays reachable on small/mobile screens.
		const width = 20 * 16;
		left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
		top = Math.min(rect.bottom + 8, window.innerHeight - 8);
		open = true;
		await tick();
		noteInput?.focus();
	}

	function onPointerDown(event: PointerEvent): void {
		// A click/tap outside the popup dismisses it (equivalent to Cancel). A new
		// selection also starts with a pointer down in the body: closing here is
		// harmless because the following selection event reopens the popup.
		if (open && popupEl && event.target instanceof Node && !popupEl.contains(event.target)) {
			close();
		}
	}

	function onKeydown(event: KeyboardEvent): void {
		if (open && event.key === 'Escape') {
			event.preventDefault();
			close();
			bodyEl?.focus();
		}
	}

	/**
	 * A selection-changing event (mouseup/keyup/touchend) coming from inside the
	 * popup itself — typing in the note field, releasing Escape/Cancel — is not a
	 * change to the document selection in the card body and must not re-run
	 * `evaluateSelection`: doing so would needlessly re-evaluate on every
	 * keystroke, and re-open the popup right after Escape/Cancel closed it (the
	 * original body selection is still active at that point, since focusing the
	 * note field programmatically never cleared it).
	 */
	function onSelectionEvent(event: Event): void {
		if (popupEl && event.target instanceof Node && popupEl.contains(event.target)) {
			return;
		}
		void evaluateSelection();
	}

	// Attach the selection/dismiss listeners while a body element exists. `$effect`
	// re-runs (and cleans up) whenever `bodyEl` changes, e.g. when a new card is
	// drawn into the shared CardView.
	$effect(() => {
		if (!bodyEl) {
			return;
		}
		document.addEventListener('mouseup', onSelectionEvent);
		document.addEventListener('keyup', onSelectionEvent);
		document.addEventListener('touchend', onSelectionEvent);
		document.addEventListener('pointerdown', onPointerDown, true);
		document.addEventListener('keydown', onKeydown, true);
		return () => {
			document.removeEventListener('mouseup', onSelectionEvent);
			document.removeEventListener('keyup', onSelectionEvent);
			document.removeEventListener('touchend', onSelectionEvent);
			document.removeEventListener('pointerdown', onPointerDown, true);
			document.removeEventListener('keydown', onKeydown, true);
		};
	});

	// A new card invalidates any in-flight capture.
	$effect(() => {
		void cardId;
		if (open) {
			close();
		}
	});

	// Enhance the save: reflect success locally by simply closing the popup (no
	// invalidateAll, so the current card stays on screen — mirroring the bookmark
	// panel). A validation failure surfaces the server's message in place.
	const saveEnhance: SubmitFunction = () => {
		saving = true;
		return async ({ result }) => {
			saving = false;
			if (result.type === 'success') {
				close();
			} else if (result.type === 'failure') {
				error = (result.data as { error?: string })?.error ?? 'Could not save the annotation.';
			} else if (result.type === 'error') {
				error = 'Could not save the annotation.';
			}
		};
	};
</script>

<!-- Always-rendered root so every card page carries the capture UI in its markup
     (the popup itself only mounts client-side once a selection exists). -->
<div class="annotation-capture" data-annotation-capture>
	{#if open && anchor}
		<div
			class="capture"
			role="dialog"
			aria-label="Add annotation"
			bind:this={popupEl}
			style="top: {top}px; left: {left}px;"
		>
			<form method="POST" action="?/annotate" use:enhance={saveEnhance} class="capture__form">
				<input type="hidden" name="cardId" value={cardId} />
				<input type="hidden" name="quote" value={anchor.quote} />
				<input type="hidden" name="prefix" value={anchor.prefix} />
				<input type="hidden" name="suffix" value={anchor.suffix} />
				<input type="hidden" name="startOffset" value={anchor.startOffset} />

				<blockquote class="capture__quote">{anchor.quote}</blockquote>
				<label class="capture__field">
					<span class="capture__label">Note</span>
					<textarea
						name="note"
						rows="3"
						bind:this={noteInput}
						bind:value={note}
						placeholder="Write a note about the selected text…"
						required
					></textarea>
				</label>

				{#if error}
					<p class="capture__error" role="alert">{error}</p>
				{/if}

				<div class="capture__actions">
					<button type="button" onclick={close}>Cancel</button>
					<button type="submit" class="primary" disabled={saving || note.trim().length === 0}>
						Save
					</button>
				</div>
			</form>
		</div>
	{/if}
</div>

<style>
	.capture {
		position: fixed;
		z-index: 100;
		width: 20rem;
		max-width: calc(100vw - 1rem);
		padding: var(--space-3);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background-color: var(--color-surface);
		color: var(--color-text);
		box-shadow: var(--shadow-md);
	}

	.capture__form {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		margin: 0;
	}

	.capture__quote {
		margin: 0;
		padding-inline-start: var(--space-2);
		border-inline-start: 3px solid var(--color-primary);
		color: var(--color-text-muted);
		font-size: var(--text-sm);
		font-style: italic;
		max-height: 4.5rem;
		overflow-y: auto;
		overflow-wrap: break-word;
	}

	.capture__field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.capture__label {
		font-size: var(--text-sm);
		color: var(--color-text-muted);
	}

	.capture__field textarea {
		width: 100%;
		padding: var(--space-2);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background-color: var(--color-surface-alt);
		color: var(--color-text);
		font: inherit;
		resize: vertical;
	}

	.capture__actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}

	.capture__error {
		margin: 0;
		color: var(--color-danger);
		font-size: var(--text-sm);
	}
</style>
