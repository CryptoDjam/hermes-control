#!/usr/bin/env node
// Export des agents Paperclip pour le retour arrière (scripts/rollback-to-0.5.mjs) — LECTURE SEULE.
//
// COLLECTE : GET <api>/companies (toutes les entreprises visibles), puis pour chacune GET <api>/companies/<id>/agents.
// À lancer par un ADMINISTRATEUR D'INSTANCE (ou en local_trusted) : un utilisateur limité ne voit pas toutes les
// entreprises ni tous les agents, et l'export serait incomplet sans que l'API le signale. L'API exclut les agents
// « terminated » (ils ne redémarrent pas). Seuls id, nom, entreprise, type d'adaptateur, statut et hermesCommand sont
// gardés (aucun autre champ de configuration, aucun secret).
// COUVERTURE (contrôlée par le script de retour arrière) : chaque entreprise porte agentCount = nombre d'agents reçus de
// l'API ; doublons, champs manquants, entreprises ou agents de la table absents et fraîcheur (collectedAt) sont vérifiés.
// Contre-vérification possible, base arrêtée en écriture : SELECT id, name, company_id, adapter_type, status FROM agents
// (sans autre colonne) — à comparer avec l'export.
//
// Usage :
//   node scripts/export-agents.mjs --api http://127.0.0.1:3100/api [--token-file FICHIER] [--out FICHIER]
//     --token-file : jeton d'API Paperclip (board) lu dans un fichier, jamais affiché ; inutile en local_trusted.
import { readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
let api = null;
let tokenFile = null;
let out = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--api") api = args[++i];
  else if (a === "--token-file") tokenFile = args[++i];
  else if (a === "--out") out = args[++i];
  else if (a === "-h" || a === "--help") { console.log((await readFile(new URL(import.meta.url), "utf8")).split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n")); process.exit(0); }
  else { console.error(`option inconnue : ${a}`); process.exit(4); }
}
if (!api) { console.error("--api requis (ex. http://127.0.0.1:3100/api)"); process.exit(4); }
const headers = { accept: "application/json" };
if (tokenFile) headers.authorization = `Bearer ${(await readFile(tokenFile, "utf8")).trim()}`;
async function get(path) {
  const r = await fetch(`${api.replace(/\/$/, "")}${path}`, { headers });
  if (!r.ok) throw new Error(`GET ${path} : HTTP ${r.status} — export interrompu, rien n'est écrit`);
  return r.json();
}
const companiesRaw = await get("/companies");
const companiesList = Array.isArray(companiesRaw) ? companiesRaw : Array.isArray(companiesRaw?.companies) ? companiesRaw.companies : null;
if (!companiesList) { console.error("réponse /companies inattendue — rien n'est écrit"); process.exit(2); }
const companies = [];
const agents = [];
for (const c of companiesList) {
  const list = await get(`/companies/${encodeURIComponent(c.id)}/agents`);
  if (!Array.isArray(list)) { console.error(`réponse /companies/${c.id}/agents inattendue — rien n'est écrit`); process.exit(2); }
  companies.push({ id: c.id, name: c.name ?? c.id, agentCount: list.length });
  for (const a of list) {
    const cmd = a?.adapterConfig && typeof a.adapterConfig.hermesCommand === "string" ? a.adapterConfig.hermesCommand : null;
    agents.push({ id: a.id, name: a.name, companyId: a.companyId ?? c.id, adapterType: a.adapterType ?? null, status: a.status ?? null, hermesCommand: cmd });
  }
}
const data = { kind: "hermes-control/agents-export", version: 1, collectedAt: new Date().toISOString(), source: { api, method: "GET /companies + GET /companies/:id/agents" }, companies, agents };
const text = JSON.stringify(data, null, 2) + "\n";
if (out) {
  await writeFile(out, text, { mode: 0o600 });
  console.error(`export écrit : ${out} — ${companies.length} entreprise(s), ${agents.length} agent(s), dont ${agents.filter((a) => a.adapterType === "hermes_local").length} hermes_local`);
} else process.stdout.write(text);
