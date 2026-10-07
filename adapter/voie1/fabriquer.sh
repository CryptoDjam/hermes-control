#!/bin/bash
# VOIE 1 (Hermes Control 0.6.3) : correctifs LOCAUX de deux dépendances Paperclip, appliqués sur les archives PUBLIÉES.
# Ce ne sont pas des correctifs acceptés par le mainteneur : copies corrigées livrées avec l'adaptateur.
#   base       : @paperclipai/adapter-utils et @paperclipai/hermes-paperclip-adapter 2026.1001.0 (origine/INTEGRITE-*)
#   correctifs : patches/*.patch (provenance : env-prototypes, voir LICENCES.md)
#   sortie     : paquets/paperclipai-<nom>-2026.1001.0-hc063.<n>.tgz (référencés par package.json + package-lock.json)
# ÉCHEC EXPLICITE (code ≠ 0, rien n'est écrit dans paquets/) si : archive de base absente du cache ou d'intégrité
# différente ; fichier de base dont l'empreinte ne correspond plus (origine/SHA256SUMS-*) ; correctif qui ne s'applique
# pas exactement (patch --dry-run, sans décalage ni approximation).
# Usage : voie1/fabriquer.sh [--verifier | --nouvelles-empreintes]
#   (aucun argument : reconstruit paquets/ et exige les empreintes versionnées paquets/SHA256SUMS ;
#    --verifier : reconstruit dans un dossier temporaire et compare aux archives présentes ;
#    --nouvelles-empreintes : après un changement VOULU des correctifs, réécrit paquets/SHA256SUMS)
set -euo pipefail
ICI=$(cd "$(dirname "$0")" && pwd)
VERSION_HC=2026.1001.0-hc063.1
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir -p "$W/base" "$W/src"
# 1. archives publiées, depuis le cache npm (hors ligne), intégrité vérifiée
while read -r nom version url integ; do
  [ -z "${nom:-}" ] && continue; case "$nom" in \#*) continue;; esac
  court=${nom#@paperclipai/}
  (cd "$W/base" && npm pack "$url" --offline --silent >/dev/null 2>"$W/npm.err") || { echo "ÉCHEC : $nom@$version absent du cache npm (hors ligne) : $(tail -1 "$W/npm.err")" >&2; exit 3; }
  tgz="$W/base/paperclipai-$court-$version.tgz"
  got="sha512-$(openssl dgst -sha512 -binary "$tgz" | base64 -w0)"
  [ "$got" = "$integ" ] || { echo "ÉCHEC : intégrité de $nom@$version différente de la base attendue ($got)" >&2; exit 3; }
  mkdir -p "$W/src/$court" && tar -xzf "$tgz" -C "$W/src/$court" --strip-components=1
done < "$ICI/origine/INTEGRITE-2026.1001.0"
# 2. empreintes des fichiers de base touchés par les correctifs
(cd "$W/src" && sha256sum --quiet -c "$ICI/origine/SHA256SUMS-2026.1001.0") || { echo "ÉCHEC : la base ne correspond plus à 2026.1001.0 (empreintes ci-dessus)" >&2; exit 4; }
# 3. correctifs : application stricte (aucun décalage, aucune approximation), d'abord à blanc
for p in "$ICI"/patches/*.patch; do
  out=$(cd "$W/src" && patch -p1 --dry-run -F0 -N < "$p" 2>&1) || { echo "ÉCHEC : $(basename "$p") ne s'applique pas sur la base : $out" >&2; exit 5; }
  echo "$out" | grep -qiE "offset|fuzz|hunk .* succeeded at" && { echo "ÉCHEC : $(basename "$p") s'applique avec décalage : $out" >&2; exit 5; }
  (cd "$W/src" && patch -p1 -F0 -N -s < "$p")
done
# 4. identité des paquets corrigés (version distincte, provenance) puis npm pack (horodatages fixes de npm : reproductible)
for court in adapter-utils hermes-paperclip-adapter; do
  node -e '
    const fs = require("fs"); const [f, v, base, patches] = process.argv.slice(1);
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.version = v;
    if (j.dependencies && j.dependencies["@paperclipai/adapter-utils"]) j.dependencies["@paperclipai/adapter-utils"] = v;
    j.hermesControlPatch = { base, patches: patches.split(" "), note: "correctif LOCAL Hermes Control 0.6.3 (voie 1), non publié par le mainteneur" };
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  ' "$W/src/$court/package.json" "$VERSION_HC" "@paperclipai/$court@2026.1001.0" "$(cd "$ICI/patches" && sha256sum *.patch | awk '{print $2"="$1}' | tr '\n' ' ' | sed 's/ $//')"
  (cd "$W/src/$court" && npm pack --pack-destination "$W" --silent --ignore-scripts >/dev/null)
done
if [ "${1:-}" = "--verifier" ]; then
  for f in "$W"/*.tgz; do cmp -s "$f" "$ICI/paquets/$(basename "$f")" || { echo "ÉCHEC : $(basename "$f") reconstruit diffère de l'archive présente" >&2; exit 6; }; done
  echo "voie 1 : archives reconstruites identiques"; exit 0
fi
# empreintes versionnées (paquets/SHA256SUMS) : une reconstruction différente est un ÉCHEC (sauf --nouvelles-empreintes)
if [ -f "$ICI/paquets/SHA256SUMS" ] && [ "${1:-}" != "--nouvelles-empreintes" ]; then
  (cd "$W" && sha256sum --quiet -c "$ICI/paquets/SHA256SUMS") || { echo "ÉCHEC : archives reconstruites ≠ empreintes versionnées (paquets/SHA256SUMS)" >&2; exit 6; }
fi
mkdir -p "$ICI/paquets"; rm -f "$ICI"/paquets/*.tgz; cp "$W"/*.tgz "$ICI/paquets/"
(cd "$ICI/paquets" && sha256sum *.tgz > SHA256SUMS && cat SHA256SUMS)
