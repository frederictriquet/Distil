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

## Tests

```sh
npm test
```
