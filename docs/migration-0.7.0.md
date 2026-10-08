# Migration vers Hermes Control 0.7.0 — nouveaux noms npm

À partir de 0.7.0, les deux paquets changent de nom :

| Rôle | Jusqu'à 0.6.x (0.5.0 seule publiée) | Depuis 0.7.0 |
|---|---|---|
| Plugin | `paperclip-plugin-hermes-control` | `@cyberservices-ai/paperclip-plugin-hermes-control` |
| Adaptateur | `paperclip-adapter-hermes-control` | `@cyberservices-ai/paperclip-adapter-hermes-control` |

**Ce qui ne change pas** (et c'est voulu, parce que c'est ce que Paperclip utilise pour retrouver ses enregistrements) :

- l'**id du manifeste du plugin** reste `hermes-control` ;
- le **type de l'adaptateur** reste `hermes_local` ;
- le dossier de référence de Hermes Control (`<compte>/.config/hermes-control` : `assignments.json`, `agents.json`, `roots`,
  suivi de fraîcheur du lot B) et les instances Hermes (profils, `config.yaml`, `.env`, mémoires, skills) ne sont pas touchés
  par l'installation des paquets ;
- la commande `hermes-control-suivi` garde son nom.

Ce document décrit ce que Paperclip 2026.1001.0 garde, ce qu'il faut réinstaller et comment revenir en arrière. Il a été
écrit **en lisant le code installé** de `@paperclipai/server` 2026.1001.0 (références ci-dessous). **La procédure n'a pas
encore été jouée sur une instance Paperclip** (ni de recette, ni de production) : c'est à faire en recette avant tout usage.

## 1. Comment Paperclip 2026.1001.0 reconnaît un plugin et un adaptateur

### Plugin : la clé est l'id du manifeste, pas le nom npm

- Table `plugins` : une ligne par plugin, avec un identifiant interne (UUID), la **clé `pluginKey` = `manifest.id`**, et à
  côté `packageName`, `version`, `manifestJson`, `status` (`services/plugin-registry.js`, `install`).
- La configuration par entreprise (`plugin_config`), l'état du plugin (`plugin_state`), les jobs et leurs exécutions sont
  rattachés à l'**UUID de cette ligne**, pas au nom npm.
- `paperclipai plugin uninstall hermes-control` **sans `--force`** = suppression douce : la ligne passe à
  `status = "uninstalled"`, configuration, état et jobs sont **conservés** ; seuls le processus du plugin et les fichiers du
  paquet dans `~/.paperclip/plugins` (nom npm enregistré) sont retirés (`services/plugin-lifecycle.js`, `unload` ;
  `plugin-loader.js`, `cleanupInstallArtifacts` ; `plugin-job-coordinator.js` ne supprime les jobs qu'en cas de purge).
- **Avec `--force`** (purge) : la ligne est supprimée, la configuration part en cascade, les jobs sont effacés. **À ne jamais
  utiliser pour cette migration.**
- Réinstallation : si une ligne avec le même `manifest.id` existe en `uninstalled`, Paperclip **réactive cette même ligne**
  (même UUID) et met à jour `packageName`, `version` et le manifeste (commentaire du code : « so plugin-scoped data and
  references remain stable across uninstall/reinstall cycles »). Le changement de nom npm est donc vu comme une
  réinstallation du même plugin, pas comme un nouveau plugin.
- `paperclipai plugin upgrade` ne convient **pas** : la route ne prend qu'une version et réutilise le nom npm enregistré.
- Installer le nouveau nom **sans** désinstaller l'ancien échoue (`Plugin already installed: hermes-control`) après avoir
  déjà téléchargé le nouveau paquet dans `~/.paperclip/plugins` (fichiers orphelins, base inchangée).
- Le nom `@cyberservices-ai/paperclip-plugin-…` ne suit pas la convention de nom `@scope/plugin-*` ; Paperclip l'accepte
  parce que le `package.json` porte la clé `paperclipPlugin`. Seul effet : le balayage de découverte des `node_modules`
  (outil de développement) l'ignore ; le chargement au démarrage passe par la ligne `plugins` (nom npm enregistré, portée
  `@scope/` gérée).

