# ROADMAP — Distil

Tâches à réaliser dans l'ordre. Cocher `[x]` une tâche une fois terminée et vérifiée. Chaque tâche porte un numéro stable (`section.tâche`) pour pouvoir la référencer.

## 1. Fondations du projet
- [x] **1.1** Initialiser un projet SvelteKit (TypeScript, template minimal) à la racine du dépôt.
- [x] **1.2** Installer et configurer `adapter-node` pour un hébergement Node autonome.
- [x] **1.3** Ajouter les dépendances : `better-sqlite3`, `drizzle-orm`, `drizzle-kit`, `simple-git`, `gray-matter`, `marked`, coloration syntaxique du code, et un sanitizer HTML.
- [x] **1.4** Configurer `.gitignore` pour exclure le dossier de données locales (base SQLite, cache des dépôts KB) et le fichier d'environnement.
- [x] **1.5** Définir les variables d'environnement nécessaires (mot de passe de l'app, secret de session, chemin de la base) et documenter leur usage.

## 2. Base de données
- [x] **2.1** Définir le schéma : bases de connaissances, fiches, préférences par thème, catégories de bookmarks, bookmarks, historique de lecture.
- [x] **2.2** Configurer Drizzle (fichier de config, client de connexion à SQLite).
- [x] **2.3** Générer et appliquer la première migration ; vérifier la création du fichier de base.

## 3. Authentification
- [x] **3.1** Mettre en place la session mono-utilisateur (cookie signé) et la vérification du mot de passe.
- [x] **3.2** Créer la page de connexion.
- [x] **3.3** Ajouter la garde d'accès qui redirige toute page non autorisée vers la connexion.

## 4. Fondations de l'interface (thème & responsive, à poser tôt)
Ces bases transverses sont établies avant les pages pour que chacune en hérite, plutôt qu'une refonte CSS en fin de projet.
- [x] **4.1** Mettre en place l'ossature (layout/shell) de l'application et la navigation générale, en mobile-first.
- [x] **4.2** Définir un système de styles réutilisable (variables CSS / tokens : couleurs, espacements, typographie) partagé par toutes les pages ; rétro-appliquer à la page de connexion existante.
- [x] **4.3** Rendre le layout responsive dès le départ : parfaitement utilisable sur téléphone (cibles tactiles suffisantes, aucun défilement horizontal parasite) et exploitant au mieux l'espace écran (pas de marges inutiles sur smartphone).
- [x] **4.4** Mettre en place le mode sombre via ces tokens dès le départ (préférence système par défaut, bascule manuelle, mémorisation du choix), afin que chaque page construite ensuite en hérite.

## 5. Gestion des bases de connaissances (KB)
- [x] **5.1** Créer la page de gestion des KB (liste avec nom, dernière synchronisation, nombre de fiches actives).
- [x] **5.2** Permettre l'ajout d'une KB (nom, URL du dépôt git, branche, sous-dossier de contenu).
- [x] **5.3** Permettre l'activation/désactivation du « focus » d'une KB et sa suppression (avec purge du cache local).

