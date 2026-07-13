# Distil

Application web personnelle pour consulter, organiser et étudier des bases de connaissances Markdown synchronisées depuis des dépôts git (voir [docs/ROADMAP.md](docs/ROADMAP.md)).

Squelette SvelteKit (TypeScript, template minimal), généré avec [`sv`](https://github.com/sveltejs/cli).

## Développement

Node `^18.0.0 || ^20.0.0 || >=22.0.0` est requis (voir `.nvmrc`).

```sh
npm install
npm run dev

# ou pour ouvrir directement un onglet du navigateur
npm run dev -- --open
```

## Build

```sh
npm run build
```

L'aperçu de la version de production se fait avec `npm run preview`.

## Production (serveur Node autonome)

L'application utilise [`@sveltejs/adapter-node`](https://svelte.dev/docs/kit/adapter-node). `npm run build` génère un serveur Node autonome dans le dossier `build/` (point d'entrée `build/index.js`), que l'on lance ainsi :

```sh
npm run build
node build
```

Le port d'écoute se configure via la variable d'environnement `PORT` (par défaut `3000`) :

```sh
PORT=8080 node build
```

## Docker

Une image de production autonome est construite via un `Dockerfile` multi-étapes
(build de l'app, dépendances de production, image d'exécution minimale incluant
le binaire `git` utilisé pour synchroniser les KB). Les migrations Drizzle sont
appliquées automatiquement au premier accès à la base ; aucune étape de
migration hors-ligne n'est nécessaire.

### Lancer avec Docker Compose (recommandé)

```sh
cp .env.example .env        # puis renseigner APP_PASSWORD et SESSION_SECRET
docker compose up --build -d
```

L'app est ensuite disponible sur `http://localhost:3000` (port configurable via
`APP_PORT` dans `.env`). Les données (base SQLite et cache des dépôts KB) sont
persistées dans le volume nommé `distil-data`, monté sur `/app/data`.

```sh
docker compose logs -f      # suivre les logs
docker compose down         # arrêter (le volume de données est conservé)
```

### Build et run manuels

```sh
docker build -t distil:latest .

docker run -d --name distil \
  -p 3000:3000 \
  -e APP_PASSWORD='...' \
  -e SESSION_SECRET='...' \        # >= 16 caractères, pas un placeholder
  -e ORIGIN='http://localhost:3000' \
  -v distil-data:/app/data \
  distil:latest
```

Le chemin de la base est fixé à `/app/data/distil.db` dans l'image ; conserver
le montage du volume sur `/app/data` pour persister la base **et** le cache des
dépôts KB (`/app/data/kb-cache`).

## Versionnage et release

L'application suit le [versionnage sémantique](https://semver.org/lang/fr/)
(SemVer). La version de référence est le champ `version` de `package.json`
(source de vérité). Chaque release est matérialisée par un **tag git annoté**
`vX.Y.Z`.

Procédure de release :

```sh
# 1. Bumper la version SemVer dans package.json, puis committer.
# 2. Créer le tag annoté vX.Y.Z correspondant (ne pousse rien) :
npm run version:tag
# 3. Pousser le tag quand la release est prête :
git push origin vX.Y.Z
```

Au build, la version exécutée est la chaîne `version` de `package.json` suivie
du SHA court du commit (ex. `1.2.3+abcdef1`). Elle est injectée via
`kit.version.name` dans `svelte.config.js` (calculée à partir de `package.json`
et de `git rev-parse --short HEAD`) et disponible à l'exécution via `version` de
`$app/environment` (réexporté par `$lib/version` et exposé par l'endpoint
`/api/version`).

Le build ne dépend pas de la présence de git : hors dépôt (image Docker, où
`.git` est exclu du contexte de build), passer le SHA — ou la version complète —
via un build-arg / une variable d'environnement, sinon le SHA vaut `unknown`
sans faire échouer le build :

```sh
docker build --build-arg GIT_SHA="$(git rev-parse --short HEAD)" -t distil:latest .
```

`GIT_SHA` ne surcharge que le SHA (la version SemVer reste celle de
`package.json`) ; `APP_VERSION` surcharge la chaîne de version complète.

## Published image (GHCR)

> This section is intentionally written in English (the rest of this README is
> still French — a known, separate debt).

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
