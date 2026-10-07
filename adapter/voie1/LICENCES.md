# Correctifs locaux « voie 1 » — provenance et licences

Hermes Control 0.6.3 livre, avec son adaptateur, des **copies corrigées** de deux dépendances Paperclip. Ce sont des
correctifs **locaux** : ils ne sont ni proposés ni acceptés par le mainteneur à ce jour.

| Paquet | Base publiée (npm) | Licence de la base | Copie livrée |
|---|---|---|---|
| `@paperclipai/adapter-utils` | 2026.1001.0 (intégrité dans `origine/INTEGRITE-2026.1001.0`) | MIT, déclarée dans son `package.json` (le paquet publié ne contient pas de fichier LICENSE ; dépôt `github.com/paperclipai/paperclip`, `packages/adapter-utils`) | `paquets/paperclipai-adapter-utils-2026.1001.0-hc063.1.tgz` |
| `@paperclipai/hermes-paperclip-adapter` | 2026.1001.0 | MIT, fichier `LICENSE` du paquet (« Copyright (c) 2026 Nous Research »), conservé dans la copie | `paquets/paperclipai-hermes-paperclip-adapter-2026.1001.0-hc063.1.tgz` |

Les dépendances groupées d'`adapter-utils` (`acpx` et ses dépendances, sous leurs propres licences MIT / Apache-2.0)
sont reprises **sans modification** de l'archive publiée.

Correctifs (`patches/`), produits par `env-prototypes/voie1-amont/fabriquer.sh` (dépôt local du Gardien, commit 10c0d97) :

- `adapter-utils-2026.1001.0.patch` — `runChildProcess` : option `inheritEnv:false` (l'environnement passé est l'environnement
  final, sans fusion avec celui du serveur) ; option `signal` (annulation : SIGTERM au groupe, SIGKILL après `graceSec`,
  groupe vérifié vide, `result.cancellation`) ; marqueur `RUN_CHILD_PROCESS_FINAL_ENV_PATCH`.
- `hermes-paperclip-adapter-2026.1001.0.patch` — `execute` : environnement final par liste blanche (`dist/server/final-env.js`,
  copie de `env-prototypes/commun/env-final.mjs`) ; refus si la copie d'`adapter-utils` chargée n'est pas corrigée ;
  annulation par `signal` et acquittement seulement si le groupe a disparu ; marqueurs exportés par `./server`.

Les modifications ajoutées sont sous licence MIT (Hermes Control, Cyril M). `fabriquer.sh` reconstruit les archives depuis
les archives publiées et échoue explicitement si la base ne correspond plus (intégrité, empreintes, application exacte).
