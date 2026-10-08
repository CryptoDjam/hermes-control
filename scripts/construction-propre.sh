#!/bin/bash
# Construction propre de Hermes Control depuis un commit donné, sans rien hériter du poste.
#   clone frais (dossier temporaire) ; HOME, cache npm et configuration npm vierges ;
#   archives d'origine de voie1 obtenues en version exacte et vérifiées (sha512 de origine/INTEGRITE-*) ;
#   adapter/voie1/fabriquer.sh rejoué (correctifs reconstruits, identiques aux archives versionnées) ;
#   npm ci (racine + adapter/), build, tsc, tests racine + adapter/, lot-063 OBLIGATOIRE (jamais sauté) ;
#   archives livrables (npm pack) et leurs SHA-256 ; installation et import des deux archives depuis un HOME et un cache
#   npm vierges (scripts/verifier-installation.sh, en ligne seulement) ; bilan écrit dans le dossier de sortie.
# S'arrête au PREMIER contrôle en erreur, code ≠ 0. Aucune erreur masquée : chaque étape tourne dans un
# sous-shell `set -euo pipefail` hors de tout contexte conditionnel, sa sortie va dans un journal (pas de pipe).
#
# Usage : scripts/construction-propre.sh [options] <commit>
#   --depot DIR          dépôt à cloner (défaut : le dépôt qui contient ce script)
#   --sortie DIR         dossier du bilan et des journaux (défaut : ./construction-propre-<commit court>)
#   --cache-fourni DIR   cache npm déjà rempli (copié, jamais modifié), mode HORS LIGNE : toutes les archives
#                        doivent y être ; les archives d'origine y sont vérifiées par leur sha512 comme en ligne
#   --registre URL       registre npm (défaut : https://registry.npmjs.org/)
#   --garder             conserver le dossier temporaire (clone, cache) après la fin
# Sans réseau et sans --cache-fourni : échec explicite (code 10), rien n'est sauté. Avec --cache-fourni, l'étape
# installation-archives (registre requis) échoue explicitement (code 11) : la réussite complète exige le réseau.
# Test seulement : CP_PIEGE=<étape> fait échouer cette étape au milieu (voir scripts/test-construction-propre.sh).
set -euo pipefail

DEPOT=""; SORTIE=""; CACHE_FOURNI=""; REGISTRE="https://registry.npmjs.org/"; GARDER=0; COMMIT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --depot) DEPOT=$2; shift 2;;
    --sortie) SORTIE=$2; shift 2;;
    --cache-fourni) CACHE_FOURNI=$2; shift 2;;
    --registre) REGISTRE=$2; shift 2;;
    --garder) GARDER=1; shift;;
    -h|--help) sed -n '2,21p' "$0"; exit 0;;
    -*) echo "option inconnue : $1" >&2; exit 2;;
    *) [ -z "$COMMIT" ] || { echo "un seul commit attendu" >&2; exit 2; }; COMMIT=$1; shift;;
  esac
done
[ -n "$COMMIT" ] || { echo "usage : $0 [--depot DIR] [--sortie DIR] [--cache-fourni DIR] [--registre URL] [--garder] <commit>" >&2; exit 2; }
[ -n "$DEPOT" ] || DEPOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
DEPOT=$(cd "$DEPOT" && pwd)
SHA=$(git -C "$DEPOT" rev-parse --verify "$COMMIT^{commit}")
[ -n "$SORTIE" ] || SORTIE="$PWD/construction-propre-${SHA:0:7}"
if [ -n "$CACHE_FOURNI" ]; then
  [ -d "$CACHE_FOURNI" ] || { echo "cache fourni introuvable : $CACHE_FOURNI" >&2; exit 2; }
  CACHE_FOURNI=$(cd "$CACHE_FOURNI" && pwd)
fi
mkdir -p "$SORTIE"; SORTIE=$(cd "$SORTIE" && pwd)
[ -z "$(ls -A "$SORTIE")" ] || { echo "dossier de sortie non vide : $SORTIE" >&2; exit 2; }

