# Serveur de synchronisation

Remplace le serveur d'origine de Roll Together (`rt-sync.azurewebsites.net`, introuvable depuis
novembre 2026). Même protocole socket.io : l'extension et Pazulu Reader n'ont besoin que de l'adresse.

- `GET /` : page de santé (« Roll With Your Friends sync : ok »).
- Connexion socket.io : query `room` (facultatif), `videoProgress`, `videoState`.
- Serveur → client : `join(roomId, état, position, nb)`, `update(id, état, position, nb)`.
- Client → serveur : `update(état, position)`.
- Salons en mémoire seulement, tant qu'au moins une personne est connectée.

## Déploiement Render (gratuit)

Le fichier `render.yaml` à la racine du dépôt décrit le service : Render → **New → Blueprint** →
ce dépôt. Offre gratuite : le serveur s'endort après 15 min sans activité et se réveille (~1 min)
à la connexion suivante.

Licence MIT, d'après roll_together_backend de SamuraiExx (voir ORIGINAL-LICENSE.txt).
