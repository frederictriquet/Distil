# Distil

Personal web app to browse, organize and study Markdown knowledge bases synced from git repositories (see [docs/ROADMAP.md](docs/ROADMAP.md)).

SvelteKit skeleton (TypeScript, minimal template), generated with [`sv`](https://github.com/sveltejs/cli).

## Development

Node `^18.0.0 || ^20.0.0 || >=22.0.0` is required (see `.nvmrc`).

```sh
npm install
npm run dev

# or to open a browser tab directly
npm run dev -- --open
```

## Build

```sh
npm run build
```

Preview the production build with `npm run preview`.

## Production (standalone Node server)

The app uses [`@sveltejs/adapter-node`](https://svelte.dev/docs/kit/adapter-node). `npm run build` produces a standalone Node server in the `build/` directory (entry point `build/index.js`), started with:

```sh
npm run build
node build
```

The listening port is configured through the `PORT` environment variable (default `3000`):

```sh
PORT=8080 node build
```

## Docker

A standalone production image is built via a multi-stage `Dockerfile` (app build,
production dependencies, minimal runtime image including the `git` binary used to
sync KBs). Drizzle migrations are applied automatically on the first database
access; no offline migration step is required.

### Run with Docker Compose (recommended)

```sh
cp .env.example .env        # then fill in APP_PASSWORD and SESSION_SECRET
docker compose up --build -d
```

The app is then available at `http://localhost:3000` (port configurable via
`APP_PORT` in `.env`). Data (the SQLite database and the KB repo cache) is
persisted in the named volume `distil-data`, mounted at `/app/data`.

```sh
docker compose logs -f      # follow the logs
docker compose down         # stop (the data volume is kept)
```

### Manual build and run

```sh
docker build -t distil:latest .

docker run -d --name distil \
  -p 3000:3000 \
  -e APP_PASSWORD='...' \
  -e SESSION_SECRET='...' \        # >= 16 characters, not a placeholder
  -e ORIGIN='http://localhost:3000' \
  -v distil-data:/app/data \
  distil:latest
```

The database path is fixed to `/app/data/distil.db` in the image; keep the volume
mounted at `/app/data` to persist the database **and** the KB repo cache
(`/app/data/kb-cache`).

## Versioning and release

The app follows [semantic versioning](https://semver.org/) (SemVer). The
reference version is the `version` field of `package.json` (source of truth).
Each release is materialized by an **annotated git tag** `vX.Y.Z`.

Release procedure:

```sh
# 1. Bump the SemVer version in package.json, then commit.
# 2. Create the matching annotated tag vX.Y.Z (pushes nothing):
npm run version:tag
# 3. Push the tag when the release is ready:
git push origin vX.Y.Z
```

At build time, the running version is the `version` string from `package.json`
followed by the short commit SHA (e.g. `1.2.3+abcdef1`). It is injected via
`kit.version.name` in `svelte.config.js` (computed from `package.json` and
`git rev-parse --short HEAD`) and available at runtime through the `version`
export of `$app/environment` (re-exported by `$lib/version` and exposed by the
`/api/version` endpoint).

The build does not depend on git being available: outside a repository (Docker
image, where `.git` is excluded from the build context), pass the SHA — or the
full version string — via a build-arg / environment variable, otherwise the SHA
falls back to `unknown` without failing the build:

```sh
docker build --build-arg GIT_SHA="$(git rev-parse --short HEAD)" -t distil:latest .
```

`GIT_SHA` overrides only the SHA (the SemVer number stays the one from
`package.json`); `APP_VERSION` overrides the full version string.

## Published image (GHCR)

A GitHub Actions workflow ([`.github/workflows/publish-image.yml`](.github/workflows/publish-image.yml))
builds the production image and publishes it to the GitHub Container Registry
(GHCR) at `ghcr.io/<owner>/<repo>`. It authenticates with the built-in
`GITHUB_TOKEN` (no custom secret required) and runs:

- on pushes to the default branch (`master`), tagging `latest` and the commit
  SHA;
- on SemVer release tags `vX.Y.Z`, tagging `X.Y.Z`, `X.Y`, and the commit SHA.

The workflow passes the short commit SHA as the `GIT_SHA` build-arg so the
version baked into the image is correct even though `.git` is excluded from the
build context.

Pull and run a published image:

```sh
docker pull ghcr.io/<owner>/<repo>:latest      # or a specific tag, e.g. :1.2.3

docker run -d --name distil \
  -p 3000:3000 \
  -e APP_PASSWORD='...' \
  -e SESSION_SECRET='...' \
  -e ORIGIN='http://localhost:3000' \
  -v distil-data:/app/data \
  ghcr.io/<owner>/<repo>:latest
```

## Tests

```sh
npm test
```
