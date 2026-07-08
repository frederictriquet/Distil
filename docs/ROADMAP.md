# ROADMAP — Distil

Tâches à réaliser dans l'ordre. Cocher `[x]` une tâche une fois terminée et vérifiée.

## 1. Fondations du projet
- [x] Initialiser un projet SvelteKit (TypeScript, template minimal) à la racine du dépôt.
- [ ] Installer et configurer `adapter-node` pour un hébergement Node autonome.
- [ ] Ajouter les dépendances : `better-sqlite3`, `drizzle-orm`, `drizzle-kit`, `simple-git`, `gray-matter`, `marked`, coloration syntaxique du code, et un sanitizer HTML.
- [ ] Configurer `.gitignore` pour exclure le dossier de données locales (base SQLite, cache des dépôts KB) et le fichier d'environnement.
- [ ] Définir les variables d'environnement nécessaires (mot de passe de l'app, secret de session, chemin de la base) et documenter leur usage.

## 2. Base de données
- [ ] Définir le schéma : bases de connaissances, fiches, préférences par thème, catégories de bookmarks, bookmarks, historique de lecture.
- [ ] Configurer Drizzle (fichier de config, client de connexion à SQLite).
- [ ] Générer et appliquer la première migration ; vérifier la création du fichier de base.

## 3. Authentification
- [ ] Mettre en place la session mono-utilisateur (cookie signé) et la vérification du mot de passe.
- [ ] Créer la page de connexion.
- [ ] Ajouter la garde d'accès qui redirige toute page non autorisée vers la connexion.

## 4. Gestion des bases de connaissances (KB)
- [ ] Créer la page de gestion des KB (liste avec nom, dernière synchronisation, nombre de fiches actives).
- [ ] Permettre l'ajout d'une KB (nom, URL du dépôt git, branche, sous-dossier de contenu).
- [ ] Permettre l'activation/désactivation du « focus » d'une KB et sa suppression (avec purge du cache local).

## 5. Synchronisation et ingestion
- [ ] Implémenter le clonage initial puis la mise à jour (pull) d'un dépôt KB dans un cache local.
- [ ] Parcourir les fichiers Markdown du sous-dossier de contenu et lire leur frontmatter.
- [ ] Filtrer pour ne garder que les fiches réelles (exclure les fichiers d'index générés et les fichiers de racine du wiki).
- [ ] Déterminer le thème de chaque fiche (champ de frontmatter, sinon catégorie déduite du dossier).
- [ ] Réconcilier avec la base : ajouter les nouvelles fiches, mettre à jour celles modifiées, désactiver celles disparues sans supprimer les données utilisateur associées.
- [ ] Créer une préférence de thème par défaut pour chaque nouveau thème rencontré.
- [ ] Déclencher la synchronisation depuis la page KB et afficher un compte rendu (ajouts, mises à jour, désactivations).

## 6. Rendu du contenu
- [ ] Convertir le corps Markdown d'une fiche en HTML sécurisé (avec coloration du code).
- [ ] Réécrire les liens internes entre fiches pour qu'ils pointent vers la fiche correspondante dans l'application.

## 7. Tirage et vue d'étude
- [ ] Implémenter le tirage aléatoire pondéré des fiches (KB en focus, fiches actives, poids par thème, exclusion des fiches vues récemment).
- [ ] Enregistrer chaque lecture dans l'historique.
- [ ] Créer la vue d'étude affichant une fiche (titre, thème, niveau, source) et son contenu.
- [ ] Ajouter l'action « fiche suivante ».
- [ ] Ajouter les actions « plus de fiches de ce thème » et « moins de fiches de ce thème » qui ajustent le poids du thème.

## 8. Bookmarks
- [ ] Permettre la création, le renommage et la suppression de catégories de bookmarks.
- [ ] Permettre de bookmarker la fiche courante dans une catégorie depuis la vue d'étude.
- [ ] Créer la page listant les bookmarks groupés par catégorie, avec retrait d'un bookmark et navigation vers la fiche.

## 9. Consultation d'une fiche précise
- [ ] Créer la page affichant une fiche identifiée (cible des liens internes et de la navigation depuis les bookmarks).

## 10. Finitions
- [ ] Soigner la mise en forme et la navigation générale.
- [ ] Gérer les états vides (aucune KB, aucune KB en focus, aucun bookmark).
- [ ] Gérer proprement l'affichage d'une fiche devenue inactive après une synchronisation.

## 11. Vérification de bout en bout
- [ ] Ajouter une KB de test et lancer une synchronisation ; vérifier le nombre de fiches ingérées et l'exclusion des fichiers d'index.
- [ ] Vérifier que les actions plus/moins modifient le poids du thème et décalent la distribution des tirages.
- [ ] Vérifier le cycle complet des bookmarks (catégorie, ajout, liste, navigation) et les liens internes entre fiches.
- [ ] Vérifier l'évolution d'une KB : fiche modifiée mise à jour, fiche supprimée désactivée, bookmarks conservés dans les deux cas.
- [ ] Vérifier que la compilation de production réussit.
