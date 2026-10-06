// Table des AFFECTATIONS EXPLICITES : `~/.config/hermes-control/assignments.json` (surchargeable : HERMES_CONTROL_ASSIGNMENTS).
// La seule source de vérité « (companyId, agentId) → instance / profil » de Hermes Control (le futur identites.json du
// pack en dérivera ou la remplacera, jamais les deux en parallèle). Rien n'y entre par le nom : seules les actions
// d'administration (assign-agent, unassign-agent, set-company-instances, prepare-agent) et le script de migration écrivent.
//   { schemaVersion: 1,
//     companies: { [companyId]: { name, instances: [instanceHome…] } },          ← instances AUTORISÉES de l'entreprise
//     agents: { [agentId]: { companyId, instanceHome, profile, name, assignedAt, assignedBy } },
//     approvedBinaries?: [chemin…] }                                               ← binaires Hermes acceptés comme hermesCommand
// Validation à la lecture ET à l'écriture : l'instance d'un agent appartient aux instances autorisées de son entreprise ;
// deux agents ne revendiquent pas le même profil ; chaque instance, résolue par realpath, est dans une racine connue
// (~/.hermes, ~/.config/hermes-control/roots, HERMES_CONTROL_ROOTS, <ws>/hermes/profils). Fichier corrompu → refus.
// Écriture atomique (tmp + rename, 600) sous verrou à bail ; la projection agents.json est réécrite dans la foulée.
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { configuredRoots } from "./discovery.js";
import { assertSafeName, profileHome } from "./hermes.js";
import { withDirLock } from "./lock.js";
import { controlDir } from "./paths.js";
import { type Projection, projectionOf, readProjection, writeProjection } from "./agents-map.js";
import { readWorkspace } from "./workspace.js";

export interface CompanyEntry {
  name: string;
  instances: string[]; // racines d'instances Hermes autorisées (chemins canoniques)
}

export interface AgentAssignment {
  companyId: string;
  instanceHome: string;
  profile: string; // « default » = racine de l'instance
  name: string; // nom Paperclip au moment de l'affectation (informatif : renommer ne change rien)
  assignedAt: string;
  assignedBy: string; // « user:<id> », « migration », « event:agent.created »…
}

export interface AssignmentsTable {
  schemaVersion: 1;
  companies: Record<string, CompanyEntry>;
  agents: Record<string, AgentAssignment>;
  approvedBinaries?: string[];
}

export interface TableIssues {
  companies: Record<string, string>; // companyId → raison
  agents: Record<string, string>; // agentId → raison
}

export interface ReadResult {
  table: AssignmentsTable;
  raw: string | null; // texte du fichier (pour l'empreinte) ; null si absent
  sha256: string | null;
  exists: boolean;
  error: string | null; // fichier illisible, JSON corrompu ou schéma invalide : la table entière est REFUSÉE
  issues: TableIssues; // problèmes relationnels par entrée (l'entrée est refusée, le reste de la table reste valide)
}

export interface ResolvedAssignment extends AgentAssignment {
  agentId: string;
  home: string; // racine du profil = HERMES_HOME
  source: "table" | "projection";
}

export const NOT_ASSIGNED = "non affecté : aucune affectation explicite pour cet agent dans la table (page Hermes → « Affecter »)";
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 30_000;
const SAFE_PROFILE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function assignmentsFile(): string {
  const env = process.env["HERMES_CONTROL_ASSIGNMENTS"]?.trim();
  return env || join(controlDir(), "assignments.json");
}

export function emptyTable(): AssignmentsTable {
  return { schemaVersion: 1, companies: {}, agents: {} };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export const noIssues = (): TableIssues => ({ companies: {}, agents: {} });

/* ---------- schéma ---------- */

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((s) => typeof s === "string");
}

