# DETTE TECHNIQUE — Distil

Dettes identifiées par l'orchestrateur (`.orchestrator/backlog.md`, généré le 2026-07-09), classées par priorité. Cocher `[x]` une dette une fois traitée. La clé entre backticks (`sveltekit-action-contract`, …) permet de la référencer et de la curer (`/orchestrator:backlog resolve <clé>`).

## 🔴 Priorité haute

- [ ] **`sveltekit-action-contract`** — Contrats de routes/actions SvelteKit (fréq. 8, en cours)
  - Le 500 bloquant (mélange action `default` + action nommée) est corrigé.
  - Reste : la suppression renvoie un succès même sur un id inexistant (devrait être un 404).
  - Reste : la garde d'accès perd l'URL demandée (pas de retour vers la page initiale après connexion).
  - Reste : le logout est une interception artisanale dans `hooks.server.ts` au lieu d'une route dédiée.

- [ ] **`auth-session-security`** — Failles de session/authentification (fréq. 6, en cours)
  - Une vérification d'expiration côté serveur (`iat` signé) a été ajoutée.
  - Fait : révocation serveur au logout (époque de révocation en mémoire, appliquée par la garde d'accès dans `hooks.server.ts`).
  - Fait : limitation de débit / anti-force brute sur la connexion (compteur d'échecs par IP avec fenêtre de verrouillage, `429` quand la limite est atteinte).
  - Fait : `SESSION_SECRET` imposé à la frontière serveur (longueur minimale, rejet des placeholders y compris jeux base64url) et documenté dans `.env.example`.
  - Risque résiduel : l'époque de révocation et les verrous anti-force brute vivent uniquement en mémoire du process ; un redémarrage/déploiement les réinitialise, si bien qu'un jeton déconnecté redevient valide jusqu'à l'expiration des 30 jours. Persistance (ou baisse de `SESSION_MAX_AGE`) à envisager si le mono-process ne suffit plus.
  - Risque résiduel : derrière un reverse proxy, `getClientAddress()` retombe sur l'IP du proxy sauf si `ADDRESS_HEADER` est configuré (documenté dans `.env.example`), sinon la limitation devient globale.

- [ ] **`runtime-error-handling`** — Erreurs runtime non gérées côté serveur (fréq. 5, en cours)
  - Le 500 sur KB dupliquée (SqliteError) est corrigé.
  - Reste : la purge « best-effort » du cache lève encore sur EBUSY/EPERM.
  - Reste : `closeDb` n'est jamais enregistré à l'arrêt du process (WAL jamais checkpointé).

## 🟠 Priorité moyenne

- [ ] **`new-code-test-coverage`** — Comportement livré sans tests couvrants (fréq. 15)
  - Récurrent : chaque nouveau chemin ajouté par un correctif (mapping KB dupliquée, validation `repoUrl`, expiration de session, 404 de suppression, échec de purge, restauration de thème, câblage d'actions) est livré non testé.
  - Un test de build a même masqué un échec d'installation.
  - Attendu : un test qui échoue-puis-passe pour chaque branche introduite par un correctif.

- [ ] **`db-schema-config-integrity`** — Intégrité schéma/config BDD (fréq. 8)
  - `updated_at` n'a pas de `$onUpdate` (valeur périmée).
  - `drizzle.config` crée des dossiers à l'import et résout `schema`/`out` relativement au cwd (zéro migration silencieuse).
  - `DATABASE_PATH` n'est pas câblé via l'environnement SvelteKit.
  - `toggleFocus` est un read-modify-write non transactionnel.

- [ ] **`untrusted-input-validation`** — Entrées non fiables non validées (fréq. 5)
  - `repoUrl` / `branch` / `contentSubdir` acceptent des chaînes arbitraires.
  - Force du `SESSION_SECRET` non vérifiée.
  - La regex du garde-fou « secret placeholder » manque les jeux de caractères base64url.
  - Attendu : valider la forme/le schéma des champs fournis de l'extérieur à la frontière serveur.

## 🟡 Priorité basse

- [ ] **`ui-foundations-polish`** — Finitions des fondations d'interface (fréq. 6)
  - `color-scheme` manquant.
  - Duplication des tokens de thème sombre.
  - Mauvaise icône du bascule (toggle) en rendu SSR.
  - Le bascule n'expose aucun état ARIA.
  - Sélecteur CSS mort (`.link`).
  - `formatLastSynced` protège contre un `undefined` impossible.

---

## Sous surveillance (règles appliquées, régressions possibles)

Une règle CLAUDE.md a été appliquée pour ces points ; une nouvelle occurrence peut signaler que la règle ne fonctionne pas (mesurer avec `rule_efficacy.py`).

- `test-code-quality-comments` — commentaires d'en-tête de test et code mort (fréq. 15)
- `test-isolation-concurrency` — isolation/concurrence des tests (ports, racine de dépôt partagée, cache de fixtures) (fréq. 12)
- `large-diffs-protected-paths` — gros diffs et churn de chemins protégés (`package.json`/lock) (fréq. 10)
- `non-hermetic-tests` — cycles install-build lourds non hermétiques/dupliqués (fréq. 8)
- `swallowed-errors-tests` — erreurs de spawn/probe avalées dans les helpers de test (fréq. 8)
- `test-runner-invocation` — portabilité de l'invocation de découverte `npm test` (fréq. 5)

## Résolues / abandonnées

- `node-engine-mismatch` — incompatibilité moteur Node / ABI natif (résolue)
- `sveltekit-config-idiom` — config SvelteKit idiomatique dans `svelte.config.js` (promue)
- `french-locale-consistency` — politique de langue, anglais partout sauf `docs/` (wontfix)
