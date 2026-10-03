# Publier Hermes Control (aide-mémoire)

## 1. Compte npm
Compte : `cyberservices-ai` (e-mail ineeddbox@gmail.com). npm exige, pour publier, **soit** la 2FA du compte (code à usage unique à chaque publication), **soit** un jeton granulaire avec **« Bypass two-factor authentication »**.

- Jeton avec bypass (recommandé) : npmjs.com → avatar → Access Tokens → Generate New Token → Granular → Read and write, All packages, cocher *Bypass 2FA* → copier → sur le PC : `npm-jeton` (colle, Entrée) → `npm whoami`.
- Sans bypass : garder une application d'authentification sous la main et publier avec `scripts/publish.sh <code 2FA>`.

Attention : un jeton **sans** bypass ne peut publier que vers la « staging area » de npm, et une **première** publication (paquet inexistant) l'exige « direct-capable » (bypass 2FA). Erreur vue le 2026-10-03 : `E_STAGE_REQUIRED`. La case *Bypass 2FA* n'apparaît qu'une fois la 2FA du compte activée (application d'authentification).

Le site npmjs.com peut être bloqué depuis Starlink (adresse partagée) : utiliser le téléphone en 4G pour le site ; le registre (`npm publish`) passe depuis le PC.

## 2. Publier
```
scripts/publish.sh            # jeton bypass 2FA
scripts/publish.sh 123456     # avec un code 2FA
```
Le script lance les tests + builds, saute un paquet déjà publié à cette version, et publie `paperclip-adapter-hermes-control` puis `paperclip-plugin-hermes-control`.

Nouvelle version : changer `version` dans `package.json` **et** `adapter/package.json` (même numéro), ajouter l'entrée dans `CHANGELOG.md`, commit + tag `git tag v0.3.1 && git push --tags`, puis publier.

## 3. Après la première publication : publication sans jeton (GitHub Actions)
Sur npmjs.com, pour chaque paquet : Package → Settings → **Trusted Publishing** → GitHub Actions → owner `CryptoDjam`, repo `hermes-control`, workflow `publish.yml`. Ensuite, créer une *release* GitHub (tag `vX.Y.Z`) publie les deux paquets automatiquement, avec provenance, sans jeton ni 2FA (`.github/workflows/publish.yml`).

## 4. Catalogue Paperclip Hub + awesome-paperclip
- Hub : https://cliphub.fyi → *Submit a plugin* → nom npm `paperclip-plugin-hermes-control` (le Hub lit le manifeste depuis npm et vérifie que le compte soumis est mainteneur npm). Texte prêt : `docs/hub-submission.md`.
- awesome-paperclip : https://github.com/gsxdsm/awesome-paperclip → PR ajoutant la ligne de `docs/hub-submission.md`.

## 5. Vérifier
`npm view paperclip-plugin-hermes-control version` et `npm view paperclip-adapter-hermes-control version` → 0.3.0 ; `npx paperclipai plugin install paperclip-plugin-hermes-control` fonctionne sur une instance vierge.
