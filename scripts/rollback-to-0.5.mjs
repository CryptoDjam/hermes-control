#!/usr/bin/env node
// Retour arrière 0.6.x → 0.5.0 — LECTURE SEULE par défaut (voir README, section « Rollback »).
//
// La 0.5.0 choisit le profil d'un agent PAR SON NOM à chaque passage ; elle ignore assignments.json. Ce script simule sa
// règle sur les instances présentes pour CHAQUE agent hermes_local de TOUTES les entreprises (affecté ou non), d'après un
// export des agents Paperclip OBLIGATOIRE et contrôlé (scripts/export-agents.mjs : forme, doublons, type et entreprise
// présents, nombre d'agents par entreprise, agents de la table tous présents, fraîcheur), et donne un verdict :
//   - COMPATIBLE : chaque agent affecté retomberait sur son profil, aucun agent non affecté ne serait retrouvé par le nom
//     → `--apply` écrit la carte plate 0.5 (agents.json) dérivée de la table, après sauvegarde ; assignments.json est
//     conservé (retour en 0.6.x possible) ;
//   - INCOMPATIBLE (export absent / incomplet / périmé, homonyme résolu ailleurs, agent renommé, agent NON affecté que la
//     0.5 ferait tourner…) : `--apply` est REFUSÉ (message, code 2) ; seule une restauration complète depuis la sauvegarde
//     à froid prise avant la 0.6 est sûre.
// Préparer et appliquer MUTATIONS ARRÊTÉES : pas de création / renommage d'agent ni d'action du plugin entre l'export et
// la réinstallation. Rien n'est installé : les commandes de paquets sont affichées, l'administrateur les lance.
//
// Usage :
//   node scripts/rollback-to-0.5.mjs --agents FICHIER [--max-age-minutes N] [--json] [--apply]
//     --agents FICHIER       export produit par scripts/export-agents.mjs (OBLIGATOIRE)
//     --max-age-minutes N    âge maximal de l'export (défaut 30)
// Codes de sortie : 0 compatible (et --apply écrit) ; 2 incompatible ou --apply refusé ; 3 prérequis manquant ; 4 option invalide.
// Prérequis : `npm run build` (importe dist/lib.js).
import { access, readFile } from "node:fs/promises";
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
let exportData = null;
let exportFile = null;
let json = false;
let apply = false;
let maxAgeMinutes = lib.DEFAULT_EXPORT_MAX_AGE_MINUTES;
const fail = (msg, code) => { console.error(msg); process.exit(code); };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--agents") {
    exportFile = args[++i];
    if (!exportFile) fail("--agents : fichier manquant", 4);
    try {
      exportData = JSON.parse(await readFile(exportFile, "utf8"));
    } catch (e) {
      fail(`export ${exportFile} illisible ou JSON invalide : ${e instanceof Error ? e.message : String(e)} — rien n'est écrit`, 2);
    }
  } else if (a === "--max-age-minutes") {
    maxAgeMinutes = Number(args[++i]);
    if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) fail("--max-age-minutes : nombre de minutes positif attendu", 4);
  } else if (a === "--json") json = true;
  else if (a === "--apply") apply = true;
  else if (a === "-h" || a === "--help") { console.log((await readFile(fileURLToPath(import.meta.url), "utf8")).split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n")); process.exit(0); }
  else fail(`option inconnue : ${a} (voir --help)`, 4);
}

const plan = await lib.planRollback({ exportData, maxAgeMinutes });
if (json) console.log(JSON.stringify(plan, null, 2));
else {
  console.log(`# Retour arrière 0.6.x → 0.5.0 — ${apply ? "apply" : "lecture seule"}`);
  console.log(lib.describeReference(await lib.referenceInfo()));
  console.log(`table : ${plan.table.file} (${plan.table.exists ? "présente" : "absente"}${plan.table.error ? `, REFUSÉE : ${plan.table.error}` : ""})`);
  console.log(`projection : ${plan.projection.file}${plan.projection.error ? ` — ${plan.projection.error}` : ""}`);
  console.log(`sauvegardes trouvées : ${plan.backups.join(", ") || "aucune"}`);
  const c = plan.coverage;
  console.log(`export : ${exportFile ?? "ABSENT"} — collecté ${c.collectedAt ?? "?"} (il y a ${c.ageMinutes ?? "?"} min) ; ${c.companies} entreprise(s), ${c.agents} agent(s) dont ${c.hermesAgents} hermes_local ; table : ${c.assignedInTable} affectation(s), ${c.assignedFoundInExport} retrouvée(s) dans l'export`);
  console.log("");
  for (const a of plan.agents) console.log(`  ${a.verdict === "identique" || a.verdict === "non-affecte-sans-profil" ? "OK " : "KO "} « ${a.name} » (${a.agentId}, entreprise ${a.companyId}) : ${a.assigned ? `affecté ${a.assigned}` : "NON affecté"} ; 0.5 → ${a.under05 ?? "AUCUN profil"}${a.by ? ` (${a.by})` : ""} [${a.verdict}]`);
  console.log("");
  console.log(plan.compatible ? "VERDICT : retour en 0.5 compatible avec l'inventaire complet des agents hermes_local." : `VERDICT : retour propre en 0.5 IMPOSSIBLE (${plan.blockers.length}) :`);
  for (const b of plan.blockers) console.log(`  - ${b}`);
  for (const w of plan.warnings) console.log(`  (avertissement) ${w}`);
  if (!plan.compatible) console.log("  → restauration complète depuis la sauvegarde à froid prise avant la 0.6 (README, « Rollback »).");
  console.log("");
  console.log("Commandes de paquets (à lancer par l'administrateur) :");
  for (const c2 of plan.commands) console.log(`  ${c2}`);
}
if (!apply) process.exit(plan.compatible ? 0 : 2);
try {
  const r = await lib.applyRollback(plan);
  console.log(`agents.json (carte 0.5) écrit : ${r.written} ; sauvegardes : ${r.backups.join(", ") || "aucune"}`);
} catch (e) {
  if (e instanceof lib.RollbackRefused) {
    console.error(`--apply REFUSÉ : ${plan.blockers.length} blocage(s) ci-dessus ; rien n'est écrit (agents.json et assignments.json intacts).`);
    process.exit(2);
  }
  throw e;
}
