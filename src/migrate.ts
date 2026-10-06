// Migration des affectations existantes vers la table explicite (0.6.1) — LECTURE SEULE par défaut.
// Source : l'ancienne carte agents.json (format plat 0.4–0.5, produite par le nom, ou projection 0.6), les instances
// découvertes et, si fourni, l'export des agents Paperclip (`agentCommands` : agentId → hermesCommand).
// AUCUN LANCEUR N'EST EXÉCUTÉ NI LU POUR AUTORISER : les dossiers bin/ sont seulement inventoriés (chemin, empreinte) ;
// un fichier qui n'a pas la forme d'un lanceur (pas de shebang, ou sans « hermes ») est ignoré (fichier étranger).
// Un lanceur RÉELLEMENT RÉFÉRENCÉ par un agent (hermesCommand = chemin) est visible dans le rapport et bloque `--apply`
// tant qu'une correspondance EXPLICITE n'est pas donnée (`confirm` : agentId → instance:profil), validée contre les
// instances et profils existants. Rien n'est reconstruit depuis le contenu d'un lanceur.
// La table proposée porte aussi le binaire administré (`hermes`) et les racines d'exécution (`instances`).
import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { agentsMapFile } from "./agents-map.js";
import { type AssignmentsTable, assignmentsFile, canonicalInstance, emptyTable, executionHome, expandExecutionRoot, knownRoots, relationalIssues } from "./assignments.js";
import { type HermesBinarySpec, describeBinary, verifyHermesBinary } from "./binary.js";
import { configuredRoots, instanceHomes } from "./discovery.js";
import { checkSocketPaths, SOCKET_PATH_MAX } from "./health.js";
import { readConfigStrict } from "./hermes.js";
import { profileUsability } from "./prepare.js";
import { exists } from "./workspace.js";

export interface MigrationOptions {
  map?: string | null; // carte à migrer (défaut : <référence>/agents.json)
  launcherDirs?: string[]; // dossiers à inventorier (défaut : <racine>/../bin pour chaque racine configurée)
  paperclipData?: string | null; // dossier data de Paperclip (run-logs/<companyId>/<agentId>)
  companyId?: string | null;
  companies?: Record<string, string>; // agentId → companyId
  companyNames?: Record<string, string>;
  agentCommands?: Record<string, string> | null; // agentId → hermesCommand (export Paperclip) ; null = inconnu
  confirm?: Record<string, { instanceHome: string; profile: string }>; // correspondances explicites
  hermes?: HermesBinarySpec | null; // binaire administré (global)
  executionRoots?: Record<string, string>; // instance → racine d'exécution littérale
}

export interface LauncherEntry {
  path: string;
  sha256: string;
  size: number;
  referencedBy: string[]; // agents dont le hermesCommand est ce chemin (ou y mène par realpath)
}

export interface MigrationRow {
  companyId: string | null;
  agentId: string;
  name: string;
  instance: string;
  instanceHome: string;
  profile: string;
  profileHome: string;
  profileReal: string;
  source: "carte" | "confirmation";
  command: string | null; // hermesCommand de l'agent (si connu)
  launcherReferenced: boolean;
  executionHome: string;
  account: string;
  socketBytes: number;
  problems: string[];
}

export interface MigrationReport {
  map: { file: string; kind: string; entries: number };
  roots: string[];
  knownRoots: string[];
  instances: string[];
  launcherDirs: string[];
  launchers: LauncherEntry[];
  foreignFiles: string[];
  binary: { spec: HermesBinarySpec | null; description: string | null; error: string | null };
  rows: MigrationRow[];
  disagreements: string[];
  warnings: string[];
  notes: string[];
  proposedTable: AssignmentsTable;
  target: string;
  projection: string;
}

const realOrNull = async (p: string) => realpath(p).catch(() => null);

async function sha256File(p: string): Promise<string> {
  return createHash("sha256").update(await readFile(p)).digest("hex");
}