W=$(mktemp -d "${TMPDIR:-/tmp}/construction-propre.XXXXXX")
nettoyer() { if [ "$GARDER" = 1 ]; then echo "dossier temporaire conservé : $W"; else rm -rf "$W"; fi; }
trap nettoyer EXIT
SRC="$W/src"; BILAN="$SORTIE/bilan.txt"

# Environnement vierge : aucun réglage npm du poste (ni ~/.npmrc, ni config globale, ni variables npm_config_*).
while IFS= read -r v; do unset "$v"; done < <(compgen -e | grep -i '^npm_config_' || [ $? -eq 1 ])
unset NODE_OPTIONS NODE_PATH
mkdir -p "$W/home" "$W/npm-cache"
: > "$W/home/.npmrc"; : > "$W/npmrc-global"
# TMPDIR reste celui du système (court) : les tests vérifient la limite T16 des sockets (≤ 100 octets), qu'un
# TMPDIR long ferait échouer à tort ; chaque test y crée son propre dossier temporaire.
export TMPDIR="${TMPDIR:-/tmp}"
export HOME="$W/home" XDG_CONFIG_HOME="$W/home/.config" XDG_CACHE_HOME="$W/home/.cache"
export npm_config_cache="$W/npm-cache" npm_config_userconfig="$W/home/.npmrc" npm_config_globalconfig="$W/npmrc-global"
export npm_config_registry="$REGISTRE" npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false
if [ -n "$CACHE_FOURNI" ]; then MODE="cache fourni (hors ligne) : $CACHE_FOURNI"; export npm_config_offline=true
else MODE="réseau : $REGISTRE"; fi

bilan() { printf '%s\n' "$*" >> "$BILAN"; }
N=0
etape() {   # etape <nom> <fonction> : journal dans $SORTIE/NN-<nom>.log ; premier échec = arrêt, code de l'étape
  local nom=$1 rc; shift; N=$((N + 1))
  local log; log=$(printf '%s/%02d-%s.log' "$SORTIE" "$N" "$nom")
  printf '== %-28s ' "$nom"
  set +e
  ( set -euo pipefail; "$@" ) > "$log" 2>&1
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    echo "ÉCHEC (code $rc)"; bilan "ÉCHEC  $nom (code $rc) — journal : $log"
    bilan "ARRÊT au premier contrôle en erreur ; étapes suivantes NON exécutées."
    echo "--- fin du journal $log ---" >&2; tail -n 40 "$log" >&2
    echo "Bilan : $BILAN" >&2
    exit "$rc"
  fi
  echo "ok"; bilan "OK     $nom"
}
piege() {   # point de contrôle des tests : échoue AU MILIEU de l'étape, dans un pipeline, si CP_PIEGE la désigne
  if [ "${CP_PIEGE:-}" = "$1" ]; then echo "piège déclenché dans l'étape $1"; false | cat; fi
  return 0
}

