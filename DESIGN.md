# Hermes Control — conception (v0.5, 4 octobre 2026)

## Principe (fixé par Cyril)
**Paperclip est le maître.** Pour chaque agent, Paperclip fournit cinq données : nom, working directory, provider, modèle, thinking. Rien d'autre ne sort de Paperclip ; rien d'autre n'y entre, sauf les **listes** (providers et modèles connus de Hermes) pour remplir les menus existants de l'agent. Pas de page de choix, pas de page de réglages.

## Deux pièces, un projet
| Pièce | Ce qu'elle fait | Comment |
|---|---|---|
| **Adaptateur** `adapter/` (`paperclip-adapter-hermes-control`) | Remplace l'adaptateur intégré `hermes_local` (fonction officielle « override built-in », pause / retour arrière possibles). Menus Provider / Model = listes de Hermes ; `detectModel` = défaut de Hermes ; au passage, **le nom de l'agent choisit son profil Hermes** et fixe `HERMES_HOME` ; « Test environment » montre les instances trouvées. | Enveloppe `createHermesLocalServerAdapter()` de `@paperclipai/hermes-paperclip-adapter` ; `getConfigSchema()` réécrit les options du champ `provider` ; `listModels()` lit `provider_models_cache.json` ; `execute()` ajoute `env.HERMES_HOME`. |
| **Plugin** (`paperclip-plugin-hermes-control`) | Synchro Paperclip → Hermes : provider / modèle / thinking de l'agent écrits dans `config.yaml` du profil trouvé par le nom (`model.provider`, `model.default`, `reasoning_effort`), seulement si différent. Une vue « instances » (lien « Hermes » dans la barre latérale). | Worker : donnée `instances` ; événements `agent.updated` / `agent.created` ; job `sync` toutes les 5 min (sans périmètre entreprise → repart de l'instantané en état du plugin). `hermes config set` via `execFile`, jamais de shell. |

## Skills Paperclip → profil Hermes (`adapter/src/skills.ts`, v0.4)
Constat du 2026-10-04 (CDjam, Chef) : l'adaptateur Hermes officiel pose les liens des skills gérés par Paperclip dans `$HOME/.hermes/skills` (sa fonction `resolveHermesHome` lit `config.env.HOME`, jamais `HERMES_HOME`), alors que Hermes ne lit que `$HERMES_HOME/skills`. Avec un profil par agent, les skills cochés dans Paperclip étaient invisibles. Hermes Control :
- à chaque passage (`execute`, quand Paperclip envoie l'inventaire `paperclipRuntimeSkills`) et à chaque synchro (`syncSkills`, onglet Skills) : `reconcileIntoProfile()` pose un lien `<profil>/skills/<nom>` → source Paperclip pour chaque skill désiré (`paperclip` toujours inclus, comme l'officiel), avec les mêmes outils que l'officiel (`@paperclipai/adapter-utils/server-utils` : `readPaperclipRuntimeSkillEntries`, `resolveLegacyPaperclipDesiredSkillNames`, `ensurePaperclipSkillSymlink`, `readInstalledSkillTargets`) ; un lien existant qui **résout** vers la même source est accepté (cas des liens manuels via `~/.hermes/skills`) ; un lien vivant vers autre chose n'est jamais écrasé (avertissement) ; un lien mort est remplacé ;
- décoché → le lien est retiré **seulement** s'il pointe vers une source Paperclip (les skills maison du profil, `comfyui`, `rapport`…, ne sont jamais touchés) ;
- `listSkills` montre le vrai chemin du lien dans le profil (`targetPath`) et remplace les skills « ~/.hermes/skills » (non lus par le profil) par ceux du profil, en lecture seule ;
- les hooks `listSkills` / `syncSkills` ne reçoivent que `agentId` → carte partagée `~/.config/hermes-control/agents.json` (`src/agents-map.ts`), écrite par `execute` et par le worker du plugin à chaque synchro ; profil inconnu → avertissement, les liens seront posés au prochain passage.
Rien ne passe par un shell ; aucune commande `hermes` : uniquement des liens symboliques dans le dossier `skills` du profil.

## Un agent créé dans Paperclip = un profil Hermes prêt (`src/prepare.ts`, `src/workspace.ts`, v0.5)
Dossier de travail commun déclaré dans `~/.config/hermes-control/workspace` (posé par `hermes-paperclip-pack init`) : `<ws>/hermes/profils/<entreprise>` (instance), `<ws>/hermes/skills` (skills communs), `<ws>/modeles` (gabarits `{{nom}} {{slug}} {{titre}} {{entreprise}} {{ws}} {{skills}}`), `<ws>/agents/<agent>`. `syncAll` : agent `hermes_local` sans profil → `prepareAgent()` (instance = celle qui porte le slug de l'entreprise, sinon la première du dossier) : `profileCreate(…, {clone:true})`, dossiers, `memories` lié **avant** d'écrire les gabarits (les fichiers créés par Hermes sont déplacés, jamais perdus), `journal` → `logs/`, skills communs liés (lien mort du clone remplacé ; lien vivant vers la même cible accepté ; lien vivant ailleurs laissé + avertissement), SOUL rendu. Seulement avec périmètre entreprise (événements, vue) ; le job 5 min ne crée rien. Actions (`ui.action.register`) : `prepare-agent` (utilisateur board) et `set-telegram` (chemin ∈ profils connus, jeton validé par regex, `.env` 600, `hermes gateway install --start-now`, rien dans l'état ni les logs). Adaptateur : `cwd` par défaut = `<ws>/agents/<slug>` s'il existe.

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
- Adaptateur externe : `adapter install --payload-json '{"packageName":"<chemin>","isLocalPath":true}'`, export `createServerAdapter()`, même `type` que l'intégré pour le remplacer. Mise à jour d'un adaptateur local : rebuild puis `POST /api/adapters/<type>/reload` (clé board) ; plugin local : `POST /api/plugins/<id>/upgrade`.
- Hooks de skills : `syncSkills(ctx, desired)` / `listSkills(ctx)` ne reçoivent que `agentId`, `companyId`, `config` (pas le nom) ; `config` contient l'inventaire `paperclipRuntimeSkills` et le choix `paperclipSkillSync`.

## Publication (quand Cyril crée les comptes)
npm : `paperclip-plugin-hermes-control` + `paperclip-adapter-hermes-control` (auteur Cyril M, MIT) ; dépôt GitHub ; soumission Paperclip Hub (cliphub.fyi) + PR `awesome-paperclip`.
