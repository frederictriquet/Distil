## Engineering rules

- The `test` script must run on the declared minimum Node and on Windows: avoid shell globs in `node --test`; use a portable recursive test discovery mechanism.
- Test-file header comments must state the actual filename and the real invocation command; do not add assertions strictly implied by a preceding one.
- Tests must not depend on network `npm install` against the live repo; isolate/mock heavy install-build cycles and never let a build test pass when install is impossible.
- In test helpers, always check spawnSync result.error and handle socket 'timeout'/'error' events so failures report the real cause instead of hanging or masking it.
- Concurrent-safe tests: operate in an isolated temp working copy (never the shared repo root) and bind to an ephemeral port (0) rather than a hardcoded one.
- Only modify package.json/package-lock.json when the task is dependency- or scaffold-related, and keep unrelated changes out of large generated diffs so review stays meaningful.
- Language policy: English for everything in the product and toolchain — code, comments, identifiers, commit messages, config/system files, and the app's UI text (set HTML `lang="en"`). French is used only for the planning docs under `docs/` (e.g. `docs/ROADMAP.md`).
