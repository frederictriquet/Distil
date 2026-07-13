// Pure horizontal-swipe detection (roadmap section 8.6).
//
// The study view lets a mobile user advance to the next card with a left swipe
// on the card region. The decision of whether a touch/pointer gesture counts as
// a swipe — and in which direction — is isolated here as a pure function so it
// can be unit-tested from plain coordinates without simulating touch events.
// The Svelte component only wires the raw start/end points into `detectSwipe`
// and acts on the result.

/** A gesture endpoint in viewport pixels. */
export interface SwipePoint {
	x: number;
	y: number;
}

/** Tunable thresholds that decide when a movement counts as a swipe. */
export interface SwipeThresholds {
	/** Minimum absolute horizontal travel (px) before a gesture is a swipe. */
	minDistance: number;
	/**
	 * Maximum vertical-to-horizontal travel ratio for the gesture to be
	 * considered horizontally dominant. Above this the movement reads as a
	 * vertical scroll and is ignored.
	 */
	maxOffAxisRatio: number;
}

/**
 * Default thresholds: a swipe needs at least 60px of horizontal travel and the
 * vertical drift must stay under 75% of the horizontal travel, so ordinary
 * vertical scrolls and near-diagonal drags are rejected.
 */
export const DEFAULT_SWIPE_THRESHOLDS: SwipeThresholds = {
	minDistance: 60,
	maxOffAxisRatio: 0.75
};

/**
 * Classify a gesture from its start and end points.
 *
 * Returns `'left'` or `'right'` only when the movement clears
 * {@link SwipeThresholds.minDistance} horizontally and stays horizontally
 * dominant (per {@link SwipeThresholds.maxOffAxisRatio}); otherwise `null`.
 * This keeps vertical scrolls, near-diagonal drags, and taps from registering.
 */
export function detectSwipe(
	start: SwipePoint,
	end: SwipePoint,
	thresholds: SwipeThresholds = DEFAULT_SWIPE_THRESHOLDS
): 'left' | 'right' | null {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const absX = Math.abs(dx);
	const absY = Math.abs(dy);

	// Too short a horizontal move: treat as a tap or an incidental drift.
	if (absX < thresholds.minDistance) {
		return null;
	}
	// Not horizontally dominant: the user was scrolling vertically or dragging
	// diagonally, not swiping.
	if (absY > absX * thresholds.maxOffAxisRatio) {
		return null;
	}
	return dx < 0 ? 'left' : 'right';
}
