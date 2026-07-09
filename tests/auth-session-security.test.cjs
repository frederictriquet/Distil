// Verifies the `auth-session-security` debt item resolution (see
// docs/DETTE-TECHNIQUE.md): server-side session revocation on logout,
// login rate limiting / brute-force protection, and SESSION_SECRET
// strength enforcement.
//
// `src/lib/server/session-revocation.ts`, `src/lib/server/rate-limit.ts`
// and the secret-strength helpers in `src/lib/server/auth.ts` are plain
// TypeScript with no SvelteKit imports (by design, per their own header
// comments, so they stay unit-testable outside a running server). Each
// check below runs the real module through `tsx` in a fresh process (one
// process per assertion group), the same out-of-process pattern already
// used by tests/kb-management.test.cjs, via a small harness script
// written to a throwaway temp file.
//
// `src/hooks.server.ts` and `src/routes/login/+page.server.ts` cannot be
// loaded the same way: they import SvelteKit virtual modules
// (`$app/environment`, `$env/dynamic/private`) that only resolve inside a
// Vite/SvelteKit build, and this project has no dev-server/e2e test
// harness installed. The "wiring" checks below instead read those two
// files' real source to confirm the guard and the login action actually
// call into the modules under test, so a regression that silently
// unplugs the revocation check, the rate limiter or the secret check
// (while leaving the underlying module intact) still fails loudly.
//
// Run with: node --test tests/
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TSX_CLI = require.resolve('tsx/cli');

