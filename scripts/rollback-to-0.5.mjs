#!/usr/bin/env node
// Retour arrière 0.6.1 → 0.5.0 — LECTURE SEULE par défaut (voir README, section « Rollback »).
//
// La 0.5.0 choisit le profil d'un agent PAR SON NOM à chaque passage ; elle ignore assignments.json. Ce script simule sa
// règle sur les instances présentes pour chaque agent de la table et donne un verdict :
//   - COMPATIBLE : chaque agent retomberait sur son profil affecté → `--apply` écrit la carte plate 0.5 (agents.json)
//     dérivée de la table (pour les skills), après sauvegarde ; assignments.json est conservé (retour en 0.6.1 possible) ;
//   - INCOMPATIBLE (homonyme résolu ailleurs, agent renommé sans profil de son nouveau nom…) : `--apply` est REFUSÉ ;
//     seule une restauration complète depuis la sauvegarde à froid prise avant la 0.6.1 est sûre.
// Rien n'est installé : les commandes de paquets sont affichées, l'administrateur les lance.
//
// Usage :
//   node scripts/rollback-to-0.5.mjs [--agents FICHIER] [--json] [--apply]
//     --agents FICHIER   export des agents Paperclip (JSON : liste d'agents { id, name } ou { agents: [...] }) pour les noms ACTUELS
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
let agentNames = null;
let json = false;
let apply = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--agents") {
    const raw = JSON.parse(await readFile(args[++i], "utf8"));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.agents) ? raw.agents : [];
    agentNames = Object.fromEntries(list.filter((x) => typeof x?.id === "string" && typeof x?.name === "string").map((x) => [x.id, x.name]));
  } else if (a === "--json") json = true;
  else if (a === "--apply") apply = true;
  else if (a === "-h" || a === "--help") { console.log((await readFile(fileURLToPath(import.meta.url), "utf8")).split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n")); process.exit(0); }
  else throw new Error(`option inconnue : ${a}`);
}

const plan = await lib.planRollback({ agentNames });
if (json) console.log(JSON.stringify(plan, null, 2));
else {
  console.log(`# Retour arrière 0.6.1 → 0.5.0 — ${apply ? "apply" : "lecture seule"}`);
  console.log(lib.describeReference(await lib.referenceInfo()));
  console.log(`table : ${plan.table.file} (${plan.table.exists ? "présente" : "absente"}${plan.table.error ? `, REFUSÉE : ${plan.table.error}` : ""})`);
  console.log(`projection : ${plan.projection.file}${plan.projection.error ? ` — ${plan.projection.error}` : ""}`);
  console.log(`sauvegardes trouvées : ${plan.backups.join(", ") || "aucune"}`);
  console.log("");
  for (const a of plan.agents) console.log(`  ${a.verdict === "identique" ? "OK " : "KO "} « ${a.name} » (${a.agentId}, nom ${a.nameSource}) : affecté ${a.assigned} ; 0.5 → ${a.under05 ?? "AUCUN profil"}${a.by ? ` (${a.by})` : ""}`);
  console.log("");
  console.log(plan.compatible ? "VERDICT : retour en 0.5 compatible avec les affectations actuelles." : `VERDICT : retour propre en 0.5 IMPOSSIBLE (${plan.blockers.length}) :`);
  for (const b of plan.blockers) console.log(`  - ${b}`);
  if (!plan.compatible) console.log("  → restauration complète depuis la sauvegarde à froid prise avant la 0.6.1 (README, « Rollback »).");
  console.log("");
  console.log("Commandes de paquets (à lancer par l'administrateur) :");
  for (const c of plan.commands) console.log(`  ${c}`);
}
if (!apply) process.exit(plan.compatible ? 0 : 2);
const r = await lib.applyRollback(plan);
console.log(`agents.json (carte 0.5) écrit : ${r.written} ; sauvegardes : ${r.backups.join(", ") || "aucune"}`);
