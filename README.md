# Roll With Your Friends

Extension Firefox pour regarder Crunchyroll à plusieurs, chacun chez soi, parfaitement synchronisés :
lecture, pause, skip d'opening et retours en arrière sont répercutés chez tout le monde.

Ce dépôt est un fork de [Roll Together](https://github.com/samuraiexx/roll_together), dont l'auteur a arrêté
la maintenance. Ce fork corrige la synchronisation sur le lecteur actuel de Crunchyroll.

## Installer (Firefox)

**[➡️ Roll With Your Friends sur addons.mozilla.org](https://addons.mozilla.org/firefox/addon/roll-with-your-friends/)**
→ **« Ajouter à Firefox »**. Les mises à jour se font ensuite automatiquement.

Si tu avais Roll Together (l'original ou une version de test de ce fork) : `about:addons` →
Roll Together → « … » → **Supprimer**, pour ne pas avoir deux extensions qui se gênent.

Conseillé : sur crunchyroll.com, cadenas à gauche de l'adresse → **Lecture automatique** →
**« Autoriser l'audio et la vidéo »**. Sinon, un bouton orange « clique ici pour rejoindre la
lecture » s'affiche à ton arrivée : un clic suffit.

Tout le monde dans le salon doit avoir l'extension, à jour.

## Utilisation

1. Ouvre un épisode sur Crunchyroll.
2. Clique sur l'icône de l'extension → **Create Room** → **Copy URL**.
3. Envoie le lien à tes potes : ils l'ouvrent dans Firefox, et vous êtes synchronisés.

## Ce qui a changé dans ce fork

### Ce qui était cassé dans l'original
- **Skip de l'opening = désynchro** : l'extension renvoyait au salon les changements qu'elle venait
  elle-même d'appliquer, d'où un ping-pong entre les potes.
- **Premier lancement** : il fallait marteler la barre d'espace, car la synchro était appliquée avant
  que le lecteur Crunchyroll ait fini de charger, et Firefox bloquait la lecture automatique.
- **Arrivée en cours de route ou coupure réseau** : le serveur remettait tout le monde en pause,
  à une ancienne position.
- **Lecteur figé** : le lecteur de Crunchyroll (Bitmovin) charge la vidéo lui-même. L'extension
  déplaçait directement la vidéo, sans passer par lui, et l'image se figeait.

### Ce que fait ce fork (version 3.3 et suivantes)
- **Pilote le lecteur Crunchyroll lui-même pour les sauts** : l'extension retrouve le lecteur dans la
  page (`viewModelContainer` → `_player`) et lui demande de sauter, ce qui le fait charger
  correctement. Le premier saut est vérifié. Si le lecteur est introuvable, elle passe par les
  boutons « ±10 secondes » de Crunchyroll.
- **Pas d'écho** : un changement n'est envoyé aux autres que s'il vient vraiment de toi (lecture,
  pause, skip, barre de progression). Ni un lecteur figé ou en retard, ni la petite pause que
  Crunchyroll fait avant chaque saut ne sont envoyés.
- **Petits écarts rattrapés en douceur** : jusqu'à 5 s d'écart, la vidéo accélère un peu (×1,5 max)
  si tu es en retard, ou fait une courte pause si tu es en avance. Aucun saut, donc aucun
  rechargement.
- **Arrivée dans le salon** : l'extension attend que le lecteur Crunchyroll ait fini de démarrer
  (il se place d'abord à ton point de reprise), puis te place à la position des autres. Si Firefox
  bloque la lecture, un bouton « clique ici pour rejoindre la lecture » apparaît.
- **Arrivées tardives et reconnexions** : la remise en pause du serveur est ignorée, et le vrai état
  est renvoyé, pour que personne ne soit remis en pause ou ramené en arrière. Une coupure réseau
  te replace dans le même salon.
- **Messages croisés** (deux personnes qui agissent en même temps) : l'état du salon est reconfirmé
  pour que tout le monde finisse au même endroit.
- **Robustesse** : un F5 te resynchronise tout seul, se déconnecter arrête la synchro sur la page,
  et la page d'arrière-plan Firefox est persistante.

### Tests
- `test/sync.sim.ts` : simulation de plusieurs potes, avec des connexions et des temps de chargement
  différents, et un lecteur qui se comporte comme celui de Crunchyroll (pause avant les sauts, image
  figée si on déplace la vidéo directement, lecture automatique bloquée). Des milliers de séances
  aléatoires finissent toutes synchronisées.
- `test/driver.test.ts` : vérifie que le lecteur est retrouvé dans des structures comme celle de
  Crunchyroll.
- `npm run test:sync` lance les deux.

Le code de synchronisation est dans `src/sync.ts`, le pilotage du lecteur Crunchyroll dans
`src/crunchyroll_driver.ts`.

## Développement

### Prérequis
- Node.js et npm
- Git

### Compiler
```bash
npm install
npm run build:production:firefox   # extension dans build-firefox/
npm run build:production:chrome    # extension dans build/
npm run package                    # crée rolltogether-firefox.zip et rolltogether-chrome.zip
```

En développement (`npm run build:firefox` ou `npm run watch:firefox`), l'extension écrit dans la
console de la page tout ce qu'elle fait (`[sync]`, `[driver]`), ce qui aide à diagnostiquer un problème.

### Charger depuis les sources
- **Firefox** : `about:debugging` → « Ce Firefox » → « Charger un module complémentaire temporaire »
  → choisir un fichier du dossier `build-firefox`.
- **Chrome** : `chrome://extensions` → Mode développeur → « Charger l'extension non empaquetée »
  → dossier `build`. Les corrections de ce fork n'ont été testées que sur Firefox.

## Confidentialité
Voir [PRIVACY.md](PRIVACY.md) : seuls l'identifiant du salon, l'état lecture/pause et la position
de lecture sont envoyés au serveur de synchronisation. Pas de compte, pas de pub, pas de statistiques.

## Serveur de synchronisation
L'extension utilise toujours le serveur de l'auteur d'origine (`rt-sync.azurewebsites.net`,
code : https://github.com/samuraiexx/roll_together_backend). S'il venait à s'arrêter, il faudrait
héberger ce serveur et changer `SYNC_SERVER` dans `env.json`.

## Remerciements
Merci à l'auteur d'origine de Roll Together et à tous ses contributeurs.