function readText(relPath) {
	return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

// Harness executed by `tsx` (in a fresh process per call, so module-level
// state such as the revocation epoch or the rate-limit map always starts
// clean) to load the real security modules and dispatch one action against
// them, printing the JSON result on stdout.
const HARNESS_SOURCE = `
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [, , rootDir, action, payloadJson] = process.argv;
const payload = JSON.parse(payloadJson || '{}');

const authUrl = pathToFileURL(path.join(rootDir, 'src', 'lib', 'server', 'auth.ts')).href;
const revocationUrl = pathToFileURL(
	path.join(rootDir, 'src', 'lib', 'server', 'session-revocation.ts')
).href;
const rateLimitUrl = pathToFileURL(path.join(rootDir, 'src', 'lib', 'server', 'rate-limit.ts')).href;

const auth = await import(authUrl);
const revocation = await import(revocationUrl);
const rateLimit = await import(rateLimitUrl);

function run() {
	switch (action) {
		case 'constants':
			return {
				MIN_SESSION_SECRET_LENGTH: auth.MIN_SESSION_SECRET_LENGTH,
				MAX_FAILED_ATTEMPTS: rateLimit.MAX_FAILED_ATTEMPTS,
				FAILURE_WINDOW_MS: rateLimit.FAILURE_WINDOW_MS,
				LOCKOUT_MS: rateLimit.LOCKOUT_MS
			};
		case 'isUsableSecret':
			return { usable: auth.isUsableSecret(payload.secret) };
		case 'revocation': {
			// payload.revokeAt: revocation instants applied in order (tests the
			// monotonic guarantee when more than one is given).
			// payload.checks: iat values probed with isSessionRevoked after all
			// revocations have been applied.
			revocation.resetRevocationStore();
			for (const instant of payload.revokeAt || []) {
				revocation.revokeSessionsIssuedBefore(instant);
			}
			return {
				results: (payload.checks || []).map((iat) => revocation.isSessionRevoked(iat))
			};
		}
		case 'rateLimit': {
			// payload.ops: a sequence of { op: 'check'|'recordFailed'|'clear', key, now }.
			// 'check' ops are recorded into the returned results array in order.
			rateLimit.resetRateLimiter();
			const results = [];
			for (const step of payload.ops || []) {
				if (step.op === 'check') {
					results.push(rateLimit.checkLoginRateLimit(step.key, step.now));
				} else if (step.op === 'recordFailed') {
					rateLimit.recordFailedLogin(step.key, step.now);
				} else if (step.op === 'clear') {
					rateLimit.clearLoginAttempts(step.key);
				} else {
					throw new Error('unknown rate-limit op: ' + step.op);
				}
			}
			return { results };
		}
		default:
			throw new Error('unknown harness action: ' + action);
	}
}

process.stdout.write(JSON.stringify(run()));
`;

let harnessDir;
let harnessPath;

before(() => {
	harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distil-auth-security-harness-'));
	harnessPath = path.join(harnessDir, 'auth-security-harness.mjs');
	fs.writeFileSync(harnessPath, HARNESS_SOURCE, 'utf8');
});

after(() => {
	if (harnessDir) fs.rmSync(harnessDir, { recursive: true, force: true });
});

/** Run one harness action, out-of-process via tsx, and return its parsed JSON result. */
function runHarness(action, payload) {
	const result = spawnSync(process.execPath, [TSX_CLI, harnessPath, ROOT, action, JSON.stringify(payload ?? {})], {
		cwd: ROOT,
		encoding: 'utf8',
		timeout: 30 * 1000
	});

	if (result.error) {
		throw new Error(`running harness action "${action}" failed to spawn: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`harness action "${action}" exited with ${result.status}:\n${result.stdout}\n${result.stderr}`);
	}
	return JSON.parse(result.stdout.trim());
}

let CONST;
before(() => {
	CONST = runHarness('constants', {});
});

describe('server-side session revocation on logout (auth-session-security)', () => {
	test('a token issued before the revocation instant is rejected', () => {
		const { results } = runHarness('revocation', { revokeAt: [1000], checks: [500] });
		assert.equal(results[0], true, 'a session issued before logout must be revoked');
	});

	test('a token issued exactly at the revocation instant is rejected', () => {
		const { results } = runHarness('revocation', { revokeAt: [1000], checks: [1000] });
		assert.equal(results[0], true, 'the token active at logout time must itself be revoked');
	});

	test('a token issued after the revocation instant remains valid', () => {
		const { results } = runHarness('revocation', { revokeAt: [1000], checks: [1500] });
		assert.equal(results[0], false, 'a session created after the logout must not be revoked');
	});

	test('with no logout yet, nothing is revoked', () => {
		const { results } = runHarness('revocation', { revokeAt: [], checks: [0, 1, 1e15] });
		assert.deepEqual(results, [false, false, false]);
	});

	test('revocation is monotonic: an earlier logout recorded after a later one does not un-revoke tokens', () => {
		const { results } = runHarness('revocation', { revokeAt: [1000, 200], checks: [500, 1000] });
		assert.deepEqual(
			results,
			[true, true],
			'once revoked up to 1000, a later revoke(200) call must not shrink the revoked set'
		);
	});

	test('the dedicated /logout route revokes the presented session before clearing the cookie', () => {
		// Logout moved from a bespoke hooks.server.ts interception to a dedicated
		// /logout endpoint (sveltekit-action-contract), but it must still revoke
		// the session server-side before clearing the cookie.
		const logout = readText('src/routes/logout/+server.ts');
		assert.match(
			logout,
			/import\s*\{[^}]*revokeSessionsIssuedBefore[^}]*\}\s*from\s*['"]\$lib\/server\/session-revocation['"]/,
			'expected the logout route to import revokeSessionsIssuedBefore from the revocation module'
		);
		const revokeCallIndex = logout.indexOf('revokeSessionsIssuedBefore(');
		const cookieClearIndex = logout.indexOf('cookies.delete(');
		assert.ok(revokeCallIndex !== -1, 'expected the logout route to call revokeSessionsIssuedBefore(...)');
		assert.ok(cookieClearIndex !== -1, 'expected the logout route to clear the session cookie');
		assert.ok(
			revokeCallIndex < cookieClearIndex,
			'the token must be revoked server-side before the cookie is cleared'
		);
	});

	test('hooks.server.ts treats a revoked session as unauthenticated', () => {
		const hooks = readText('src/hooks.server.ts');
		assert.match(
			hooks,
			/import\s*\{[^}]*isSessionRevoked[^}]*\}\s*from\s*['"]\$lib\/server\/session-revocation['"]/,
			'expected hooks.server.ts to import isSessionRevoked from the revocation module'
		);
		assert.match(
			hooks,
			/authenticated\s*=\s*[\s\S]{0,80}!isSessionRevoked\(/,
			'expected the authenticated flag computation to reject sessions where isSessionRevoked(iat) is true'
		);
	});
});

describe('login rate limiting / brute-force protection (auth-session-security)', () => {
	test('attempts below the configured threshold are never limited', () => {
		const ops = [];
		for (let i = 0; i < CONST.MAX_FAILED_ATTEMPTS - 1; i++) {
			ops.push({ op: 'check', key: '1.2.3.4', now: 0 });
			ops.push({ op: 'recordFailed', key: '1.2.3.4', now: 0 });
		}
		const { results } = runHarness('rateLimit', { ops });
		assert.ok(
			results.every((r) => r.limited === false),
			`expected no lockout before ${CONST.MAX_FAILED_ATTEMPTS} failures, got ${JSON.stringify(results)}`
		);
	});

	test('the Nth failure reaching the threshold locks the key out with a positive retry delay', () => {
		const ops = [];
		for (let i = 0; i < CONST.MAX_FAILED_ATTEMPTS; i++) {
			ops.push({ op: 'recordFailed', key: '1.2.3.4', now: 0 });
		}
		ops.push({ op: 'check', key: '1.2.3.4', now: 0 });
		const { results } = runHarness('rateLimit', { ops });
		assert.equal(results[0].limited, true, `expected lockout after ${CONST.MAX_FAILED_ATTEMPTS} failed attempts`);
		assert.ok(results[0].retryAfterMs > 0, 'expected a positive retry-after delay while locked out');
	});

	test('a successful login clears the tally and lifts the lockout', () => {
		const ops = [];
		for (let i = 0; i < CONST.MAX_FAILED_ATTEMPTS; i++) {
			ops.push({ op: 'recordFailed', key: '1.2.3.4', now: 0 });
		}
		ops.push({ op: 'check', key: '1.2.3.4', now: 0 });
		ops.push({ op: 'clear', key: '1.2.3.4', now: 0 });
		ops.push({ op: 'check', key: '1.2.3.4', now: 0 });
		const { results } = runHarness('rateLimit', { ops });
		assert.equal(results[0].limited, true, 'sanity check: should have been locked out before clearing');
		assert.equal(results[1].limited, false, 'clearing attempts after a successful login must lift the lockout');
	});

	test('a fully elapsed failure window resets the tally instead of accumulating forever', () => {
		const ops = [
			{ op: 'recordFailed', key: '1.2.3.4', now: 0 },
			{ op: 'recordFailed', key: '1.2.3.4', now: 0 },
			// Window has fully elapsed: this failure must start a fresh window.
			{ op: 'recordFailed', key: '1.2.3.4', now: CONST.FAILURE_WINDOW_MS + 1 },
			{ op: 'check', key: '1.2.3.4', now: CONST.FAILURE_WINDOW_MS + 1 }
		];
		const { results } = runHarness('rateLimit', { ops });
		assert.equal(
			results[0].limited,
			false,
			'3 failures spread across two non-overlapping windows must not trigger the lockout'
		);
	});

	test('lockout is scoped per key (e.g. per client IP), not global', () => {
		const ops = [];
		for (let i = 0; i < CONST.MAX_FAILED_ATTEMPTS; i++) {
			ops.push({ op: 'recordFailed', key: 'attacker-ip', now: 0 });
		}
		ops.push({ op: 'check', key: 'attacker-ip', now: 0 });
		ops.push({ op: 'check', key: 'innocent-ip', now: 0 });
		const { results } = runHarness('rateLimit', { ops });
		assert.equal(results[0].limited, true, 'the offending key must be locked out');
		assert.equal(results[1].limited, false, 'a different key must not be affected by another key\'s lockout');
	});

	test('the login action checks the rate limit before verifying the password and returns 429 when limited', () => {
		const action = readText('src/routes/login/+page.server.ts');
		assert.match(
			action,
			/import\s*\{[^}]*checkLoginRateLimit[^}]*\}\s*from\s*['"]\$lib\/server\/rate-limit['"]/,
			'expected the login action to import checkLoginRateLimit from the rate-limit module'
		);
		const rateLimitCheckIndex = action.indexOf('checkLoginRateLimit(');
		const passwordCheckIndex = action.indexOf('verifyPassword(');
		assert.ok(rateLimitCheckIndex !== -1, 'expected the login action to call checkLoginRateLimit(...)');
		assert.ok(passwordCheckIndex !== -1, 'expected the login action to verify the password');
		assert.ok(
			rateLimitCheckIndex < passwordCheckIndex,
			'the rate limit must be checked before spending work verifying the password'
		);
		assert.match(action, /fail\(\s*429\s*,/, 'expected a 429 response when the rate limit is exceeded');
	});

	test('the login action records failures and clears them on success', () => {
		const action = readText('src/routes/login/+page.server.ts');
		assert.match(
			action,
			/import\s*\{[^}]*recordFailedLogin[^}]*clearLoginAttempts|clearLoginAttempts[^}]*recordFailedLogin[^}]*\}\s*from\s*['"]\$lib\/server\/rate-limit['"]/,
			'expected the login action to import both recordFailedLogin and clearLoginAttempts from the rate-limit module'
		);
		assert.match(action, /recordFailedLogin\(/, 'expected a failed password attempt to be recorded');
		assert.match(action, /clearLoginAttempts\(/, 'expected a successful login to clear the failure tally');
	});
});

describe('SESSION_SECRET strength enforcement (auth-session-security)', () => {
	test('an undefined secret is unusable', () => {
		const { usable } = runHarness('isUsableSecret', {});
		assert.equal(usable, false);
	});

	test('a secret shorter than the minimum length is unusable', () => {
		const { usable } = runHarness('isUsableSecret', { secret: 'x'.repeat(15) });
		assert.equal(usable, false);
	});

	test('a secret at exactly the minimum length that is not a placeholder is usable', () => {
		const { usable } = runHarness('isUsableSecret', { secret: 'x'.repeat(16) });
		assert.equal(usable, true);
	});

	test('the shipped .env.example placeholder value is rejected', () => {
		const { usable } = runHarness('isUsableSecret', { secret: 'change-me-to-a-long-random-string' });
		assert.equal(usable, false);
	});

	test('known placeholder words are rejected written with either base64url word separator (- or _)', () => {
		const hyphenated = runHarness('isUsableSecret', { secret: 'change-me-please-set-a-real-secret' });
		const underscored = runHarness('isUsableSecret', { secret: 'change_me_please_set_a_real_secret' });
		const smashed = runHarness('isUsableSecret', { secret: 'changeme_please_set_a_real_secret_x' });
		assert.equal(hyphenated.usable, false, 'hyphen-separated placeholder must be rejected');
		assert.equal(underscored.usable, false, 'underscore-separated placeholder must be rejected');
		assert.equal(smashed.usable, false, 'unseparated placeholder must be rejected');
	});

	test('a placeholder word elsewhere in the secret, separated by a hyphen or underscore, is still rejected', () => {
		// These are not anchored at the very start of the string: the placeholder
		// word is preceded by a "-" or "_" separator further into the value, which
		// is exactly how a human would write a placeholder-ish secret (e.g.
		// "my-app-placeholder-secret"). The base64url alphabet includes "-" and
		// "_", so the placeholder guard must still recognize these as real word
		// boundaries rather than as noise inside a token, or realistic
		// placeholder secrets slip through unrejected.
		const cases = [
			'my-app-placeholder-secret-value-1234',
			'prod-change-me-secret-value-here-xyz',
			'staging_example_secret_value_padding',
			'api_test_placeholder_secret_key_value'
		];
		for (const secret of cases) {
			const { usable } = runHarness('isUsableSecret', { secret });
			assert.equal(usable, false, `expected "${secret}" to be rejected as a placeholder`);
		}
	});

	test('a genuine random base64url secret is not falsely rejected as a placeholder', () => {
		const crypto = require('node:crypto');
		for (let i = 0; i < 20; i++) {
			const secret = crypto.randomBytes(24).toString('base64url');
			const { usable } = runHarness('isUsableSecret', { secret });
			assert.equal(usable, true, `expected a genuine random secret "${secret}" to be usable`);
		}
	});

	test('the login action refuses to authenticate when SESSION_SECRET is unusable', () => {
		const action = readText('src/routes/login/+page.server.ts');
		assert.match(
			action,
			/import\s*\{[^}]*isUsableSecret[^}]*\}\s*from\s*['"]\$lib\/server\/auth['"]/,
			'expected the login action to import isUsableSecret from the auth module'
		);
		assert.match(
			action,
			/!appPassword\s*\|\|\s*!isUsableSecret\(secret\)/,
			'expected the login action to refuse to authenticate when the secret is missing/weak/placeholder'
		);
		assert.match(action, /fail\(\s*500\s*,/, 'expected a failure response when the server is misconfigured');
	});

	test('the auth guard only trusts a session when the secret is usable', () => {
		const hooks = readText('src/hooks.server.ts');
		assert.match(
			hooks,
			/import\s*\{[\s\S]{0,200}isUsableSecret[\s\S]{0,200}\}\s*from\s*['"]\$lib\/server\/auth['"]/,
			'expected hooks.server.ts to import isUsableSecret from the auth module'
		);
		assert.match(
			hooks,
			/isUsableSecret\(secret\)\s*\n?\s*\?\s*getSessionIssuedAt\(/,
			'expected the authenticated flag to only attempt session verification when the secret is usable'
		);
	});

	test('.env.example documents the minimum length and placeholder-rejection requirement', () => {
		const example = readText('.env.example');
		const secretLineIndex = example.indexOf('SESSION_SECRET=');
		assert.ok(secretLineIndex !== -1, 'expected .env.example to declare SESSION_SECRET');
		// The requirement is documented as a comment block above the assignment
		// line, so the checked section spans from the nearest preceding blank
		// line (the start of that comment paragraph) through the assignment.
		const sectionStart = example.lastIndexOf('\n\n', secretLineIndex);
		const secretSection = example.slice(sectionStart === -1 ? 0 : sectionStart, secretLineIndex + 100);
		assert.match(secretSection, /16/, 'expected the documented minimum length to be spelled out');
		assert.match(
			secretSection,
			/placeholder/i,
			'expected the documentation to warn that a known placeholder value is rejected'
		);
	});
});