/** Forme du fichier (structure) ; toute entorse refuse la table entière. */
export function parseTable(parsed: unknown): { table: AssignmentsTable; error: null } | { table: null; error: string } {
  const bad = (m: string) => ({ table: null, error: `assignments.json invalide : ${m}` }) as const;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bad("le contenu n'est pas un objet JSON");
  const t = parsed as Record<string, unknown>;
  if (t["schemaVersion"] !== 1) return bad(`schemaVersion ${JSON.stringify(t["schemaVersion"])} inconnu (attendu : 1)`);
  const companies = t["companies"] ?? {};
  const agents = t["agents"] ?? {};
  if (!companies || typeof companies !== "object" || Array.isArray(companies)) return bad("`companies` n'est pas un objet");
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return bad("`agents` n'est pas un objet");
  const outC: Record<string, CompanyEntry> = {};
  for (const [id, c] of Object.entries(companies as Record<string, unknown>)) {
    if (!c || typeof c !== "object") return bad(`companies[${id}] n'est pas un objet`);
    const e = c as Record<string, unknown>;
    if (typeof e["name"] !== "string") return bad(`companies[${id}].name manquant`);
    if (!isStringArray(e["instances"])) return bad(`companies[${id}].instances n'est pas une liste de chemins`);
    for (const i of e["instances"]) if (!isAbsolute(i)) return bad(`companies[${id}].instances : chemin non absolu « ${i} »`);
    outC[id] = { name: e["name"], instances: [...e["instances"]] };
  }
  const outA: Record<string, AgentAssignment> = {};
  for (const [id, a] of Object.entries(agents as Record<string, unknown>)) {
    if (!a || typeof a !== "object") return bad(`agents[${id}] n'est pas un objet`);
    const e = a as Record<string, unknown>;
    for (const k of ["companyId", "instanceHome", "profile", "name", "assignedAt", "assignedBy"]) if (typeof e[k] !== "string") return bad(`agents[${id}].${k} manquant`);
    if (!isAbsolute(e["instanceHome"] as string)) return bad(`agents[${id}].instanceHome non absolu`);
    outA[id] = { companyId: e["companyId"] as string, instanceHome: e["instanceHome"] as string, profile: e["profile"] as string, name: e["name"] as string, assignedAt: e["assignedAt"] as string, assignedBy: e["assignedBy"] as string };
  }
  const table: AssignmentsTable = { schemaVersion: 1, companies: outC, agents: outA };
  if (t["approvedBinaries"] !== undefined) {
    if (!isStringArray(t["approvedBinaries"])) return bad("`approvedBinaries` n'est pas une liste");
    table.approvedBinaries = [...t["approvedBinaries"]];
  }
  return { table, error: null };
}

/* ---------- racines connues et chemins canoniques ---------- */

/** Racines (chemins réels) dans lesquelles une instance affectée doit se trouver. */
export async function knownRoots(): Promise<string[]> {
  const out = new Set<string>();
  const ws = await readWorkspace();
  for (const r of [...(await configuredRoots()), ...(ws ? [ws.profils] : [])]) {
    const real = await realpath(r).catch(() => null);
    if (real) out.add(real);
  }
  return [...out];
}

function within(path: string, roots: string[]): boolean {
  return roots.some((r) => path === r || path.startsWith(r.endsWith("/") ? r : r + "/"));
}

/** Chemin réel d'un dossier d'instance (il doit exister) ; erreur explicite sinon. */
export async function canonicalInstance(instanceHome: string, roots: string[]): Promise<{ real: string; error: null } | { real: null; error: string }> {
  if (!isAbsolute(instanceHome)) return { real: null, error: `instance « ${instanceHome} » : chemin non absolu` };
  const real = await realpath(resolve(instanceHome)).catch(() => null);
  if (!real) return { real: null, error: `instance « ${instanceHome} » introuvable (realpath)` };
  if (!within(real, roots)) return { real: null, error: `instance « ${real} » hors des racines connues (${roots.join(", ") || "aucune"}) : ajoute sa racine dans ~/.config/hermes-control/roots` };
  return { real, error: null };
}

/* ---------- validation relationnelle ---------- */

