j'aimerais créer une web app me permettant d'acquérir les connaissances de bases de données (KB) comme celle-ci: ../AI-Knowledge/ (un répertoire wiki rempli de fichiers MD avec frontmatter, etc).

* plusieurs KB seraient configurables, l'utilisateur choisit sur quelle(s) KB il veut porter son attention
* l'application lui propose la lecture d'une fiche tirée au hasard, l'utilisateur peut alors :
    * bookmarker cette fiche (différentes catégories de bookmarks possibles, créées par l'utilisateur)
    * réclamer + de fiches du même thème
    * réclamer - de fiches du même thème
* l'application sera légère, en sveltekit avec une base sqlite pour stocker les informations nécessaires
* les KB seront accessibles sur internet (probablement via des dépôts github)
* les KB pourront évoluer dans le temps, et l'application devra le prendre en compte et mettre à jour les contenus proposés à l'utilisateur
