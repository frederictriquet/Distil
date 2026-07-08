# ROADMAP — Distil

Tâches à réaliser dans l'ordre. Cocher `[x]` une tâche une fois terminée et vérifiée. Chaque tâche porte un numéro stable (`section.tâche`) pour pouvoir la référencer.

## 1. Fondations du projet
- [x] **1.1** Initialiser un projet SvelteKit (TypeScript, template minimal) à la racine du dépôt.
- [x] **1.2** Installer et configurer `adapter-node` pour un hébergement Node autonome.
- [ ] **1.3** Ajouter les dépendances : `better-sqlite3`, `drizzle-orm`, `drizzle-kit`, `simple-git`, `gray-matter`, `marked`, coloration syntaxique du code, et un sanitizer HTML.
- [ ] **1.4** Configurer `.gitignore` pour exclure le dossier de données locales (base SQLite, cache des dépôts KB) et le fichier d'environnement.
- [ ] **1.5** Définir les variables d'environnement nécessaires (mot de passe de l'app, secret de session, chemin de la base) et documenter leur usage.

## 2. Base de données
- [ ] **2.1** Définir le schéma : bases de connaissances, fiches, préférences par thème, catégories de bookmarks, bookmarks, historique de lecture.
- [ ] **2.2** Configurer Drizzle (fichier de config, client de connexion à SQLite).
- [ ] **2.3** Générer et appliquer la première migration ; vérifier la création du fichier de base.

## 3. Authentification
- [ ] **3.1** Mettre en place la session mono-utilisateur (cookie signé) et la vérification du mot de passe.
- [ ] **3.2** Créer la page de connexion.
- [ ] **3.3** Ajouter la garde d'accès qui redirige toute page non autorisée vers la connexion.

## 4. Gestion des bases de connaissances (KB)
- [ ] **4.1** Créer la page de gestion des KB (liste avec nom, dernière synchronisation, nombre de fiches actives).
- [ ] **4.2** Permettre l'ajout d'une KB (nom, URL du dépôt git, branche, sous-dossier de contenu).
- [ ] **4.3** Permettre l'activation/désactivation du « focus » d'une KB et sa suppression (avec purge du cache local).

## 5. Synchronisation et ingestion
- [ ] **5.1** Implémenter le clonage initial puis la mise à jour (pull) d'un dépôt KB dans un cache local.
- [ ] **5.2** Parcourir les fichiers Markdown du sous-dossier de contenu et lire leur frontmatter.
- [ ] **5.3** Filtrer pour ne garder que les fiches réelles (exclure les fichiers d'index générés et les fichiers de racine du wiki).
- [ ] **5.4** Déterminer le thème de chaque fiche (champ de frontmatter, sinon catégorie déduite du dossier).
- [ ] **5.5** Réconcilier avec la base : ajouter les nouvelles fiches, mettre à jour celles modifiées, désactiver celles disparues sans supprimer les données utilisateur associées.
- [ ] **5.6** Créer une préférence de thème par défaut pour chaque nouveau thème rencontré.
- [ ] **5.7** Déclencher la synchronisation depuis la page KB et afficher un compte rendu (ajouts, mises à jour, désactivations).

## 6. Rendu du contenu
- [ ] **6.1** Convertir le corps Markdown d'une fiche en HTML sécurisé (avec coloration du code).
- [ ] **6.2** Réécrire les liens internes entre fiches pour qu'ils pointent vers la fiche correspondante dans l'application.

## 7. Tirage et vue d'étude
- [ ] **7.1** Implémenter le tirage aléatoire pondéré des fiches (KB en focus, fiches actives, poids par thème, exclusion des fiches vues récemment).
- [ ] **7.2** Enregistrer chaque lecture dans l'historique.
- [ ] **7.3** Créer la vue d'étude affichant une fiche (titre, thème, niveau, source) et son contenu.
- [ ] **7.4** Ajouter l'action « fiche suivante ».
- [ ] **7.5** Ajouter les actions « plus de fiches de ce thème » et « moins de fiches de ce thème » qui ajustent le poids du thème.

## 8. Bookmarks
- [ ] **8.1** Permettre la création, le renommage et la suppression de catégories de bookmarks.
- [ ] **8.2** Permettre de bookmarker la fiche courante dans une catégorie depuis la vue d'étude.
- [ ] **8.3** Créer la page listant les bookmarks groupés par catégorie, avec retrait d'un bookmark et navigation vers la fiche.

## 9. Consultation d'une fiche précise
- [ ] **9.1** Créer la page affichant une fiche identifiée (cible des liens internes et de la navigation depuis les bookmarks).

## 10. Finitions
- [ ] **10.1** Soigner la mise en forme et la navigation générale.
- [ ] **10.2** Gérer les états vides (aucune KB, aucune KB en focus, aucun bookmark).
- [ ] **10.3** Gérer proprement l'affichage d'une fiche devenue inactive après une synchronisation.

## 11. Vérification de bout en bout
- [ ] **11.1** Ajouter une KB de test et lancer une synchronisation ; vérifier le nombre de fiches ingérées et l'exclusion des fichiers d'index.
- [ ] **11.2** Vérifier que les actions plus/moins modifient le poids du thème et décalent la distribution des tirages.
- [ ] **11.3** Vérifier le cycle complet des bookmarks (catégorie, ajout, liste, navigation) et les liens internes entre fiches.
- [ ] **11.4** Vérifier l'évolution d'une KB : fiche modifiée mise à jour, fiche supprimée désactivée, bookmarks conservés dans les deux cas.
- [ ] **11.5** Vérifier que la compilation de production réussit.
