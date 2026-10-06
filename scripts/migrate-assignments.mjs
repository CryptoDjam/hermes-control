#!/usr/bin/env node
// Migration des affectations existantes vers la table explicite assignments.json (0.6.1) — LECTURE SEULE par défaut.
//
// Construit, à partir de l'ancienne carte agents.json (format plat 0.4–0.5, ou projection) et des instances découvertes,
// un tableau : companyId, agentId, nom, instance, profil réel, HERMES_HOME qui sera transmis, compte modèle (libellé, jamais
// de secret), chemin de socket. AUCUN LANCEUR N'EST EXÉCUTÉ NI LU POUR AUTORISER : les dossiers bin/ sont inventoriés
// (chemin, empreinte) ; les fichiers étrangers aux lanceurs sont ignorés ; un lanceur RÉFÉRENCÉ par un agent (d'après
// l'export Paperclip --agent-commands) bloque --apply tant qu'une correspondance explicite n'est pas donnée (--confirm).
// N'écrit RIEN sans `--apply` ; avec `--apply`, refuse s'il reste un désaccord, sauvegarde les fichiers existants
// (assignments.json.bak-<date>, agents.json.bak-<date>) puis écrit la table (validée) et sa projection.
//
// Usage :
//   node scripts/migrate-assignments.mjs [options]
//     --map FILE                    carte à migrer (défaut : <référence>/agents.json, référence = <compte>/.config/hermes-control)
//     --launchers DIR[,DIR]         dossiers à inventorier (défaut : <racine>/../bin pour chaque racine configurée)
//     --agent-commands FILE         export des agents Paperclip (JSON : { agentId: hermesCommand } ou liste d'agents avec adapterConfig)
//     --confirm ID=INSTANCE:PROFIL  correspondance explicite d'un agent (répétable) ; validée contre instances et profils
//     --paperclip-data DIR          dossier data de Paperclip : run-logs/<companyId>/<agentId> donnent l'entreprise
//     --company-id ID               entreprise de tous les agents (quand il n'y en a qu'une)
//     --companies a=c,a=c           entreprise par agent (prioritaire)
//     --company-name ID=NOM         nom d'affichage d'une entreprise (répétable)
//     --hermes-binary PATH          point d'entrée Hermes administré (chemin absolu ; vérifié, jamais exécuté)
//     --hermes-link-target PATH     si --hermes-binary est un lien : sa cible réelle (notée et autorisée)
//     --execution-root INST=RACINE  racine d'exécution littérale (courte, ~/ accepté) d'une instance (répétable)
//     --json                        sortie JSON seulement
//     --apply                       ÉCRIT la table (sinon rien n'est écrit)
// Prérequis : `npm run build` (importe dist/lib.js, le même code que le plugin et l'adaptateur).
import { access, copyFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const libPath = join(here, "..", "dist", "lib.js");
try {
  await access(libPath);
} catch {
  console.error(`dist/lib.js absent : lance \`npm run build\` dans ${resolve(here, "..")} d'abord.`);
  process.exit(3);
}
const lib = await import(libPath);

const args = process.argv.slice(2);
const opt = { map: null, launcherDirs: [], paperclipData: null, companyId: null, companies: {}, companyNames: {}, agentCommands: null, confirm: {}, hermes: null, executionRoots: {} };
let json = false;
let apply = false;
let linkTarget = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => {
    if (i + 1 >= args.length) throw new Error(`valeur manquante pour ${a}`);
    return args[++i];
  };
  if (a === "--map") opt.map = next();
  else if (a === "--launchers") opt.launcherDirs.push(...next().split(",").map((s) => s.trim()).filter(Boolean));
  else if (a === "--agent-commands") opt.agentCommands = lib.parseAgentCommands(JSON.parse(await readFile(next(), "utf8")));
  else if (a === "--confirm") { const c = lib.parseConfirm(next()); if (!c) throw new Error(`--confirm attend ID=/instance/absolue:profil`); opt.confirm[c.agentId] = { instanceHome: c.instanceHome, profile: c.profile }; }
  else if (a === "--paperclip-data") opt.paperclipData = next();
  else if (a === "--company-id") opt.companyId = next();
  else if (a === "--companies") for (const pair of next().split(",")) { const [ag, co] = pair.split("="); if (ag && co) opt.companies[ag.trim()] = co.trim(); }
  else if (a === "--company-name") { const v = next(); const idx = v.indexOf("="); if (idx > 0) opt.companyNames[v.slice(0, idx)] = v.slice(idx + 1); }
  else if (a === "--hermes-binary") opt.hermes = { binary: next() };
  else if (a === "--hermes-link-target") linkTarget = next();
  else if (a === "--execution-root") { const v = next(); const idx = v.indexOf("="); if (idx <= 0) throw new Error("--execution-root attend INSTANCE=RACINE"); opt.executionRoots[v.slice(0, idx)] = v.slice(idx + 1); }
  else if (a === "--approved-binary") throw new Error("--approved-binary n'existe plus (0.6.1) : utilise --hermes-binary /chemin/absolu/du/point/d'entrée");
  else if (a === "--json") json = true;
  else if (a === "--apply") apply = true;
  else if (a === "-h" || a === "--help") { console.log((await readFile(fileURLToPath(import.meta.url), "utf8")).split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n")); process.exit(0); }
  else throw new Error(`option inconnue : ${a}`);
}
if (linkTarget) {
  if (!opt.hermes) throw new Error("--hermes-link-target sans --hermes-binary");
  opt.hermes.linkTarget = linkTarget;
}

const legacy = lib.legacyEnvRefusal();
const r = await lib.planMigration(opt);
if (legacy) r.disagreements.unshift(legacy);
const ref = lib.describeReference(await lib.referenceInfo());
const now = new Date().toISOString();
if (json) console.log(JSON.stringify({ mode: apply ? "apply" : "lecture seule", reference: ref, ...r }, null, 2));
else {
  console.log(`# Migration des affectations (0.6.1) — ${apply ? "apply" : "lecture seule"} — ${now}`);
  console.log(ref);
  console.log(`carte lue : ${r.map.file} (${r.map.kind}, ${r.map.entries} entrée(s))`);
  console.log(`racines configurées : ${r.roots.join(", ") || "aucune"} ; racines connues (réelles) : ${r.knownRoots.join(", ") || "aucune"}`);
  console.log(`instances découvertes : ${r.instances.join(", ") || "aucune"}`);
  console.log(`binaire administré : ${r.binary.description ?? (r.binary.error ? `REFUSÉ — ${r.binary.error}` : "aucun")}`);
  console.log(`lanceurs inventoriés (jamais exécutés ni lus pour autoriser) : ${r.launchers.length} dans ${r.launcherDirs.join(", ") || "aucun dossier"} ; fichiers étrangers ignorés : ${r.foreignFiles.length}`);
  for (const l of r.launchers) console.log(`  - ${l.path} sha256 ${l.sha256.slice(0, 16)}… ${l.referencedBy.length ? `RÉFÉRENCÉ par ${l.referencedBy.join(", ")}` : "non référencé"}`);
  console.log("");
  for (const row of r.rows) {
    console.log(`## ${row.name}`);
    console.log(`  companyId          : ${row.companyId ?? "INCONNU"}`);
    console.log(`  agentId            : ${row.agentId}`);
    console.log(`  instance           : ${row.instance} (${row.instanceHome})`);
    console.log(`  profil             : ${row.profile} → ${row.profileHome} (${row.source})`);
    console.log(`  profil réel        : ${row.profileReal}`);
    console.log(`  hermesCommand      : ${row.command ?? "—"}${row.launcherReferenced ? " (LANCEUR RÉFÉRENCÉ : ignoré à l'exécution depuis 0.6.1)" : ""}`);
    console.log(`  HERMES_HOME transmis : ${row.executionHome}`);
    console.log(`  compte modèle      : ${row.account}`);
    console.log(`  socket (max, octets): ${row.socketBytes} ${row.socketBytes > lib.SOCKET_PATH_MAX ? `> ${lib.SOCKET_PATH_MAX} : REFUS au démarrage` : `≤ ${lib.SOCKET_PATH_MAX}`}`);
    if (row.problems.length) console.log(`  DÉSACCORD          : ${row.problems.join(" ; ")}`);
    console.log("");
  }
  console.log(`## Désaccords (${r.disagreements.length})`);
  for (const d of r.disagreements) console.log(`  - ${d}`);
  console.log(`## Avertissements (${r.warnings.length})`);
  for (const w of r.warnings) console.log(`  - ${w}`);
  console.log(`## Notes (${r.notes.length})`);
  for (const n of r.notes) console.log(`  - ${n}`);
  console.log("");
  console.log(`## Table proposée (${r.target})`);
  console.log(JSON.stringify(r.proposedTable, null, 2));
}

if (!apply) {
  if (!json) console.log(`\nLecture seule : rien n'est écrit. Pour écrire : relance avec --apply (refusé tant qu'il reste un désaccord).`);
  process.exit(r.disagreements.length ? 2 : 0);
}
if (r.disagreements.length) {
  console.error(`\n--apply refusé : ${r.disagreements.length} désaccord(s) à régler d'abord.`);
  process.exit(2);
}
const stamp = now.replace(/[:.]/g, "-");
for (const f of [r.target, r.projection]) {
  try {
    await copyFile(f, `${f}.bak-${stamp}`);
    console.log(`sauvegarde : ${f}.bak-${stamp}`);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
await lib.replaceTable(r.proposedTable, { roots: r.knownRoots });
console.log(`table écrite : ${r.target} ; projection : ${r.projection}`);
