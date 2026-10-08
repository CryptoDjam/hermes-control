#!/bin/bash
# Vérifie que les deux archives livrables de Hermes Control s'installent et s'importent comme depuis npm, sans rien du poste :
#   HOME, cache npm et configuration npm VIERGES (dossier temporaire, distinct de tout cache de construction) ; projet fictif ;
#   `npm install <plugin.tgz> <adaptateur.tgz>` (dépendances tirées du registre, aucun fichier local hors des deux archives) ;
#   contrôles : aucune dépendance `file:` ni archive embarquée dans les paquets installés ; l'adaptateur s'importe PAR SON NOM
#   (createServerAdapter().type = hermes_local, copies corrigées voie 1 intégrées : voie1Status().ok, URL #bundle:) ;
#   le manifeste du plugin s'importe (id hermes-control, version = package.json) ; `npm ls` sans erreur.
#   Puis HORS LIGNE (0.7.0) : autre projet, autre HOME, cache npm VIDE et registre INJOIGNABLE (127.0.0.1:9) : l'installation
#   des deux archives doit réussir (aucune dépendance à tirer) et les mêmes imports aussi.
# Usage : scripts/verifier-installation.sh [--registre URL] <dossier contenant les deux .tgz>
# Code ≠ 0 au premier contrôle en erreur. Réseau requis (registre npm) pour les dépendances du plugin.
set -euo pipefail
REGISTRE="https://registry.npmjs.org/"
[ "${1:-}" = "--registre" ] && { REGISTRE=$2; shift 2; }
[ $# -eq 1 ] || { echo "usage : $0 [--registre URL] <dossier des archives>" >&2; exit 2; }
D=$(cd "$1" && pwd)
PLUGIN=$(ls "$D"/cyberservices-ai-paperclip-plugin-hermes-control-*.tgz)
ADAPT=$(ls "$D"/cyberservices-ai-paperclip-adapter-hermes-control-*.tgz)
[ "$(echo "$PLUGIN" | wc -l)" = 1 ] && [ "$(echo "$ADAPT" | wc -l)" = 1 ] || { echo "une archive de chaque attendue dans $D"; exit 2; }

W=$(mktemp -d "${TMPDIR:-/tmp}/verifier-installation.XXXXXX"); trap 'rm -rf "$W"' EXIT
mkdir -p "$W/home" "$W/cache" "$W/projet"
: > "$W/home/.npmrc"; : > "$W/npmrc-global"
# environnement vide : seul PATH est gardé (node/npm), rien d'autre du poste
run() { env -i PATH="$PATH" HOME="${H:-$W/home}" TMPDIR="${TMPDIR:-/tmp}" npm_config_cache="${C:-$W/cache}" npm_config_userconfig="$W/home/.npmrc" \
  npm_config_globalconfig="$W/npmrc-global" npm_config_registry="${R:-$REGISTRE}" npm_config_audit=false npm_config_fund=false \
  npm_config_update_notifier=false npm_config_fetch_retries=0 npm_config_fetch_timeout=5000 "$@"; }
cp "$PLUGIN" "$ADAPT" "$W/"
cd "$W/projet"
printf '{ "name": "projet-fictif", "version": "1.0.0", "private": true, "type": "module" }\n' > package.json
echo "== cache npm vierge : $(find "$W/cache" -type f | wc -l) fichier(s)"
run npm install --ignore-scripts "$W/$(basename "$PLUGIN")" "$W/$(basename "$ADAPT")"
run npm ls --all > "$W/npm-ls.txt" || { cat "$W/npm-ls.txt"; echo "npm ls en erreur"; exit 1; }
echo "== npm ls : $(grep -c . "$W/npm-ls.txt") ligne(s), sans erreur"
run node --input-type=commonjs - <<'JS'
const fs = require("fs"), path = require("path");
const nm = path.join(process.cwd(), "node_modules", "@cyberservices-ai");
let ko = 0; const ok = (c, m) => { console.log(`${c ? "OK   " : "ÉCHEC"} ${m}`); if (!c) ko++; };
for (const n of ["paperclip-plugin-hermes-control", "paperclip-adapter-hermes-control"]) {
  const j = JSON.parse(fs.readFileSync(path.join(nm, n, "package.json"), "utf8"));
  const deps = { ...j.dependencies, ...j.optionalDependencies, ...j.peerDependencies };
  ok(!Object.values(deps).some((v) => /^(file|link):/.test(String(v))), `${j.name}@${j.version} : aucune dépendance file:/link: (${Object.keys(deps).join(", ") || "aucune dépendance"})`);
  const tgz = []; (function f(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory() && e.name !== "node_modules") f(p); else if (e.name.endsWith(".tgz")) tgz.push(p); } })(path.join(nm, n));
  ok(tgz.length === 0, `${n} : aucune archive embarquée`);
}
process.exit(ko ? 1 : 0);
JS
cat > "$W/projet/import.mjs" <<'JS'
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
let ko = 0; const ok = (c, m) => { console.log(`${c ? "OK   " : "ÉCHEC"} ${m}`); if (!c) ko++; };
const a = await import("@cyberservices-ai/paperclip-adapter-hermes-control");
const ad = a.createServerAdapter(); const v = a.voie1Status();
ok(ad.type === "hermes_local", `adaptateur importé par son nom : type ${ad.type}`);
ok(v.ok && /#bundle:@paperclipai\/adapter-utils@/.test(v.adapterUtilsUrl ?? ""), `copies corrigées intégrées : ${v.hermes} ; ${v.adapterUtils} ; ${v.adapterUtilsUrl}`);
const req = createRequire(import.meta.url);
const pdir = dirname(req.resolve("@cyberservices-ai/paperclip-plugin-hermes-control/package.json"));
const pj = JSON.parse(readFileSync(join(pdir, "package.json"), "utf8"));
const m = (await import(pathToFileURL(join(pdir, pj.paperclipPlugin.manifest)).href)).default;
ok(m.id === "hermes-control" && m.version === pj.version, `manifeste du plugin : id ${m.id}, version ${m.version} (package ${pj.name}@${pj.version})`);
const ui = join(pdir, pj.paperclipPlugin.ui, "index.js"), worker = join(pdir, pj.paperclipPlugin.worker);
ok(readFileSync(worker).length > 0 && readFileSync(ui).length > 0, "worker et UI du plugin présents");
const lib = await import(pathToFileURL(join(pdir, "dist", "lib.js")).href);
ok(Object.keys(lib).length > 0, `dist/lib.js du plugin importé (${Object.keys(lib).length} exports)`);
process.exit(ko ? 1 : 0);
JS
run node import.mjs
echo "== installation et import vérifiés depuis un HOME et un cache npm vierges"

# ---- hors ligne : cache vide + registre injoignable ----
export H="$W/home-hl" C="$W/cache-hl" R="http://127.0.0.1:9/"
mkdir -p "$H" "$C" "$W/projet-hl"
cp "$W/projet/package.json" "$W/projet/import.mjs" "$W/projet-hl/"
cd "$W/projet-hl"
echo "== HORS LIGNE : cache npm vide ($(find "$C" -type f | wc -l) fichier(s)), registre injoignable $R"
run npm install --ignore-scripts "$W/$(basename "$PLUGIN")" "$W/$(basename "$ADAPT")"
run npm ls --all > "$W/npm-ls-hl.txt" || { cat "$W/npm-ls-hl.txt"; echo "npm ls en erreur (hors ligne)"; exit 1; }
echo "== npm ls hors ligne : $(grep -c . "$W/npm-ls-hl.txt") ligne(s), sans erreur"
[ "$(ls node_modules | tr '\n' ' ')" = "@cyberservices-ai " ] && [ "$(ls node_modules/@cyberservices-ai | wc -l)" = 2 ] \
  || { ls -R node_modules | head -20; echo "paquets inattendus installés hors ligne"; exit 1; }
echo "== hors ligne : seuls les deux paquets Hermes Control sont installés"
run node import.mjs
echo "== installation et import vérifiés HORS LIGNE (cache vide, registre injoignable)"
