# Publier Hermes Control (aide-mémoire)

## 1. Compte npm
Compte : `cyberservices-ai` (the npm account owner's e-mail). npm exige, pour publier, **soit** la 2FA du compte (code à usage unique à chaque publication), **soit** un jeton granulaire avec **« Bypass two-factor authentication »**.

- Jeton avec bypass (recommandé) : npmjs.com → avatar → Access Tokens → Generate New Token → Granular → Read and write, All packages, cocher *Bypass 2FA* → copier → sur le PC : `npm-jeton` (colle, Entrée) → `npm whoami`.
- Sans bypass : garder une application d'authentification sous la main et publier avec `scripts/publish.sh <code 2FA>`.

Attention : un jeton **sans** bypass ne peut publier que vers la « staging area » de npm, et une **première** publication (paquet inexistant) l'exige « direct-capable » (bypass 2FA). Erreur vue le 2026-10-03 : `E_STAGE_REQUIRED`. La case *Bypass 2FA* n'apparaît qu'une fois la 2FA du compte activée (application d'authentification).

Le site npmjs.com peut être bloqué depuis Starlink (adresse partagée) : utiliser le téléphone en 4G pour le site ; le registre (`npm publish`) passe depuis le PC.

## 2. Publier

Ce qui a marché le 2026-10-03 : `npm login --auth-type=legacy` (mot de passe + code 2FA) → e-mail du compte vérifié → `scripts/publish.sh` publie en **staging** (`0.0.0-stage` visible) → **approbation sur npmjs.com** (téléphone, Staged Packages → Approve + 2FA) → la 0.3.0 devient `latest`. Le Hub indexe ensuite tout seul (mot-clé `paperclip-plugin`).

```
scripts/publish.sh            # jeton bypass 2FA
scripts/publish.sh 123456     # avec un code 2FA
```
Le script lance les tests + builds, saute un paquet déjà publié à cette version, et publie l'adaptateur puis le plugin (noms lus dans les `package.json` : depuis 0.7.0 `@cyberservices-ai/paperclip-adapter-hermes-control` puis `@cyberservices-ai/paperclip-plugin-hermes-control`, paquets à portée publique `publishConfig.access: public` ; jusqu'à 0.5.0 `paperclip-adapter-hermes-control` / `paperclip-plugin-hermes-control`). **Avant la première publication 0.7.0** : vérifier que la portée npm `@cyberservices-ai` existe et que le compte a le droit d'y publier (non vérifié à la préparation de 0.7.0), et configurer le Trusted Publishing pour les **nouveaux** noms ; marquer les anciens noms `npm deprecate` avec un renvoi vers les nouveaux (jamais dépublier).

Nouvelle version : changer `version` dans `package.json` **et** `adapter/package.json` (même numéro), ajouter l'entrée dans `CHANGELOG.md`, commit + tag `git tag v0.3.1 && git push --tags`, puis publier.

### Vu le 2026-10-04 (0.4.0)
- `scripts/publish.sh` : l'adaptateur 0.4.0 est parti en **staging** (à approuver sur npmjs.com, téléphone) ; `npm view` ne le montre qu'après approbation.
- Le plugin a répondu `E403 … cannot be republished until 24 hours have passed` : `npm view paperclip-plugin-hermes-control` dit **« Unpublished on 2026-10-03T23:07:22Z »** (01:07 heure de Paris le 4). Un paquet dépublié ne peut pas être republié sous le même nom pendant 24 h → relancer `scripts/publish.sh` après le 2026-10-05 01:10 (le script saute l'adaptateur déjà publié). Ne jamais dépublier : préférer `npm deprecate`.

## 3. Après la première publication : publication sans jeton (GitHub Actions)
Sur npmjs.com, pour chaque paquet : Package → Settings → **Trusted Publishing** → GitHub Actions → owner `CyberServices-ai`, repo `hermes-control`, workflow `publish.yml`. Ensuite, créer une *release* GitHub (tag `vX.Y.Z`) publie les deux paquets automatiquement, avec provenance, sans jeton ni 2FA (`.github/workflows/publish.yml`).

**To do (Cyril, on npmjs.com, 2FA):** reconfigure Trusted Publishing of both packages for the owner `CyberServices-ai` (renamed from `CryptoDjam` on 2026-10-06).

## 4. Catalogue Paperclip Hub + awesome-paperclip
- Hub : https://cliphub.fyi → *Submit a plugin* → nom npm `@cyberservices-ai/paperclip-plugin-hermes-control` depuis 0.7.0, `paperclip-plugin-hermes-control` jusqu'à 0.5.0 (le Hub lit le manifeste depuis npm et vérifie que le compte soumis est mainteneur npm). Texte prêt : `docs/hub-submission.md`.
- awesome-paperclip : https://github.com/gsxdsm/awesome-paperclip → PR ajoutant la ligne de `docs/hub-submission.md`.

## 5. Vérifier
`npm view paperclip-plugin-hermes-control version` et `npm view paperclip-adapter-hermes-control version` → 0.5.0 ; `npx paperclipai plugin install paperclip-plugin-hermes-control` fonctionne sur une instance vierge.

### Vu le 2026-10-05 (17:37)
- Le plugin n'avait jamais été republié après la dépublication du 03/10 (24 h passées le 05/10 à 01:07). `scripts/publish.sh` sans code : **adaptateur 0.5.0 et plugin 0.5.0 acceptés** (`+ …@0.5.0`) mais tous deux en **staging** : `npm view` montre encore adaptateur `latest 0.4.0` et plugin `latest 0.0.0-stage`. → approuvés par Cyril : `latest` = 0.5.0 pour les deux depuis 17:42.
