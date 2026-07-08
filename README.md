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

> Pour déployer l'application, un [adapter](https://svelte.dev/docs/kit/adapters) adapté à la cible sera nécessaire (voir la section « Fondations du projet » de la roadmap).

## Tests

```sh
npm test
```
