#!/usr/bin/env node
// Migration des affectations existantes vers la table explicite assignments.json — LECTURE SEULE par défaut.
//
// Construit, à partir de l'ancienne carte agents.json (format plat 0.4–0.6.0, ou projection), des lanceurs et des instances
// découvertes, un tableau : companyId, agentId, nom, instance, profil réel, lanceur, HERMES_HOME lu statiquement, binaire,
// libellé du compte modèle (jamais de valeur de secret). Signale tout désaccord. Propose la table assignments.json.
// N'écrit RIEN sans `--apply` ; avec `--apply`, refuse s'il reste un désaccord, sauvegarde les fichiers existants
// (assignments.json.bak-<date>, agents.json.bak-<date>) puis écrit la table (validée) et sa projection.
//
// Usage :
//   node scripts/migrate-assignments.mjs [options]
//     --map FILE               carte à migrer (défaut : $HERMES_CONTROL_AGENTS_MAP ou ~/.config/hermes-control/agents.json)
//     --launchers DIR[,DIR]    dossiers de lanceurs (défaut : <racine>/../bin pour chaque racine configurée, s'il existe)
//     --paperclip-data DIR     dossier data de Paperclip : les noms de dossiers run-logs/<companyId>/<agentId> donnent l'entreprise
//     --company-id ID          entreprise de tous les agents (quand il n'y en a qu'une)
//     --companies a=c,a=c      entreprise par agent (prioritaire)
//     --company-name ID=NOM    nom d'affichage d'une entreprise (répétable)
//     --approved-binary PATH   binaire Hermes approuvé comme hermesCommand (répétable)
//     --json                   sortie JSON seulement
//     --apply                  ÉCRIT la table (sinon rien n'est écrit)
// Prérequis : `npm run build` (importe dist/lib.js, les mêmes fonctions que le plugin et l'adaptateur).
import { access, copyFile, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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

/* ---------- arguments ---------- */
const args = process.argv.slice(2);
const opt = { map: null, launchers: [], paperclipData: null, companyId: null, companies: {}, companyNames: {}, approved: [], json: false, apply: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => {
    if (i + 1 >= args.length) throw new Error(`valeur manquante pour ${a}`);
    return args[++i];
  };
  if (a === "--map") opt.map = next();
  else if (a === "--launchers") opt.launchers.push(...next().split(",").map((s) => s.trim()).filter(Boolean));
  else if (a === "--paperclip-data") opt.paperclipData = next();
  else if (a === "--company-id") opt.companyId = next();
  else if (a === "--companies") for (const pair of next().split(",")) { const [ag, co] = pair.split("="); if (ag && co) opt.companies[ag.trim()] = co.trim(); }
  else if (a === "--company-name") { const v = next(); const idx = v.indexOf("="); if (idx > 0) opt.companyNames[v.slice(0, idx)] = v.slice(idx + 1); }
  else if (a === "--approved-binary") opt.approved.push(resolve(next()));
  else if (a === "--json") opt.json = true;
  else if (a === "--apply") opt.apply = true;
  else if (a === "-h" || a === "--help") { console.log(await readFile(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n")); process.exit(0); }
  else throw new Error(`option inconnue : ${a}`);
}

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
const realOrNull = async (p) => { try { return await realpath(p); } catch { return null; } };
const disagreements = [];
const warnings = [];
const notes = [];

/* ---------- 1. l'ancienne carte ---------- */
const mapFile = opt.map ? resolve(opt.map) : lib.agentsMapFile();
let legacy = {};
let mapKind = "absente";
try {
  const parsed = JSON.parse(await readFile(mapFile, "utf8"));
  if (parsed && typeof parsed === "object" && parsed.schemaVersion === 1 && parsed.agents) {
    mapKind = `projection (derivedFrom ${parsed.derivedFrom?.sha256?.slice(0, 12) ?? "?"})`;
    for (const [id, a] of Object.entries(parsed.agents)) legacy[id] = { name: a.name, home: a.home, instance: a.instance, profile: a.profile, at: a.at, companyId: a.companyId };
  } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    mapKind = "format plat (0.4–0.6.0, produite par le nom : à ne pas convertir aveuglément)";
    for (const [id, a] of Object.entries(parsed)) if (a && typeof a === "object" && typeof a.home === "string") legacy[id] = { name: a.name, home: a.home, instance: a.instance, profile: a.profile, at: a.at, companyId: null };
  } else disagreements.push(`carte ${mapFile} : contenu inattendu`);
} catch (e) {
  if (e.code !== "ENOENT") disagreements.push(`carte ${mapFile} illisible : ${e.message}`);
}

/* ---------- 2. instances découvertes et racines connues ---------- */
const roots = await lib.knownRoots();
const configured = await lib.configuredRoots();
const instances = await lib.instanceHomes();
const instancesReal = new Map();
for (const h of instances) instancesReal.set((await realOrNull(h)) ?? h, h);

/* ---------- 3. lanceurs ---------- */
const launcherDirs = [...opt.launchers.map((d) => resolve(d))];
for (const r of configured) {
  const bin = resolve(r, "..", "bin");
  if ((await exists(bin)) && !launcherDirs.includes(bin)) launcherDirs.push(bin);
}
const launchers = [];
for (const dir of launcherDirs) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { warnings.push(`dossier de lanceurs illisible : ${dir}`); continue; }
  for (const e of entries) {
    if (!e.isFile() && !e.isSymbolicLink()) continue;
    const path = join(dir, e.name);
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) continue;
    const r = await lib.homeFromLauncherFile(path);
    const text = await readFile(path, "utf8").catch(() => "");
    const binMatch = /HERMES_BIN="\$\{HERMES_BIN:-([^}]*)\}"/.exec(text);
    const binRaw = binMatch ? binMatch[1] : null;
    const binPath = binRaw ? binRaw.replace(/^\$HOME(?=\/|$)/, homedir()).replace(/^~(?=\/|$)/, homedir()) : null;
    const fallback = /HERMES_BIN="\$HOME\/\.local\/bin\/hermes"|command -v hermes/.test(text) ? "repli sur ~/.local/bin/hermes (ou PATH)" : null;
    launchers.push({ path, home: r.home, literal: r.literal ?? null, error: r.error, homeReal: r.home ? (await realOrNull(r.home)) ?? r.home : null, binary: binPath, binaryExists: binPath ? await exists(binPath) : null, binaryFallback: fallback, hasProjetcOverride: /\$\{PROJETC:-/.test(text) });
  }
}

/* ---------- 4. entreprise de chaque agent ---------- */
const companyOf = {};
const paperclipAgents = new Map(); // agentId → companyId (dossiers run-logs)
if (opt.paperclipData) {
  const runLogs = join(resolve(opt.paperclipData), "run-logs");
  try {
    for (const c of await readdir(runLogs, { withFileTypes: true })) {
      if (!c.isDirectory()) continue;
      for (const a of await readdir(join(runLogs, c.name), { withFileTypes: true })) if (a.isDirectory()) paperclipAgents.set(a.name, c.name);
    }
    notes.push(`Paperclip run-logs : ${paperclipAgents.size} agent(s) vus dans ${new Set(paperclipAgents.values()).size} entreprise(s) (${runLogs})`);
  } catch (e) {
    warnings.push(`run-logs Paperclip illisibles (${runLogs}) : ${e.message}`);
  }
}
for (const id of Object.keys(legacy)) {
  companyOf[id] = opt.companies[id] ?? legacy[id].companyId ?? opt.companyId ?? paperclipAgents.get(id) ?? null;
  if (!companyOf[id]) disagreements.push(`agent ${id} (« ${legacy[id].name} ») : companyId inconnu — donne --companies ${id}=<companyId>, --company-id ou --paperclip-data`);
}
for (const [id, co] of paperclipAgents) if (!legacy[id]) notes.push(`agent Paperclip ${id} (entreprise ${co}) sans entrée dans la carte : non migré (à affecter dans la page Hermes s'il est Hermes)`);

/* ---------- 5. compte modèle d'une instance (libellés seulement, jamais de valeur) ---------- */
async function modelAccount(instanceHome) {
  const { cfg, error } = await lib.readConfigStrict(instanceHome);
  const provider = cfg?.model?.provider ?? null;
  const model = cfg?.model?.default ?? null;
  let auth = "auth.json absent";
  try {
    const j = JSON.parse(await readFile(join(instanceHome, "auth.json"), "utf8"));
    const active = j.active_provider ?? provider ?? "?";
    const mode = j.providers?.[active]?.auth_mode ?? "?";
    const pool = Array.isArray(j.credential_pool?.[active]) ? j.credential_pool[active].length : 0;
    auth = `auth.json : ${active} (${mode}${pool ? `, ${pool} identifiant(s)` : ""})`;
  } catch (e) {
    if (e.code !== "ENOENT") auth = "auth.json illisible";
  }
  return { label: `${provider ?? "?"}/${model ?? "?"} · ${auth}`, configError: error };
}

/* ---------- 6. les lignes ---------- */
const rows = [];
const claims = new Map();
for (const [agentId, a] of Object.entries(legacy)) {
  const homeReal = (await realOrNull(a.home)) ?? a.home;
  const parts = homeReal.split("/");
  const isProfile = parts[parts.length - 2] === "profiles";
  const instanceHome = isProfile ? resolve(homeReal, "..", "..") : homeReal;
  const profile = isProfile ? parts[parts.length - 1] : "default";
  const row = { companyId: companyOf[agentId], agentId, name: a.name, instance: basename(instanceHome), instanceHome, profile, profileHome: homeReal, profileReal: null, launchers: [], launcherHome: null, binary: null, account: null, socketBytes: null, problems: [] };
  if (!instancesReal.has(instanceHome)) row.problems.push(`instance ${instanceHome} non découverte (racines : ${configured.join(", ")})`);
  const c = await lib.canonicalInstance(instanceHome, roots);
  if (c.error) row.problems.push(c.error);
  const usable = await lib.profileUsability(instanceHome, profile).catch((e) => e.message);
  if (!(await exists(join(homeReal, "config.yaml")))) { row.profileReal = "config.yaml ABSENT"; row.problems.push(`profil ${homeReal} sans config.yaml`); }
  else {
    const { error } = await lib.readConfigStrict(homeReal);
    row.profileReal = error ? `config.yaml INVALIDE (${error})` : usable ? `inutilisable : ${usable}` : "config.yaml présent et lisible";
    if (error) row.problems.push(`profil ${homeReal} : ${error}`);
    if (usable) row.problems.push(usable);
  }
  const matching = launchers.filter((l) => l.homeReal === homeReal);
  row.launchers = matching.map((l) => l.path);
  if (matching.length === 1) { row.launcherHome = matching[0].home; row.binary = `${matching[0].binary ?? "?"}${matching[0].binaryExists === false ? " (ABSENT)" : matching[0].binaryExists ? " (présent)" : ""}${matching[0].binaryFallback ? ` ; ${matching[0].binaryFallback}` : ""}`; if (matching[0].hasProjetcOverride) warnings.push(`${matching[0].path} : PROJETC forçable par l'environnement (\${PROJETC:-…}) ; la lecture statique suppose <lanceur>/../..`); }
  else if (matching.length === 0) row.problems.push("aucun lanceur ne mène à ce profil (lecture statique) : l'agent devra utiliser un binaire approuvé ou un lanceur corrigé");
  else row.problems.push(`${matching.length} lanceurs mènent à ce profil : ${matching.map((l) => l.path).join(", ")}`);
  const acc = await modelAccount(instanceHome);
  row.account = acc.label;
  // Hermes lie ses sockets sur le HERMES_HOME littéral du lanceur (un lien court vers une racine profonde suffit)
  const socketBase = matching.length === 1 && matching[0].literal ? matching[0].literal : homeReal;
  const sock = await lib.checkSocketPaths(socketBase);
  row.socketBytes = sock.socketPathBytes;
  if (!sock.socketPathOk) warnings.push(`${a.name} (${socketBase}) : chemin de socket le plus long = ${sock.socketPathBytes} octets > ${lib.SOCKET_PATH_MAX} (${sock.longest}) : l'adaptateur REFUSERA ce profil au démarrage`);
  const key = `${instanceHome}|${profile}`;
  claims.set(key, [...(claims.get(key) ?? []), agentId]);
  rows.push(row);
}
for (const [key, ids] of claims) if (ids.length > 1) for (const r of rows) if (ids.includes(r.agentId)) r.problems.push(`profil ${key.replace("|", "/")} revendiqué par ${ids.length} agents`);
for (const r of rows) for (const p of r.problems) disagreements.push(`${r.name} (${r.agentId}) : ${p}`);
for (const l of launchers) {
  if (l.error) disagreements.push(`lanceur ${l.path} : ${l.error}`);
  else if (!rows.some((r) => r.launchers.includes(l.path))) notes.push(`lanceur ${l.path} → ${l.home} : aucun agent de la carte ne l'utilise`);
}

/* ---------- 7. la table proposée ---------- */
const now = new Date().toISOString();
const table = lib.emptyTable();
for (const r of rows) {
  if (!r.companyId) continue;
  const co = (table.companies[r.companyId] ??= { name: opt.companyNames[r.companyId] ?? r.companyId, instances: [] });
  if (!co.instances.includes(r.instanceHome)) co.instances.push(r.instanceHome);
  table.agents[r.agentId] = { companyId: r.companyId, instanceHome: r.instanceHome, profile: r.profile, name: r.name, assignedAt: now, assignedBy: "migration" };
}
if (opt.approved.length) table.approvedBinaries = opt.approved;
const issues = Object.keys(table.agents).length ? await lib.relationalIssues(table, roots) : { companies: {}, agents: {} };
for (const [id, w] of Object.entries(issues.companies)) disagreements.push(`table proposée, entreprise ${id} : ${w}`);
for (const [id, w] of Object.entries(issues.agents)) disagreements.push(`table proposée, agent ${id} : ${w}`);

/* ---------- 8. sortie ---------- */
const report = { mode: opt.apply ? "apply" : "lecture seule", map: { file: mapFile, kind: mapKind, entries: Object.keys(legacy).length }, roots: configured, knownRoots: roots, instances, launcherDirs, rows, disagreements, warnings, notes, proposedTable: table, target: lib.assignmentsFile(), projection: lib.agentsMapFile() };
if (opt.json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`# Migration des affectations — ${report.mode} — ${now}`);
  console.log(`carte lue : ${mapFile} (${mapKind}, ${Object.keys(legacy).length} entrée(s))`);
  console.log(`racines configurées : ${configured.join(", ") || "aucune"} ; racines connues (réelles) : ${roots.join(", ") || "aucune"}`);
  console.log(`instances découvertes : ${instances.join(", ") || "aucune"}`);
  console.log(`dossiers de lanceurs : ${launcherDirs.join(", ") || "aucun"} (${launchers.length} lanceur(s) lu(s) statiquement, aucun exécuté)`);
  console.log("");
  for (const r of rows) {
    console.log(`## ${r.name}`);
    console.log(`  companyId          : ${r.companyId ?? "INCONNU"}`);
    console.log(`  agentId            : ${r.agentId}`);
    console.log(`  instance           : ${r.instance} (${r.instanceHome})`);
    console.log(`  profil             : ${r.profile} → ${r.profileHome}`);
    console.log(`  profil réel        : ${r.profileReal}`);
    console.log(`  lanceur            : ${r.launchers.join(", ") || "aucun"}`);
    console.log(`  HERMES_HOME (lu)   : ${r.launcherHome ?? "—"}`);
    console.log(`  binaire            : ${r.binary ?? "—"}`);
    console.log(`  compte modèle      : ${r.account}`);
    console.log(`  socket (max, octets): ${r.socketBytes} ${r.socketBytes > lib.SOCKET_PATH_MAX ? `> ${lib.SOCKET_PATH_MAX} : REFUS au démarrage` : `≤ ${lib.SOCKET_PATH_MAX}`}`);
    if (r.problems.length) console.log(`  DÉSACCORD          : ${r.problems.join(" ; ")}`);
    console.log("");
  }
  console.log(`## Désaccords (${disagreements.length})`);
  for (const d of disagreements) console.log(`  - ${d}`);
  console.log(`## Avertissements (${warnings.length})`);
  for (const w of warnings) console.log(`  - ${w}`);
  console.log(`## Notes (${notes.length})`);
  for (const n of notes) console.log(`  - ${n}`);
  console.log("");
  console.log(`## Table proposée (${lib.assignmentsFile()})`);
  console.log(JSON.stringify(table, null, 2));
}

/* ---------- 9. écriture (seulement --apply) ---------- */
if (!opt.apply) {
  if (!opt.json) console.log(`\nLecture seule : rien n'est écrit. Pour écrire : relance avec --apply (refusé tant qu'il reste un désaccord).`);
  process.exit(disagreements.length ? 2 : 0);
}
if (disagreements.length) {
  console.error(`\n--apply refusé : ${disagreements.length} désaccord(s) à régler d'abord.`);
  process.exit(2);
}
const stamp = now.replace(/[:.]/g, "-");
for (const f of [lib.assignmentsFile(), lib.agentsMapFile()]) {
  if (await exists(f)) {
    await copyFile(f, `${f}.bak-${stamp}`);
    console.log(`sauvegarde : ${f}.bak-${stamp}`);
  }
}
await lib.replaceTable(table, { roots });
console.log(`table écrite : ${lib.assignmentsFile()} ; projection : ${lib.agentsMapFile()}`);