## 6. Synchronisation et ingestion
- [x] **6.1** Implémenter le clonage initial puis la mise à jour (pull) d'un dépôt KB dans un cache local.
- [x] **6.2** Parcourir les fichiers Markdown du sous-dossier de contenu et lire leur frontmatter.
- [x] **6.3** Filtrer pour ne garder que les fiches réelles (exclure les fichiers d'index générés et les fichiers de racine du wiki).
- [x] **6.4** Déterminer le thème de chaque fiche (champ de frontmatter, sinon catégorie déduite du dossier).
- [x] **6.5** Réconcilier avec la base : ajouter les nouvelles fiches, mettre à jour celles modifiées, désactiver celles disparues sans supprimer les données utilisateur associées.
- [x] **6.6** Créer une préférence de thème par défaut pour chaque nouveau thème rencontré.
- [x] **6.7** Déclencher la synchronisation depuis la page KB et afficher un compte rendu (ajouts, mises à jour, désactivations).

## 7. Rendu du contenu
- [ ] **7.1** Convertir le corps Markdown d'une fiche en HTML sécurisé (avec coloration du code).
- [ ] **7.2** Réécrire les liens internes entre fiches pour qu'ils pointent vers la fiche correspondante dans l'application.

## 8. Tirage et vue d'étude
- [x] **8.1** Implémenter le tirage aléatoire pondéré des fiches (KB en focus, fiches actives, poids par thème, exclusion des fiches vues récemment).
- [x] **8.2** Enregistrer chaque lecture dans l'historique.
- [x] **8.3** Créer la vue d'étude affichant une fiche (titre, thème, niveau, source) et son contenu.
- [x] **8.4** Ajouter l'action « fiche suivante ».
- [x] **8.5** Ajouter les actions « plus de fiches de ce thème » et « moins de fiches de ce thème » qui ajustent le poids du thème.

## 9. Bookmarks
- [x] **9.1** Permettre la création, le renommage et la suppression de catégories de bookmarks.
- [x] **9.2** Permettre de bookmarker la fiche courante dans une catégorie depuis la vue d'étude.
- [x] **9.3** Créer la page listant les bookmarks groupés par catégorie, avec retrait d'un bookmark et navigation vers la fiche.

## 10. Consultation d'une fiche précise
- [ ] **10.1** Créer la page affichant une fiche identifiée (cible des liens internes et de la navigation depuis les bookmarks).

## 11. Recherche, liste et navigation dans les fiches
- [ ] **11.1** Créer la page listant les fiches (fiches actives des KB en focus) avec titre, thème et source.
- [ ] **11.2** Ajouter la recherche par mots-clés (titre, thème et contenu des fiches).
- [ ] **11.3** Ajouter le filtrage de la liste (par KB, thème et niveau).
- [ ] **11.4** Permettre d'ouvrir une fiche depuis la liste et de revenir à la liste en conservant la recherche et le filtrage en cours (état préservé), pour enchaîner la consultation de plusieurs fiches sans refaire la recherche.

## 12. Finitions
- [ ] **12.1** Soigner la mise en forme et la navigation générale (passe finale de polish).
- [ ] **12.2** Gérer les états vides (aucune KB, aucune KB en focus, aucun bookmark, aucune fiche pour la recherche/le filtrage courant).
- [ ] **12.3** Gérer proprement l'affichage d'une fiche devenue inactive après une synchronisation.
- [ ] **12.4** Vérifier et peaufiner le responsive sur l'ensemble des pages (contrôle, pas de refonte : les fondations sont posées en 4).
- [ ] **12.5** Vérifier et peaufiner le mode sombre sur l'ensemble des pages (contraste, lisibilité), sans refonte.

## 13. Conteneurisation et déploiement
- [ ] **13.1** Écrire un Dockerfile (build multi-étapes) produisant une image de production autonome à partir de l'adapter-node.
- [ ] **13.2** Ajouter un `.dockerignore` (exclure `node_modules`, le build, les données locales et le fichier d'environnement).
- [ ] **13.3** Gérer la configuration au runtime : variables d'environnement (mot de passe, secret de session, chemin de la base) et volume persistant pour la base SQLite et le cache des dépôts KB.
- [ ] **13.4** Fournir un `docker-compose` pour lancer l'app en une commande (ports, variables, volumes) et documenter le build/run dans le README.

## 14. Vérification de bout en bout
- [ ] **14.1** Ajouter une KB de test et lancer une synchronisation ; vérifier le nombre de fiches ingérées et l'exclusion des fichiers d'index.
- [ ] **14.2** Vérifier que les actions plus/moins modifient le poids du thème et décalent la distribution des tirages.
- [ ] **14.3** Vérifier le cycle complet des bookmarks (catégorie, ajout, liste, navigation) et les liens internes entre fiches.
- [ ] **14.4** Vérifier la recherche et le filtrage de la liste, et le retour à la liste sans perte de la recherche/du filtrage après consultation d'une fiche.
- [ ] **14.5** Vérifier l'évolution d'une KB : fiche modifiée mise à jour, fiche supprimée désactivée, bookmarks conservés dans les deux cas.
- [ ] **14.6** Vérifier que la compilation de production réussit.
- [ ] **14.7** Vérifier que l'image se construit et que l'app démarre et fonctionne en conteneur (données persistées via le volume).