/** Problèmes par entrée : l'entrée fautive est refusée, les autres restent valides. */
export async function relationalIssues(table: AssignmentsTable, roots: string[]): Promise<TableIssues> {
  const issues = noIssues();
  const realOf = new Map<string, string | null>();
  const real = async (p: string) => {
    if (!realOf.has(p)) realOf.set(p, (await canonicalInstance(p, roots)).real);
    return realOf.get(p) ?? null;
  };
  const authorized = new Map<string, Set<string>>(); // companyId → instances réelles autorisées
  for (const [cid, c] of Object.entries(table.companies)) {
    const set = new Set<string>();
    for (const i of c.instances) {
      const r = await real(i);
      if (!r) issues.companies[cid] = (await canonicalInstance(i, roots)).error ?? `instance ${i} invalide`;
      else set.add(r);
    }
    authorized.set(cid, set);
  }
  const claims = new Map<string, string[]>(); // « instance réelle|profil » → agents
  for (const [aid, a] of Object.entries(table.agents)) {
    const company = table.companies[a.companyId];
    if (!company) {
      issues.agents[aid] = `entreprise ${a.companyId} absente de la table (aucune instance autorisée)`;
      continue;
    }
    if (!SAFE_PROFILE.test(a.profile)) {
      issues.agents[aid] = `nom de profil invalide : ${a.profile}`;
      continue;
    }
    const r = await real(a.instanceHome);
    if (!r) {
      issues.agents[aid] = (await canonicalInstance(a.instanceHome, roots)).error ?? `instance ${a.instanceHome} invalide`;
      continue;
    }
    if (!authorized.get(a.companyId)?.has(r)) {
      issues.agents[aid] = `instance ${r} non autorisée pour l'entreprise « ${company.name} » (${a.companyId})`;
      continue;
    }
    const key = `${r}|${a.profile}`;
    claims.set(key, [...(claims.get(key) ?? []), aid]);
  }
  for (const [key, ids] of claims) {
    if (ids.length < 2) continue;
    const [inst, profile] = key.split("|");
    for (const id of ids) issues.agents[id] = `profil ${inst}/${profile} revendiqué par ${ids.length} agents (${ids.join(", ")})`;
  }
  return issues;
}

/* ---------- lecture ---------- */

export async function readAssignments(opts: { roots?: string[] } = {}): Promise<ReadResult> {
  const file = assignmentsFile();
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { table: emptyTable(), raw: null, sha256: null, exists: false, error: null, issues: noIssues() };
    return { table: emptyTable(), raw: null, sha256: null, exists: true, error: `assignments.json illisible : ${(e as Error).message}`, issues: noIssues() };
  }
  const digest = sha256(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { table: emptyTable(), raw, sha256: digest, exists: true, error: `assignments.json corrompu : ${(e as Error).message}`, issues: noIssues() };
  }
  const p = parseTable(parsed);
  if (p.table === null) return { table: emptyTable(), raw, sha256: digest, exists: true, error: p.error, issues: noIssues() };
  const issues = await relationalIssues(p.table, opts.roots ?? (await knownRoots()));
  return { table: p.table, raw, sha256: digest, exists: true, error: null, issues };
}

/* ---------- résolution d'un agent (plugin ET adaptateur) ---------- */

function projectionTable(p: Projection): AssignmentsTable {
  const agents: Record<string, AgentAssignment> = {};
  for (const [id, a] of Object.entries(p.agents)) agents[id] = { companyId: a.companyId, instanceHome: a.instanceHome, profile: a.profile, name: a.name, assignedAt: a.at, assignedBy: a.by };
  return { schemaVersion: 1, companies: p.companies, agents };
}

/**
 * Affectation valide d'un agent, ou la raison du refus. La table est lue directement ; la projection agents.json ne sert
 * qu'en secours quand la table est présente mais illisible pour ce lecteur ET que la projection porte son empreinte exacte.
 * `companyId` (ctx.agent.companyId) : l'affectation doit être celle de cette entreprise.
 */
export type Resolution = { ok: ResolvedAssignment; reason: null; approvedBinaries: string[] } | { ok: null; reason: string; approvedBinaries: string[] };

