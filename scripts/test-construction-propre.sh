#!/bin/bash
# Test de scripts/construction-propre.sh : une étape en échec fait échouer le script (code ≠ 0), au bon endroit,
# et les étapes suivantes ne s'exécutent pas. Sans réseau ni npm ci (rapide). Le registre est volontairement
# injoignable (127.0.0.1:9) : aucun cas ne peut « réussir » en allant plus loin.
#   1. piège dans l'étape outils : `false | cat` (pipeline) suivi de commandes qui réussiraient ;
#   2. même piège dans l'étape clone : l'étape précédente passe, l'échec arrête tout ;
#   3. registre injoignable sans --cache-fourni : échec explicite, code 10, pas de passage hors ligne.
# Usage : scripts/test-construction-propre.sh [commit]   (défaut : HEAD)
set -euo pipefail
SCRIPT="$(cd "$(dirname "$0")" && pwd)/construction-propre.sh"
COMMIT=${1:-HEAD}
T=$(mktemp -d "${TMPDIR:-/tmp}/test-construction-propre.XXXXXX"); trap 'rm -rf "$T"' EXIT
ko=0
verifier() {   # verifier <nom> <code attendu> <étape en échec attendue> <étape suivante, qui ne doit pas tourner> <CP_PIEGE>
  local nom=$1 attendu=$2 etape=$3 suivante=$4 piege=$5 out="$T/$1" rc msg=""
  set +e
  CP_PIEGE=$piege bash "$SCRIPT" --registre http://127.0.0.1:9/ --sortie "$out" "$COMMIT" > "$T/$nom.stdout" 2>&1
  rc=$?
  set -e
  [ "$rc" -eq "$attendu" ] || msg+=" code $rc au lieu de $attendu;"
  grep -q "^ÉCHEC  $etape (code $attendu)" "$out/bilan.txt" || msg+=" bilan sans « ÉCHEC $etape »;"
  grep -q "^ARRÊT au premier contrôle en erreur" "$out/bilan.txt" || msg+=" bilan sans ARRÊT;"
  if grep -q "^OK     $suivante\$" "$out/bilan.txt" || compgen -G "$out/*-$suivante.log" > /dev/null; then msg+=" l'étape $suivante a tourné;"; fi
  if grep -q "RÉSULTAT : toutes les étapes ont réussi" "$out/bilan.txt"; then msg+=" le bilan annonce une réussite;"; fi
  if [ -n "$piege" ] && ! grep -q "piège déclenché dans l'étape $piege" "$out"/*-"$etape".log; then msg+=" piège non déclenché;"; fi
  if [ -n "$msg" ]; then echo "ÉCHEC  $nom :$msg"; cat "$T/$nom.stdout"; ko=$((ko + 1)); else echo "OK     $nom (code $rc, arrêt à $etape)"; fi
}
verifier piege-outils 1  outils          clone            outils
verifier piege-clone  1  clone           source-archives  clone
verifier sans-reseau  10 source-archives archives-origine ""
[ "$ko" -eq 0 ] || { echo "test-construction-propre : $ko cas en échec"; exit 1; }
echo "test-construction-propre : 3/3"