### Adaptateur : la clé est le type `hermes_local`, pas le nom npm

- Les adaptateurs externes sont enregistrés dans `<dossier Paperclip>/adapter-plugins.json`, un enregistrement par
  **type** (`services/adapter-plugin-store.js` : `addAdapterPlugin` remplace l'enregistrement qui a le même `type`). Le
  paquet est installé par `npm install --no-save <nom>` dans `<dossier Paperclip>/adapter-plugins/`.
- L'état « en pause » (`adapter-settings.json`, `disabledTypes`) est aussi rangé par type.
- Les agents ne connaissent que `adapterType = "hermes_local"` et leur `adapterConfig` (table `agents`) : ni l'un ni
  l'autre ne contient le nom npm. Installer l'adaptateur sous un autre nom **ne modifie aucun agent**.
- `routes/adapters.js` : installer un adaptateur dont le type existe déjà le remplace dans le registre et dans
  `adapter-plugins.json` (réponse `requiresRestart: true` s'il remplaçait un adaptateur externe).
- `paperclipai adapter delete hermes_local` retire l'enregistrement **et** désinstalle le paquet **actuellement
  enregistré**, puis Paperclip revient à l'adaptateur intégré `hermes_local` (non contrôlé par Hermes Control).

## 2. Procédure de migration (ancien nom → 0.7.0)

À faire par l'administrateur, **mutations arrêtées** (pas d'agent créé ou renommé, pas d'action du plugin, pas de ticket
lancé) du début à la fin.

1. **Sauvegarde à froid**, Paperclip arrêté : base Paperclip et dossier de données (dont `adapter-plugins/`,
   `adapter-plugins.json`, `adapter-settings.json`), `~/.paperclip/plugins`, `<compte>/.config/hermes-control/`.
   Noter la sortie de `paperclipai plugin list` (UUID et version du plugin `hermes-control`) et le contenu de
   `adapter-plugins.json`.
2. Redémarrer Paperclip. **Adaptateur d'abord**, sans `adapter delete` (sinon les agents passeraient un moment sur
   l'adaptateur intégré, non contrôlé) :
   ```
   paperclipai adapter install --payload-json '{"packageName":"@cyberservices-ai/paperclip-adapter-hermes-control","version":"0.7.0"}'
   ```
   L'enregistrement `hermes_local` pointe alors vers le nouveau nom. Les fichiers de l'ancien paquet peuvent rester dans
   `adapter-plugins/node_modules` (npm peut les retirer lui-même, l'installation étant `--no-save`) : ils ne sont plus lus.
   **Ne pas** lancer `adapter delete hermes_local` pour « nettoyer » l'ancien : cela désinstallerait le nouveau.
3. **Plugin** — désinstallation douce puis installation du nouveau nom :
   ```
   paperclipai plugin uninstall hermes-control          # SANS --force
   paperclipai plugin install @cyberservices-ai/paperclip-plugin-hermes-control@0.7.0
   ```
4. **Redémarrer Paperclip** (l'adaptateur remplacé est rechargé proprement ; le module de l'ancien adaptateur ne reste pas
   en mémoire).
5. Contrôles :
   - `paperclipai plugin list` : `hermes-control`, **même UUID qu'à l'étape 1**, version 0.7.0, statut `ready`,
     `packageName` = nouveau nom ;
   - `adapter-plugins.json` : un seul enregistrement `hermes_local`, `packageName` = nouveau nom, version 0.7.0 ;
   - réglages du plugin par entreprise toujours présents ; la vue « Hermes » montre les mêmes instances et affectations ;
   - « Test environment » d'un agent Hermes : adaptateur Hermes Control, copies corrigées (voie 1) chargées ;
   - un passage d'agent : ligne « → Hermes `<instance>/<profil>` » attendue ; `assignments.json` inchangé (empreinte).

Si `hermes-control-suivi` était installé à part (`npm i -g`), désinstaller l'ancien paquet puis installer le nouveau
(même nom de commande, sinon conflit de lien).

## 3. Retour arrière (0.7.0 → version précédente sous l'ancien nom)

Même mécanique dans l'autre sens, mutations arrêtées :

```
paperclipai adapter install --payload-json '{"packageName":"paperclip-adapter-hermes-control","version":"<version>"}'
paperclipai plugin uninstall hermes-control             # SANS --force
paperclipai plugin install paperclip-plugin-hermes-control@<version>
# puis redémarrer Paperclip
```

- Sur npm, seule la **0.5.0** existe sous l'ancien nom. Les 0.6.x n'ont jamais été publiées : elles ne se réinstallent que
  depuis leurs archives figées de recette (`--local` / `isLocalPath`), pas depuis npm. Revenir en **0.5.0** relève de
  `scripts/rollback-to-0.5.mjs` et de la section *Rollback* du README (règle par le nom, cas bloquants) : le changement de
  nom ne change rien à ces limites.
- Ce que le retour arrière garde : la même ligne `plugins` (UUID, configuration, état, jobs), l'enregistrement
  `hermes_local`, les agents, le dossier de référence et les instances Hermes. Les fichiers propres au lot B (suivi de
  fraîcheur, `donnees/.hermes-control-suivi.json`, file de notifications) restent sur le disque ; une version antérieure
  les ignore.
- Si la base ou les réglages ont été abîmés : restaurer la sauvegarde à froid de l'étape 1, Paperclip arrêté.

## 4. Ce qui change aussi dans les paquets 0.7.0

- **Adaptateur autonome** : les copies corrigées « voie 1 » de `@paperclipai/adapter-utils` et
  `@paperclipai/hermes-paperclip-adapter` (2026.1001.0-hc063.1) sont **intégrées dans `dist/index.js`** avec leurs
  dépendances d'exécution ; licences dans `dist/THIRD_PARTY_LICENSES.md`, provenance dans `voie1/LICENCES.md`.
  L'archive n'a plus **aucune dépendance** à l'installation : l'ancienne archive dépendait de `file:voie1/paquets/*.tgz`,
  qu'npm ne sait pas résoudre depuis un paquet installé (échec `ENOENT` reproduit avec un cache vide). La ressource lue à
  l'exécution par l'adaptateur officiel (`skills/paperclip-task-bridge`) est livrée sous `dist/vendor/`.
- **Plugin autonome aussi** : plus aucune dépendance d'exécution (`yaml` et `@paperclipai/plugin-sdk` sont intégrés au
  worker ; React et `@paperclipai/plugin-sdk/ui` sont fournis par l'hôte dans le navigateur). Le pair
  `@paperclipai/plugin-sdk` est déclaré **optionnel** : npm ne le télécharge pas. Les deux archives s'installent donc
  **hors ligne** (cache npm vide, registre injoignable), vérifié par `scripts/verifier-installation.sh`. Licences :
  `dist/THIRD_PARTY_LICENSES.md`.
- Conséquence : une mise à jour de Paperclip **ne met pas à jour** ces copies ; il faut reconstruire l'adaptateur sur la
  nouvelle base (`voie1/fabriquer.sh` échoue explicitement si la base ne correspond plus).
- `engines.node` de l'adaptateur : `>=24.11.0` (comme Paperclip 2026.1001.0 et les modules intégrés).
- Avant la première publication : vérifier la portée npm `@cyberservices-ai` et les droits du compte (non vérifiés ici),
  puis `npm deprecate` des anciens noms avec un renvoi vers les nouveaux (jamais dépublier).
