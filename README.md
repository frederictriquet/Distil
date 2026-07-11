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

## Tests

```sh
npm test
```