/** Forme d'un lanceur : texte à shebang qui mentionne hermes. Le contenu n'est PAS interprété (aucun HERMES_HOME lu). */
async function looksLikeLauncher(p: string): Promise<boolean> {
  try {
    const head = (await readFile(p)).subarray(0, 4096).toString("utf8");
    return head.startsWith("#!") && /hermes/i.test(head);
  } catch {
    return false;
  }
}

async function modelAccount(instanceHome: string): Promise<string> {
  const { cfg } = await readConfigStrict(instanceHome);
  const model = (cfg["model"] ?? {}) as Record<string, unknown>;
  let auth = "auth.json absent";
  try {
    const j = JSON.parse(await readFile(join(instanceHome, "auth.json"), "utf8")) as Record<string, any>;
    const active = j["active_provider"] ?? model["provider"] ?? "?";
    const mode = j["providers"]?.[active]?.["auth_mode"] ?? "?";
    const pool = Array.isArray(j["credential_pool"]?.[active]) ? j["credential_pool"][active].length : 0;
    auth = `auth.json : ${active} (${mode}${pool ? `, ${pool} identifiant(s)` : ""})`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") auth = "auth.json illisible";
  }
  return `${String(model["provider"] ?? "?")}/${String(model["default"] ?? "?")} · ${auth}`;
}

/** Export Paperclip → agentId → hermesCommand. Formes acceptées : { id: cmd }, [agent…], { agents: [agent…] }. */
export function parseAgentCommands(json: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const list = Array.isArray(json) ? json : json && typeof json === "object" && Array.isArray((json as { agents?: unknown }).agents) ? (json as { agents: unknown[] }).agents : null;
  if (list) {
    for (const a of list as Record<string, any>[]) {
      const cmd = a?.["adapterConfig"]?.["hermesCommand"];
      if (typeof a?.["id"] === "string" && typeof cmd === "string" && cmd.trim()) out[a["id"]] = cmd.trim();
    }
    return out;
  }
  if (json && typeof json === "object") for (const [k, v] of Object.entries(json as Record<string, unknown>)) if (typeof v === "string" && v.trim()) out[k] = v.trim();
  return out;
}

