# Hermes Control — conception (v0.3, 3 octobre 2026)

## Principe (fixé par Cyril)
**Paperclip est le maître.** Pour chaque agent, Paperclip fournit cinq données : nom, working directory, provider, modèle, thinking. Rien d'autre ne sort de Paperclip ; rien d'autre n'y entre, sauf les **listes** (providers et modèles connus de Hermes) pour remplir les menus existants de l'agent. Pas de page de choix, pas de page de réglages.

## Deux pièces, un projet
| Pièce | Ce qu'elle fait | Comment |
|---|---|---|
| **Adaptateur** `adapter/` (`paperclip-adapter-hermes-control`) | Remplace l'adaptateur intégré `hermes_local` (fonction officielle « override built-in », pause / retour arrière possibles). Menus Provider / Model = listes de Hermes ; `detectModel` = défaut de Hermes ; au passage, **le nom de l'agent choisit son profil Hermes** et fixe `HERMES_HOME` ; « Test environment » montre les instances trouvées. | Enveloppe `createHermesLocalServerAdapter()` de `@paperclipai/hermes-paperclip-adapter` ; `getConfigSchema()` réécrit les options du champ `provider` ; `listModels()` lit `provider_models_cache.json` ; `execute()` ajoute `env.HERMES_HOME`. |
| **Plugin** (`paperclip-plugin-hermes-control`) | Synchro Paperclip → Hermes : provider / modèle / thinking de l'agent écrits dans `config.yaml` du profil trouvé par le nom (`model.provider`, `model.default`, `reasoning_effort`), seulement si différent. Une vue « instances » (lien « Hermes » dans la barre latérale). | Worker : donnée `instances` ; événements `agent.updated` / `agent.created` ; job `sync` toutes les 5 min (sans périmètre entreprise → repart de l'instantané en état du plugin). `hermes config set` via `execFile`, jamais de shell. |

## Nom → profil (`src/match.ts`)
`slug(nom)` (minuscules, sans accents, `-`) ; profil du même nom d'abord (`profiles/apolline-m`), sinon profil dont la description commence par ce mot (« Chef — PDG » → `default` de direction). Pas de correspondance → passage refusé avec la liste des profils connus ; ligne rouge dans la vue.

## Où sont les instances (`src/discovery.ts`)
`~/.hermes` + dossiers listés dans `~/.config/hermes-control/roots` (une ligne = une instance ou un dossier d'instances) + `HERMES_CONTROL_ROOTS`. Le plugin ajoute les instances derrière les lanceurs existants des agents (`<lanceur> config path`).

## Sécurité
Aucune clé lue ni affichée ; commandes sans shell, arguments validés (`[a-z0-9._-]` pour les noms, regex pour modèle / provider / effort) ; `state.db` en lecture seule ; aucun réseau sortant ; les seules écritures sont `hermes config set` sur le profil de l'agent concerné. `scan-skill.sh` : seulement des faux positifs (regex `.exec`, lecture de `process.env`).

## Leçons Paperclip 2026.1001
- Manifeste : `jobKey` ; worker : finir par `runWorker(plugin, import.meta.url)` ; yaml (CJS) → bannière `createRequire`.
- Les jobs planifiés tournent sans périmètre entreprise (`config.get`, `agents.list` refusés) ; les événements et les données UI en ont un.
- Le worker est lancé sans `HOME` → `os.homedir()`.
- Aucun emplacement de plugin n'est rendu sur la page / le formulaire d'un agent ; ces menus appartiennent à l'adaptateur → d'où l'adaptateur.
- Adaptateur externe : `adapter install --payload-json '{"packageName":"<chemin>","isLocalPath":true}'`, export `createServerAdapter()`, même `type` que l'intégré pour le remplacer.

## Publication (quand Cyril crée les comptes)
npm : `paperclip-plugin-hermes-control` + `paperclip-adapter-hermes-control` (auteur Cyril M, MIT) ; dépôt GitHub ; soumission Paperclip Hub (cliphub.fyi) + PR `awesome-paperclip`.
