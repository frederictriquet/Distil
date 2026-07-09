// Login brute-force protection (auth-session-security debt item).
//
// There is otherwise no throttling on the login action, so a single static
// password can be guessed online at full speed. This module adds an in-memory
// per-key (client IP) failed-attempt counter with a lockout window: once
// MAX_FAILED_ATTEMPTS failures accumulate within FAILURE_WINDOW_MS, further
// attempts are rejected until LOCKOUT_MS has elapsed. A successful login clears
// the key. State lives in process memory, matching the single adapter-node
// process that serves the app, and this module takes the current time as an
// explicit argument so it can be unit-tested without wall-clock dependence.

/** Failed attempts allowed before a key is locked out. */
export const MAX_FAILED_ATTEMPTS = 5;

/** Window over which failures are counted before the tally resets (ms). */
export const FAILURE_WINDOW_MS = 15 * 60 * 1000;

/** How long a key stays locked once the limit is reached (ms). */
export const LOCKOUT_MS = 15 * 60 * 1000;

interface AttemptRecord {
	failures: number;
	firstFailureAt: number;
	lockedUntil: number;
}

const attempts = new Map<string, AttemptRecord>();

/**
 * Whether a record is spent as of `now`: its failure window has fully elapsed
 * and it is not (or no longer) locked out, so it carries no live state.
 */
function isStale(record: AttemptRecord, now: number): boolean {
	return record.lockedUntil <= now && now - record.firstFailureAt > FAILURE_WINDOW_MS;
}

/**
 * Drop records that no longer track live state. Called opportunistically on
 * each access so the map cannot grow without bound when an attacker rotates
 * keys (e.g. source IPs) — otherwise every distinct key would leave a permanent
 * entry in this long-lived single-process store.
 */
function pruneExpired(now: number): void {
	for (const [key, record] of attempts) {
		if (isStale(record, now)) {
			attempts.delete(key);
		}
	}
}

/**
 * Report whether `key` is currently locked out. `retryAfterMs` is the remaining
 * lockout time (0 when not limited).
 */
export function checkLoginRateLimit(
	key: string,
	now: number
): { limited: boolean; retryAfterMs: number } {
	pruneExpired(now);
	const record = attempts.get(key);
	if (record && record.lockedUntil > now) {
		return { limited: true, retryAfterMs: record.lockedUntil - now };
	}
	return { limited: false, retryAfterMs: 0 };
}

/**
 * Record a failed login for `key`. Starts a fresh window when none is active or
 * the previous one has fully elapsed, and arms the lockout once the failure
 * count reaches MAX_FAILED_ATTEMPTS.
 */
export function recordFailedLogin(key: string, now: number): void {
	pruneExpired(now);
	let record = attempts.get(key);
	if (!record || now - record.firstFailureAt > FAILURE_WINDOW_MS) {
		record = { failures: 0, firstFailureAt: now, lockedUntil: 0 };
	}
	record.failures += 1;
	if (record.failures >= MAX_FAILED_ATTEMPTS) {
		record.lockedUntil = now + LOCKOUT_MS;
	}
	attempts.set(key, record);
}

/** Clear the attempt tally for `key` (called after a successful login). */
export function clearLoginAttempts(key: string): void {
	attempts.delete(key);
}

/** Reset all tracked attempts. Intended for tests only. */
export function resetRateLimiter(): void {
	attempts.clear();
}