export async function planMigration(opt: MigrationOptions = {}): Promise<MigrationReport> {
  const disagreements: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  /* 1. l'ancienne carte */
  const mapFile = opt.map ? resolve(opt.map) : agentsMapFile();
  const legacy: Record<string, { name: string; home: string; companyId: string | null }> = {};
  let mapKind = "absente";
  try {
    const parsed = JSON.parse(await readFile(mapFile, "utf8")) as Record<string, any>;
    if (parsed && typeof parsed === "object" && parsed["schemaVersion"] === 1 && parsed["agents"]) {
      const extra = Object.keys(parsed).filter((k) => !["schemaVersion", "derivedFrom", "hermes", "instances", "companies", "agents"].includes(k));
      mapKind = `projection (derivedFrom ${String(parsed["derivedFrom"]?.["sha256"] ?? "?").slice(0, 12)})${extra.length ? ` HYBRIDE (+${extra.length} entrée(s) plate(s) ignorée(s) : ${extra.join(", ")})` : ""}`;
      if (extra.length) warnings.push(`carte ${mapFile} hybride : ${extra.length} entrée(s) plate(s) écrite(s) par une autre version, ignorées (seule la partie projection est lue)`);
      for (const [id, a] of Object.entries(parsed["agents"] as Record<string, any>)) legacy[id] = { name: a.name, home: a.home, companyId: a.companyId ?? null };
    } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      mapKind = "format plat (0.4–0.5, produite par le nom : à ne pas convertir aveuglément)";
      for (const [id, a] of Object.entries(parsed)) if (a && typeof a === "object" && typeof a.home === "string") legacy[id] = { name: a.name, home: a.home, companyId: null };
    } else disagreements.push(`carte ${mapFile} : contenu inattendu`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") disagreements.push(`carte ${mapFile} illisible : ${(e as Error).message}`);
  }

  /* 2. instances découvertes et racines */
  const roots = await knownRoots();
  const configured = await configuredRoots();
  const instances = await instanceHomes();
  const instancesReal = new Set<string>();
  for (const h of instances) instancesReal.add((await realOrNull(h)) ?? h);

  /* 3. inventaire des lanceurs : jamais exécutés, jamais lus pour autoriser */
  const launcherDirs = [...(opt.launcherDirs ?? []).map((d) => resolve(d))];
  if (!opt.launcherDirs?.length) {
    for (const r of configured) {
      const bin = resolve(r, "..", "bin");
      if ((await exists(bin)) && !launcherDirs.includes(bin)) launcherDirs.push(bin);
    }
  }
  const launchers: LauncherEntry[] = [];
  const foreignFiles: string[] = [];
  for (const dir of launcherDirs) {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      warnings.push(`dossier de lanceurs illisible : ${dir}`);
      continue;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      const st = await stat(path).catch(() => null);
      if (!st?.isFile()) continue;
      if (!(await looksLikeLauncher(path))) {
        foreignFiles.push(path);
        continue;
      }
      launchers.push({ path, sha256: await sha256File(path), size: st.size, referencedBy: [] });
    }
  }
  if (foreignFiles.length) notes.push(`${foreignFiles.length} fichier(s) étranger(s) aux lanceurs ignoré(s) : ${foreignFiles.map((f) => basename(f)).join(", ")}`);

  /* 4. références des agents à des lanceurs */
  const commands = opt.agentCommands ?? null;
  if (commands === null && launchers.length) disagreements.push(`${launchers.length} lanceur(s) présent(s) mais les hermesCommand des agents sont inconnus : fournis l'export des agents Paperclip (--agent-commands FICHIER) pour savoir lesquels sont réellement référencés`);
  const referenced = new Map<string, string>(); // agentId → chemin du lanceur
  if (commands) {
    for (const [agentId, cmd] of Object.entries(commands)) {
      if (!cmd.includes("/")) continue; // nom nu : ignoré à l'exécution depuis 0.6.1, pas un lanceur
      referenced.set(agentId, cmd);
      const real = await realOrNull(cmd);
      for (const l of launchers) if (l.path === cmd || (real && (await realOrNull(l.path)) === real)) l.referencedBy.push(agentId);
    }
  }

  /* 5. entreprise de chaque agent */
  const companyOf: Record<string, string | null> = {};
  const paperclipAgents = new Map<string, string>();
  if (opt.paperclipData) {
    const runLogs = join(resolve(opt.paperclipData), "run-logs");
    try {
      for (const c of await readdir(runLogs, { withFileTypes: true })) {
        if (!c.isDirectory()) continue;
        for (const a of await readdir(join(runLogs, c.name), { withFileTypes: true })) if (a.isDirectory()) paperclipAgents.set(a.name, c.name);
      }
      notes.push(`Paperclip run-logs : ${paperclipAgents.size} agent(s) vus dans ${new Set(paperclipAgents.values()).size} entreprise(s) (${runLogs})`);
    } catch (e) {
      warnings.push(`run-logs Paperclip illisibles (${runLogs}) : ${(e as Error).message}`);
    }
  }
  const agentIds = new Set([...Object.keys(legacy), ...Object.keys(opt.confirm ?? {})]);
  for (const id of agentIds) {
    companyOf[id] = opt.companies?.[id] ?? legacy[id]?.companyId ?? opt.companyId ?? paperclipAgents.get(id) ?? null;
    if (!companyOf[id]) disagreements.push(`agent ${id}${legacy[id] ? ` (« ${legacy[id]!.name} »)` : ""} : companyId inconnu — donne --companies ${id}=<companyId>, --company-id ou --paperclip-data`);
  }
  for (const [id, co] of paperclipAgents) if (!agentIds.has(id)) notes.push(`agent Paperclip ${id} (entreprise ${co}) sans entrée dans la carte : non migré (à affecter dans la page Hermes s'il est Hermes)`);

  /* 6. binaire administré */
  let binary: MigrationReport["binary"] = { spec: opt.hermes ?? null, description: null, error: null };
  if (opt.hermes) {
    const v = await verifyHermesBinary(opt.hermes);
    if (v.ok) binary = { spec: opt.hermes, description: describeBinary(v.ok), error: null };
    else {
      binary = { spec: opt.hermes, description: null, error: v.error };
      disagreements.push(`binaire Hermes : ${v.error}`);
    }
  } else warnings.push("aucun binaire Hermes administré (--hermes-binary) : l'adaptateur refusera tout passage tant que `hermes.binary` n'est pas dans la table");

  /* 7. racines d'exécution */
  const execRoots: Record<string, string> = {};
  for (const [inst, raw] of Object.entries(opt.executionRoots ?? {})) {
    const c = await canonicalInstance(inst, roots);
    if (c.real === null) {
      disagreements.push(`racine d'exécution pour ${inst} : ${c.error}`);
      continue;
    }
    const ex = expandExecutionRoot(raw);
    if (ex.literal === null) {
      disagreements.push(`racine d'exécution ${raw} : ${ex.error}`);
      continue;
    }
    const r = await realOrNull(ex.literal);
    if (r !== c.real) {
      disagreements.push(`racine d'exécution ${ex.literal} : désigne ${r ?? "un chemin introuvable"}, pas l'instance ${c.real}`);
      continue;
    }
    execRoots[c.real] = raw;
  }

  /* 8. les lignes */
  const rows: MigrationRow[] = [];
  const claims = new Map<string, string[]>();
  for (const agentId of agentIds) {
    const a = legacy[agentId];
    const conf = opt.confirm?.[agentId];
    let instanceHome: string;
    let profile: string;
    let source: MigrationRow["source"];
    const problems: string[] = [];
    if (conf) {
      const c = await canonicalInstance(conf.instanceHome, roots);
      instanceHome = c.real ?? resolve(conf.instanceHome);
      if (c.error) problems.push(`correspondance explicite : ${c.error}`);
      profile = conf.profile;
      source = "confirmation";
    } else if (a) {
      const homeReal = (await realOrNull(a.home)) ?? a.home;
      const parts = homeReal.split("/");
      const isProfile = parts[parts.length - 2] === "profiles";
      instanceHome = isProfile ? resolve(homeReal, "..", "..") : homeReal;
      profile = isProfile ? parts[parts.length - 1]! : "default";
      source = "carte";
    } else continue;
    const profileHome = profile === "default" ? instanceHome : join(instanceHome, "profiles", profile);
    const command = commands?.[agentId] ?? null;
    const launcherReferenced = referenced.has(agentId);
    const row: MigrationRow = { companyId: companyOf[agentId] ?? null, agentId, name: a?.name ?? agentId, instance: basename(instanceHome), instanceHome, profile, profileHome, profileReal: "", source, command, launcherReferenced, executionHome: profileHome, account: "", socketBytes: 0, problems };
    if (launcherReferenced && !conf) problems.push(`lanceur RÉFÉRENCÉ par l'agent (${referenced.get(agentId)}) : il ne sera plus lancé (0.6.1) et son contenu n'est pas lu ; correspondance explicite requise (--confirm ${agentId}=<instance>:<profil>)`);
    if (!instancesReal.has(instanceHome)) problems.push(`instance ${instanceHome} non découverte (racines : ${configured.join(", ")})`);
    const c = await canonicalInstance(instanceHome, roots);
    if (c.error && source === "carte") problems.push(c.error);
    if (!(await exists(join(profileHome, "config.yaml")))) {
      row.profileReal = "config.yaml ABSENT";
      problems.push(`profil ${profileHome} sans config.yaml`);
    } else {
      const { error } = await readConfigStrict(profileHome);
      const usable = await profileUsability(instanceHome, profile).catch((e: Error) => e.message);
      row.profileReal = error ? `config.yaml INVALIDE (${error})` : usable ? `inutilisable : ${usable}` : "config.yaml présent et lisible";
      if (error) problems.push(`profil ${profileHome} : ${error}`);
      if (usable) problems.push(usable);
    }
    row.account = await modelAccount(instanceHome);
    const ex = execRoots[instanceHome] ? expandExecutionRoot(execRoots[instanceHome]!).literal : null;
    row.executionHome = ex ? executionHome(ex, profile) : profileHome;
    const sock = await checkSocketPaths(row.executionHome);
    row.socketBytes = sock.socketPathBytes;
    if (!sock.socketPathOk) warnings.push(`${row.name} (${row.executionHome}) : chemin de socket le plus long = ${sock.socketPathBytes} octets > ${SOCKET_PATH_MAX} (${sock.longest}) : l'adaptateur REFUSERA ce profil ; donne une racine d'exécution courte (--execution-root ${instanceHome}=~/.h/<x>)`);
    const key = `${instanceHome}|${profile}`;
    claims.set(key, [...(claims.get(key) ?? []), agentId]);
    rows.push(row);
  }
  for (const [key, ids] of claims) if (ids.length > 1) for (const r of rows) if (ids.includes(r.agentId)) r.problems.push(`profil ${key.replace("|", " / ")} revendiqué par ${ids.length} agents`);
  for (const r of rows) for (const p of r.problems) disagreements.push(`${r.name} (${r.agentId}) : ${p}`);
  for (const l of launchers) if (!l.referencedBy.length) notes.push(`lanceur ${l.path} (sha256 ${l.sha256.slice(0, 12)}…) : aucun agent ne le référence${commands === null ? " (références inconnues)" : ""} ; il reste utilisable à la main, Paperclip ne s'en sert plus`);

  /* 9. la table proposée */
  const now = new Date().toISOString();
  const table = emptyTable();
  if (opt.hermes) table.hermes = { ...opt.hermes };
  if (Object.keys(execRoots).length) table.instances = Object.fromEntries(Object.entries(execRoots).map(([k, v]) => [k, { executionRoot: v }]));
  for (const r of rows) {
    if (!r.companyId) continue;
    const co = (table.companies[r.companyId] ??= { name: opt.companyNames?.[r.companyId] ?? r.companyId, instances: [] });
    if (!co.instances.includes(r.instanceHome)) co.instances.push(r.instanceHome);
    table.agents[r.agentId] = { companyId: r.companyId, instanceHome: r.instanceHome, profile: r.profile, name: r.name, assignedAt: now, assignedBy: r.source === "confirmation" ? "migration:confirmation" : "migration" };
  }
  if (Object.keys(table.agents).length || table.instances) {
    const issues = await relationalIssues(table, roots);
    for (const [id, w] of Object.entries(issues.instances)) disagreements.push(`table proposée, instance ${id} : ${w}`);
    for (const [id, w] of Object.entries(issues.companies)) disagreements.push(`table proposée, entreprise ${id} : ${w}`);
    for (const [id, w] of Object.entries(issues.agents)) disagreements.push(`table proposée, agent ${id} : ${w}`);
  }
  return { map: { file: mapFile, kind: mapKind, entries: Object.keys(legacy).length }, roots: configured, knownRoots: roots, instances, launcherDirs, launchers, foreignFiles, binary, rows, disagreements, warnings, notes, proposedTable: table, target: assignmentsFile(), projection: agentsMapFile() };
}

/** `instance:profil` (instance absolue ; profil après le dernier « : »). */
export function parseConfirm(v: string): { agentId: string; instanceHome: string; profile: string } | null {
  const eq = v.indexOf("=");
  if (eq <= 0) return null;
  const rest = v.slice(eq + 1);
  const colon = rest.lastIndexOf(":");
  if (colon <= 0) return null;
  const instanceHome = rest.slice(0, colon);
  const profile = rest.slice(colon + 1);
  if (!isAbsolute(instanceHome) || !profile) return null;
  return { agentId: v.slice(0, eq), instanceHome, profile };
}
