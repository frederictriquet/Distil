<script lang="ts">
	// Annotation capture (roadmap 15.4), two-stage so it never fights the browser's
	// own text selection:
	//   1. PROMPT — when the user selects a run of text INSIDE the card body, a
	//      small floating "Add note" button appears near the selection. Crucially
	//      nothing steals focus here, so the selection (and, on mobile, the native
	//      selection handles) stays put. This is the fix for the selection being
	//      cleared the instant the mouse was released / the touch ended.
	//   2. EDIT — clicking that button opens the note editor (the quoted text plus
	//      a textarea) and focuses it; losing the visual selection now is fine
	//      because the quote is shown in the popup. Save posts the note together
	//      with the anchor to the current route's shared `annotate` action (15.5).
	//
	// Because it lives in CardView it is reached by every card route (study `/` and
	// both consultation routes) exactly like the shared action bar — never
	// duplicated.
	//
	// The anchor is a W3C TextQuoteSelector, the same shape the server module and
	// resolver expect: the exact selected text (quote), short prefix/suffix
	// context, and the character offset of the selection start, all computed in the
	// body's PLAIN-TEXT coordinate space (Range/textContent) so they line up with
	// the resolver.
	//
	// Detection is driven by the canonical `selectionchange` event (debounced): it
	// fires for desktop mouse drags AND mobile long-press + handle adjustments,
	// unlike mouseup/touchend which never fire for mobile selection.
	import { tick, untrack } from 'svelte';
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

	// 'hidden' → nothing shown; 'prompt' → the floating "Add note" button is shown
	// next to a live selection; 'edit' → the note editor is open.
	let mode = $state<'hidden' | 'prompt' | 'edit'>('hidden');
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
		mode = 'hidden';
		note = '';
		anchor = null;
		error = null;
	}

	/** Position the floating UI just below `rect`, clamped into the viewport. */
	function positionTo(rect: DOMRect): void {
		const width = 20 * 16;
		left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
		top = Math.min(rect.bottom + 8, window.innerHeight - 8);
	}

	/**
	 * Evaluate the current selection and show the "Add note" prompt when it is a
	 * non-empty run inside the card body. Never steals focus or clears the
	 * selection — that is what let the browser "take over" before. While the editor
	 * is open we ignore selection changes (the caret moving into the textarea must
	 * not reset anything).
	 */
	function evaluateSelection(): void {
		if (!bodyEl || mode === 'edit') {
			return;
		}
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
			return;
		}
		const range = selection.getRangeAt(0);
		// Only capture selections wholly contained in the card body; anything else
		// (page chrome, the popup itself) is left alone.
		if (!bodyEl.contains(range.commonAncestorContainer)) {
			return;
		}
		const next = buildAnchor(bodyEl, range);
		if (!next) {
			return;
		}
		anchor = next;
		error = null;
		positionTo(range.getBoundingClientRect());
		mode = 'prompt';
	}

	/** Move from the prompt to the editor and focus the note field. */
	async function openEditor(): Promise<void> {
		if (!anchor) {
			return;
		}
		mode = 'edit';
		await tick();
		noteInput?.focus();
	}

	let debounceId: ReturnType<typeof setTimeout> | null = null;

	function onSelectionChange(): void {
		if (debounceId !== null) {
			clearTimeout(debounceId);
		}
		debounceId = setTimeout(() => {
			debounceId = null;
			evaluateSelection();
		}, 150);
	}

	function onPointerDown(event: PointerEvent): void {
		// A click/tap outside the floating UI dismisses it.
		if (mode !== 'hidden' && popupEl && event.target instanceof Node && !popupEl.contains(event.target)) {
			close();
		}
	}

	function onKeydown(event: KeyboardEvent): void {
		if (mode !== 'hidden' && event.key === 'Escape') {
			event.preventDefault();
			close();
		}
	}

	// Attach the selection/dismiss listeners once on mount. They intentionally do
	// NOT depend on `bodyEl` (which is checked at call time inside the handlers),
	// so a late `bind:this` assignment can never leave them unattached.
	$effect(() => {
		document.addEventListener('selectionchange', onSelectionChange);
		document.addEventListener('pointerdown', onPointerDown, true);
		document.addEventListener('keydown', onKeydown, true);
		return () => {
			if (debounceId !== null) {
				clearTimeout(debounceId);
				debounceId = null;
			}
			document.removeEventListener('selectionchange', onSelectionChange);
			document.removeEventListener('pointerdown', onPointerDown, true);
			document.removeEventListener('keydown', onKeydown, true);
		};
	});

	// A new card invalidates any in-flight capture. This effect must fire ONLY when
	// `cardId` changes — reading `mode` reactively here would make it re-run the
	// instant a selection sets mode to 'prompt', immediately closing it again
	// (the bug that made the popup never appear). `untrack` keeps the mode read out
	// of the dependency set.
	$effect(() => {
		void cardId;
		untrack(() => {
			if (mode !== 'hidden') {
				close();
			}
		});
	});

	// Enhance the save: reflect success locally by simply closing (no invalidateAll,
	// so the current card stays on screen — mirroring the bookmark panel). A
	// validation failure surfaces the server's message in place.
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
     (the floating prompt/editor only mounts client-side once a selection exists). -->
<div class="annotation-capture" data-annotation-capture>
	{#if mode !== 'hidden' && anchor}
		<div
			class="capture"
			class:capture--prompt={mode === 'prompt'}
			role="dialog"
			aria-label="Add annotation"
			bind:this={popupEl}
			style="top: {top}px; left: {left}px;"
		>
			{#if mode === 'prompt'}
				<button type="button" class="capture__add primary" onclick={openEditor}>
					+ Add note
				</button>
			{:else}
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
			{/if}
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

	/* The prompt is a compact chip, not a full panel. */
	.capture--prompt {
		width: auto;
		padding: 0;
		border: 0;
		background: transparent;
		box-shadow: none;
	}

	.capture__add {
		white-space: nowrap;
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