export async function resolveAssignment(agentId: string, opts: { companyId?: string | null; roots?: string[] } = {}): Promise<Resolution> {
  if (!agentId) return { ok: null, reason: "agent sans identifiant", approvedBinaries: [] };
  const roots = opts.roots ?? (await knownRoots());
  const read = await readAssignments({ roots });
  let table = read.table;
  let issues = read.issues;
  let source: ResolvedAssignment["source"] = "table";
  if (read.error) {
    const { projection } = await readProjection();
    if (!projection || !read.sha256 || projection.derivedFrom.sha256 !== read.sha256) return { ok: null, reason: `${read.error} ; aucune projection agents.json de secours à la même empreinte`, approvedBinaries: [] };
    table = projectionTable(projection);
    issues = await relationalIssues(table, roots);
    source = "projection";
  } else if (!read.exists) {
    return { ok: null, reason: `${NOT_ASSIGNED} — table absente : ${assignmentsFile()}`, approvedBinaries: [] };
  }
  const approvedBinaries = table.approvedBinaries ?? [];
  const a = table.agents[agentId];
  if (!a) return { ok: null, reason: `${NOT_ASSIGNED} (table : ${assignmentsFile()})`, approvedBinaries };
  const issue = issues.agents[agentId];
  if (issue) return { ok: null, reason: `affectation invalide : ${issue}`, approvedBinaries };
  if (opts.companyId && a.companyId !== opts.companyId) return { ok: null, reason: `affectation enregistrée pour l'entreprise ${a.companyId}, pas pour ${opts.companyId}`, approvedBinaries };
  return { ok: { ...a, agentId, home: profileHome(a.instanceHome, a.profile), source }, reason: null, approvedBinaries };
}

/* ---------- écritures (actions d'administration seulement) ---------- */

function withTableLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = `${assignmentsFile()}.lock`;
  return withDirLock(lock, { waitMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS, busy: `assignments.json : verrou tenu trop longtemps (${lock})` }, fn);
}

async function writeTable(table: AssignmentsTable): Promise<string> {
  const file = assignmentsFile();
  await mkdir(dirname(file), { recursive: true });
  const text = JSON.stringify(table, null, 2) + "\n";
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, file);
  const digest = sha256(text);
  await writeProjection(projectionOf(table, file, digest, profileHome));
  return digest;
}

/** Lecture-modification-écriture sous verrou : refuse si la table est corrompue ou si la modification crée un problème relationnel. */
async function mutate(change: (table: AssignmentsTable) => void | Promise<void>, roots?: string[]): Promise<AssignmentsTable> {
  return withTableLock(async () => {
    const r = roots ?? (await knownRoots());
    const before = await readAssignments({ roots: r });
    if (before.error) throw new Error(`${before.error} ; rien n'est écrit — répare ou supprime ${assignmentsFile()}`);
    const table: AssignmentsTable = JSON.parse(JSON.stringify(before.table)) as AssignmentsTable;
    await change(table);
    const after = await relationalIssues(table, r);
    const fresh: string[] = [];
    for (const [id, why] of Object.entries(after.companies)) if (before.issues.companies[id] !== why) fresh.push(`entreprise ${id} : ${why}`);
    for (const [id, why] of Object.entries(after.agents)) if (before.issues.agents[id] !== why) fresh.push(`agent ${id} : ${why}`);
    if (fresh.length) throw new Error(`affectation refusée : ${fresh.join(" ; ")}`);
    await writeTable(table);
    return table;
  });
}

/** Instances autorisées d'une entreprise (chemins canonicalisés, existants, dans les racines connues). */
export async function setCompanyInstances(companyId: string, name: string, instances: string[], opts: { roots?: string[] } = {}): Promise<AssignmentsTable> {
  if (!companyId) throw new Error("companyId requis");
  const roots = opts.roots ?? (await knownRoots());
  const canonical: string[] = [];
  for (const i of instances) {
    const c = await canonicalInstance(i, roots);
    if (c.real === null) throw new Error(`affectation refusée : ${c.error}`);
    if (!canonical.includes(c.real)) canonical.push(c.real);
  }
  return mutate((table) => {
    const stillAssigned = Object.entries(table.agents).filter(([, a]) => a.companyId === companyId && !canonical.includes(a.instanceHome));
    if (stillAssigned.length) throw new Error(`affectation refusée : des agents de cette entreprise sont affectés à une instance retirée (${stillAssigned.map(([, a]) => `${a.name} → ${a.instanceHome}`).join(" ; ")}) ; désaffecte-les d'abord (${stillAssigned.map(([id]) => id).join(", ")})`);
    table.companies[companyId] = { name: name || table.companies[companyId]?.name || companyId, instances: canonical };
  }, roots);
}