# ---------- étapes ----------
e_outils() {
  piege outils
  for o in git node npm openssl patch tar sha256sum bwrap; do command -v "$o" >/dev/null || { echo "outil manquant : $o"; exit 1; }; done
  node -v; npm -v
}
e_clone() {
  piege clone
  git clone --quiet --no-local --no-hardlinks "$DEPOT" "$SRC"
  git -C "$SRC" -c advice.detachedHead=false checkout --quiet --detach "$SHA"
  [ "$(git -C "$SRC" rev-parse HEAD)" = "$SHA" ]
  [ -z "$(git -C "$SRC" status --porcelain)" ] || { echo "clone non propre"; git -C "$SRC" status --porcelain; exit 1; }
  ls "$SRC"/adapter/voie1/origine/INTEGRITE-* "$SRC"/adapter/voie1/fabriquer.sh "$SRC"/src/lot-063.test.ts "$SRC"/adapter/src/lot-063.test.ts
}
e_source_archives() {
  piege source-archives
  if [ -n "$CACHE_FOURNI" ]; then
    cp -a "$CACHE_FOURNI/." "$npm_config_cache/"
    echo "cache fourni copié (hors ligne) depuis $CACHE_FOURNI"
  else
    # le réseau est EXIGÉ : une panne est un échec explicite, jamais un passage hors ligne silencieux
    if ! npm ping --registry "$REGISTRE" >"$W/ping.out" 2>&1; then
      cat "$W/ping.out"
      echo "RÉSEAU INDISPONIBLE : registre $REGISTRE injoignable. Rien n'est sauté : relancer avec réseau,"
      echo "ou avec --cache-fourni DIR (cache npm contenant toutes les archives ; empreintes vérifiées)."
      exit 10
    fi
    cat "$W/ping.out"
  fi
}
e_archives_origine() {   # versions exactes (URL figées) ; sha512 = origine/INTEGRITE-* ; la même chose que fabriquer.sh lira
  piege archives-origine
  local f; f=$(ls "$SRC"/adapter/voie1/origine/INTEGRITE-*)
  mkdir -p "$W/origine"
  local n=0
  while read -r nom version url integ; do
    [ -n "${nom:-}" ] || continue; case "$nom" in \#*) continue;; esac
    if [ -z "$CACHE_FOURNI" ]; then npm cache add "$url"; fi
    (cd "$W/origine" && npm pack "$url" --offline --loglevel=error > "$W/pack.out")
    local tgz; tgz="$W/origine/$(tail -n 1 "$W/pack.out")"
    [ -f "$tgz" ] || { echo "archive non produite pour $nom@$version"; exit 3; }
    local got; got="sha512-$(openssl dgst -sha512 -binary "$tgz" | base64 -w0)"
    [ "$got" = "$integ" ] || { echo "INTÉGRITÉ DIFFÉRENTE : $nom@$version attendu $integ obtenu $got"; exit 3; }
    echo "origine $nom@$version sha512 ok sha256=$(sha256sum "$tgz" | cut -d' ' -f1)"
    n=$((n + 1))
  done < "$f"
  [ "$n" -ge 2 ] || { echo "liste d'origine incomplète ($n archive(s))"; exit 3; }
}
e_fabriquer() {
  piege fabriquer
  (cd "$SRC/adapter" && bash voie1/fabriquer.sh)
  # les archives reconstruites doivent être OCTET POUR OCTET celles du commit
  [ -z "$(git -C "$SRC" status --porcelain)" ] || { echo "fabriquer.sh a modifié l'arbre :"; git -C "$SRC" status --porcelain; exit 6; }
}
e_ci_racine()      { piege ci-racine; (cd "$SRC" && npm ci); }
e_ci_adapter()     { piege ci-adapter; (cd "$SRC/adapter" && npm ci); }
e_build_racine()   { piege build-racine; (cd "$SRC" && npm run build); }
e_build_adapter()  { piege build-adapter; (cd "$SRC/adapter" && npm run build); }
e_tsc_racine()     { piege tsc-racine; (cd "$SRC" && npm run typecheck); }
e_tsc_adapter()    { piege tsc-adapter; (cd "$SRC/adapter" && npm run typecheck); }
e_tests_racine()   { piege tests-racine; (cd "$SRC" && npx --no-install vitest run --reporter=default --reporter=json --outputFile="$SORTIE/vitest-racine.json"); }
e_tests_adapter()  { piege tests-adapter; (cd "$SRC/adapter" && npx --no-install vitest run --reporter=default --reporter=json --outputFile="$SORTIE/vitest-adapter.json"); }
e_lot063() {   # OBLIGATOIRE : chaque fichier lot-063 présent, tous ses tests exécutés et réussis, aucun sauté
  piege lot-063
  node - "$SORTIE/vitest-racine.json" "$SORTIE/vitest-adapter.json" > "$W/lot063.txt" <<'JS'
const fs = require("fs");
const exiges = [["vitest-racine.json", "/src/lot-063.test.ts"], ["vitest-racine.json", "/adapter/src/lot-063.test.ts"], ["vitest-adapter.json", "/adapter/src/lot-063.test.ts"]];
const rapports = Object.fromEntries(process.argv.slice(2).map((f) => [f.split("/").pop(), JSON.parse(fs.readFileSync(f, "utf8"))]));
let ko = 0;
for (const [r, suffixe] of exiges) {
  const fichiers = rapports[r].testResults.filter((t) => t.name.endsWith(suffixe) && !(suffixe.startsWith("/src/") && t.name.endsWith("/adapter" + suffixe)));
  const a = fichiers.flatMap((t) => t.assertionResults);
  const passes = a.filter((x) => x.status === "passed").length;
  const ok = fichiers.length === 1 && a.length > 0 && passes === a.length;
  if (!ok) ko++;
  console.log(`${ok ? "OK" : "ÉCHEC"} lot-063 ${r}${suffixe} : ${passes}/${a.length} réussis${fichiers.length !== 1 ? ` (fichier trouvé ${fichiers.length} fois)` : ""}${a.length - passes ? `, ${a.length - passes} non réussis ou sautés` : ""}`);
}
for (const [r, j] of Object.entries(rapports)) console.log(`suite ${r} : ${j.numPassedTests}/${j.numTotalTests} réussis, ${j.numFailedTests} échecs, ${j.numPendingTests + (j.numTodoTests || 0)} sautés`);
process.exit(ko ? 1 : 0);
JS
  cat "$W/lot063.txt"
}
e_archives_livrables() {
  piege archives-livrables
  mkdir -p "$SORTIE/archives"
  (cd "$SRC" && npm pack --pack-destination "$SORTIE/archives" --silent)
  (cd "$SRC/adapter" && npm pack --pack-destination "$SORTIE/archives" --silent)
  (cd "$SORTIE/archives" && sha256sum ./*.tgz > SHA256SUMS && cat SHA256SUMS)
}
e_installation_archives() {   # 0.7.0 : les deux archives s'installent et s'importent depuis un HOME et un cache npm VIERGES
  piege installation-archives
  if [ -n "$CACHE_FOURNI" ]; then echo "mode hors ligne : installation depuis le registre impossible, étape EXIGÉE en ligne"; exit 11; fi
  bash "$SRC/scripts/verifier-installation.sh" --registre "$REGISTRE" "$SORTIE/archives"
}

# ---------- exécution ----------
bilan "Construction propre de Hermes Control — $(date -Iseconds)"
bilan "dépôt   : $DEPOT"
bilan "commit  : $SHA ($(git -C "$DEPOT" log -1 --format=%s "$SHA"))"
bilan "mode    : $MODE"
bilan "node    : $(node -v)   npm : $(npm -v)   ($(uname -sr))"
bilan "HOME, cache npm, config npm : vierges sous $W ; TMPDIR des tests : $TMPDIR"
bilan ""
etape outils            e_outils
etape clone             e_clone
etape source-archives   e_source_archives
etape archives-origine  e_archives_origine
etape fabriquer         e_fabriquer
etape ci-racine         e_ci_racine
etape ci-adapter        e_ci_adapter
etape build-racine      e_build_racine
etape build-adapter     e_build_adapter
etape tsc-racine        e_tsc_racine
etape tsc-adapter       e_tsc_adapter
etape tests-racine      e_tests_racine
etape tests-adapter     e_tests_adapter
etape lot-063           e_lot063
etape archives-livrables e_archives_livrables
etape installation-archives e_installation_archives
bilan ""
bilan "Archives d'origine (vérifiées, sha512 = origine/INTEGRITE-*) :"
for f in "$W"/origine/*.tgz; do bilan "  $(sha256sum "$f" | sed "s#  $W/origine/#  #")"; done
bilan "Correctifs reconstruits par fabriquer.sh (identiques au commit) :"
while IFS= read -r l; do bilan "  $l"; done < "$SRC/adapter/voie1/paquets/SHA256SUMS"
bilan "Archives livrables (npm pack depuis le clone) :"
while IFS= read -r l; do bilan "  $l"; done < "$SORTIE/archives/SHA256SUMS"
bilan "Installation des archives (HOME et cache npm vierges) :"
while IFS= read -r l; do bilan "  $l"; done < <(grep -E '^(OK|ÉCHEC)' "$(ls "$SORTIE"/*-installation-archives.log)")
bilan "Tests et lot-063 :"
while IFS= read -r l; do bilan "  $l"; done < "$W/lot063.txt"
bilan ""
bilan "RÉSULTAT : toutes les étapes ont réussi."
echo; cat "$BILAN"
