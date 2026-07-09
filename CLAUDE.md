## Engineering rules

- The `test` script must run on the declared minimum Node and on Windows: avoid shell globs in `node --test`; use a portable recursive test discovery mechanism.
- Test-file header comments must state the actual filename and the real invocation command; do not add assertions strictly implied by a preceding one.
- Tests must not depend on network `npm install` against the live repo; isolate/mock heavy install-build cycles and never let a build test pass when install is impossible.
- In test helpers, always check spawnSync result.error and handle socket 'timeout'/'error' events so failures report the real cause instead of hanging or masking it.
- Concurrent-safe tests: operate in an isolated temp working copy (never the shared repo root) and bind to an ephemeral port (0) rather than a hardcoded one.
- Only modify package.json/package-lock.json when the task is dependency- or scaffold-related, and keep unrelated changes out of large generated diffs so review stays meaningful.
- Language policy: English for everything in the product and toolchain — code, comments, identifiers, commit messages, config/system files, and the app's UI text (set HTML `lang="en"`). French is used only for the planning docs under `docs/` (e.g. `docs/ROADMAP.md`).
- In SvelteKit routes never mix a `default` and a named action in one `actions` object; make mutating actions return consistent status semantics (missing id -> 404, not silent ok) and preserve the originally requested URL through the auth guard.
- Server code must translate expected failure modes into handled results: catch SQLite unique-constraint violations into 4xx, treat documented best-effort cleanup (fs purge) as non-fatal, and register connection close on process shutdown.
- Every code path a change adds or fixes (error branches, validation rejections, 404/duplicate paths) must be exercised by a test in the same change; a passing higher-level test must not mask a lower-level failure it depends on.
- Test helpers must spawn npm/binaries Windows-safely (process.platform==='win32' ? 'npm.cmd' : 'npm', or invoke the bin via process.execPath) and use fs.symlinkSync(..., 'junction') for directory links so no admin/Developer-Mode is required.
- Validate the shape of externally supplied values at the server boundary (repo URL scheme, branch/path format, minimum secret strength) rather than accepting any non-empty string.
- Keep SvelteKit adapter and compiler options in a conventional svelte.config.js, not inline in vite.config.ts.