export interface AssignInput {
  agentId: string;
  companyId: string;
  companyName?: string | null;
  instanceHome: string;
  profile: string;
  name: string;
  assignedBy: string;
}

/** Affecte un agent (explicitement) : instance autorisée pour son entreprise, profil sûr et non revendiqué par un autre agent. */
export async function assignAgent(input: AssignInput, opts: { roots?: string[] } = {}): Promise<ResolvedAssignment> {
  if (!input.agentId || !input.companyId) throw new Error("agentId et companyId requis");
  const profile = input.profile === "default" ? "default" : assertSafeName(input.profile);
  const roots = opts.roots ?? (await knownRoots());
  const c = await canonicalInstance(input.instanceHome, roots);
  if (c.real === null) throw new Error(`affectation refusée : ${c.error}`);
  const table = await mutate((t) => {
    const company = t.companies[input.companyId];
    if (!company) throw new Error(`affectation refusée : aucune instance autorisée déclarée pour l'entreprise « ${input.companyName ?? input.companyId} » ; déclare-les d'abord (action set-company-instances)`);
    if (!company.instances.includes(c.real)) throw new Error(`affectation refusée : ${c.real} n'est pas une instance autorisée de l'entreprise « ${company.name} » (autorisées : ${company.instances.join(", ") || "aucune"})`);
    const taken = Object.entries(t.agents).find(([id, a]) => id !== input.agentId && a.instanceHome === c.real && a.profile === profile);
    if (taken) throw new Error(`affectation refusée : le profil ${c.real}/${profile} est déjà affecté à l'agent « ${taken[1].name} » (${taken[0]})`);
    t.agents[input.agentId] = { companyId: input.companyId, instanceHome: c.real, profile, name: input.name, assignedAt: new Date().toISOString(), assignedBy: input.assignedBy };
  }, roots);
  const a = table.agents[input.agentId]!;
  return { ...a, agentId: input.agentId, home: profileHome(a.instanceHome, a.profile), source: "table" };
}

export async function unassignAgent(agentId: string, opts: { roots?: string[] } = {}): Promise<boolean> {
  if (!agentId) throw new Error("agentId requis");
  let removed = false;
  await mutate((t) => {
    removed = agentId in t.agents;
    delete t.agents[agentId];
  }, opts.roots);
  return removed;
}

/** Remplace la table entière (migration) : validée comme toute écriture ; `--apply` du script seulement. */
export async function replaceTable(table: AssignmentsTable, opts: { roots?: string[] } = {}): Promise<AssignmentsTable> {
  const p = parseTable(table);
  if (p.table === null) throw new Error(p.error);
  const roots = opts.roots ?? (await knownRoots());
  return withTableLock(async () => {
    const issues = await relationalIssues(p.table, roots);
    const all = [...Object.entries(issues.companies).map(([id, w]) => `entreprise ${id} : ${w}`), ...Object.entries(issues.agents).map(([id, w]) => `agent ${id} : ${w}`)];
    if (all.length) throw new Error(`table refusée : ${all.join(" ; ")}`);
    await writeTable(p.table);
    return p.table;
  });
}

/** Un `hermesCommand` est-il un binaire Hermes approuvé (par opposition à un script lanceur) ? */
export function isApprovedBinary(command: string, table: Pick<AssignmentsTable, "approvedBinaries">): boolean {
  const c = command.trim();
  if (!c) return false;
  if (!c.includes("/")) return true; // nom nu résolu par le PATH de Paperclip : pas un script à lire
  const explicit = process.env["HERMES_CONTROL_HERMES_BIN"]?.trim();
  if (explicit && resolve(c) === resolve(explicit)) return true;
  return (table.approvedBinaries ?? []).some((b) => resolve(b) === resolve(c));
}
