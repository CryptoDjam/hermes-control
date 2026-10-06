// Table des AFFECTATIONS EXPLICITES : `<référence>/assignments.json`, la référence étant `<compte>/.config/hermes-control`
// (src/paths.ts : dossier du compte Unix selon getpwuid, jamais $HOME ni une variable ; plugin et adaptateur lisent donc
// le même fichier). La seule source de vérité « (companyId, agentId) → instance / profil » ET de l'exécution Hermes (binaire
// administré, racine d'exécution littérale par instance). Rien n'y entre par le nom : seules les actions d'administration
// (assign-agent, unassign-agent, set-company-instances, prepare-agent, set-hermes-binary, set-execution-root), le script
// de migration (--apply) ou l'administrateur à la main (validé à la lecture) l'écrivent.
//   { schemaVersion: 1,
//     hermes?: { binary, linkTarget?, sha256? },                                    ← point d'entrée Hermes administré (global)
//     instances?: { [instance canonique]: { executionRoot?, hermes? } },            ← racine d'EXÉCUTION littérale (courte), binaire propre
//     companies: { [companyId]: { name, instances: [instanceHome…] } },            ← instances AUTORISÉES de l'entreprise
//     agents: { [agentId]: { companyId, instanceHome, profile, name, assignedAt, assignedBy } } }
// `instanceHome` est la racine CANONIQUE (realpath, sert à vérifier) ; `executionRoot` la racine transmise à Hermes telle
// quelle (absolue, `~/` développé explicitement depuis le dossier du compte, sans « . » ni « .. »), qui doit désigner la
// même instance (realpath identique). HERMES_HOME = executionRoot (profil `default`) ou executionRoot/profiles/<profil>.
// Validation à la lecture ET à l'écriture : l'instance d'un agent appartient aux instances autorisées de son entreprise ;
// deux agents ne revendiquent pas le même profil ; chaque instance, résolue par realpath, est dans une racine connue
// (~/.hermes du compte, <référence>/roots, <ws>/hermes/profils). Fichier corrompu → refus. `approvedBinaries` (0.6.0)
// n'existe plus : une table qui le contient est refusée avec un message explicite.
// Écriture atomique (tmp + rename, 600) sous verrou à bail ; la projection agents.json est réécrite dans la foulée.
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type HermesBinarySpec, strictAbsolute, verifyHermesBinary } from "./binary.js";
import { configuredRoots } from "./discovery.js";
import { assertSafeName, profileHome } from "./hermes.js";
import { withDirLock } from "./lock.js";
import { accountHome, controlDir } from "./paths.js";
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

export interface InstanceSettings {
  executionRoot?: string; // racine transmise à Hermes (littérale, courte) ; absente → la racine canonique elle-même
  hermes?: HermesBinarySpec; // binaire propre à cette instance (prioritaire sur le global)
}

export interface AssignmentsTable {
  schemaVersion: 1;
  hermes?: HermesBinarySpec;
  instances?: Record<string, InstanceSettings>;
  companies: Record<string, CompanyEntry>;
  agents: Record<string, AgentAssignment>;
}

export interface TableIssues {
  companies: Record<string, string>; // companyId → raison
  agents: Record<string, string>; // agentId → raison
  instances: Record<string, string>; // instance (clé de `instances`) → raison
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
  home: string; // racine CANONIQUE du profil (vérifications : config.yaml, préparation, skills)
  execution: { root: string; home: string }; // racine d'exécution littérale et HERMES_HOME transmis à Hermes (sockets mesurés dessus)
  hermes: HermesBinarySpec | null; // binaire administré (instance, sinon global) ; null = non administré
  source: "table" | "projection";
}

export const NOT_ASSIGNED = "non affecté : aucune affectation explicite pour cet agent dans la table (page Hermes → « Affecter »)";
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 30_000;
const SAFE_PROFILE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** La table : toujours `<référence>/assignments.json` (aucune variable d'environnement ne la déplace). */
export function assignmentsFile(): string {
  return join(controlDir(), "assignments.json");
}

export function emptyTable(): AssignmentsTable {
  return { schemaVersion: 1, companies: {}, agents: {} };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export const noIssues = (): TableIssues => ({ companies: {}, agents: {}, instances: {} });

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
  if (t["approvedBinaries"] !== undefined) return bad("`approvedBinaries` n'existe plus depuis 0.6.1 (les noms et scripts ne sont plus approuvés) : remplace-le par `hermes: { binary: \"/chemin/absolu/du/point/d'entrée\" }`");
  if (t["hermes"] !== undefined) {
    const h = parseSpec(t["hermes"], "hermes");
    if (typeof h === "string") return bad(h);
    table.hermes = h;
  }
  if (t["instances"] !== undefined) {
    const inst = t["instances"];
    if (!inst || typeof inst !== "object" || Array.isArray(inst)) return bad("`instances` n'est pas un objet");
    const out: Record<string, InstanceSettings> = {};
    for (const [key, v] of Object.entries(inst as Record<string, unknown>)) {
      if (!isAbsolute(key)) return bad(`instances : clé non absolue « ${key} »`);
      if (!v || typeof v !== "object" || Array.isArray(v)) return bad(`instances[${key}] n'est pas un objet`);
      const e = v as Record<string, unknown>;
      const s: InstanceSettings = {};
      if (e["executionRoot"] !== undefined) {
        if (typeof e["executionRoot"] !== "string" || !e["executionRoot"]) return bad(`instances[${key}].executionRoot n'est pas un chemin`);
        s.executionRoot = e["executionRoot"];
      }
      if (e["hermes"] !== undefined) {
        const h = parseSpec(e["hermes"], `instances[${key}].hermes`);
        if (typeof h === "string") return bad(h);
        s.hermes = h;
      }
      out[key] = s;
    }
    table.instances = out;
  }
  return { table, error: null };
}

function parseSpec(x: unknown, where: string): HermesBinarySpec | string {
  if (!x || typeof x !== "object" || Array.isArray(x)) return `${where} n'est pas un objet { binary, linkTarget?, sha256? }`;
  const e = x as Record<string, unknown>;
  if (typeof e["binary"] !== "string" || !isAbsolute(e["binary"])) return `${where}.binary doit être un chemin absolu`;
  const spec: HermesBinarySpec = { binary: e["binary"] };
  if (e["linkTarget"] !== undefined) {
    if (typeof e["linkTarget"] !== "string" || !isAbsolute(e["linkTarget"])) return `${where}.linkTarget doit être un chemin absolu`;
    spec.linkTarget = e["linkTarget"];
  }
  if (e["sha256"] !== undefined) {
    if (typeof e["sha256"] !== "string" || !/^[0-9a-f]{64}$/i.test(e["sha256"])) return `${where}.sha256 doit être une empreinte sha256 hexadécimale`;
    spec.sha256 = e["sha256"].toLowerCase();
  }
  return spec;
}

/** Racine d'exécution administrée → chemin littéral transmis (`~/` développé depuis le dossier du compte) ; erreur si non conforme. */
export function expandExecutionRoot(raw: string): { literal: string; error: null } | { literal: null; error: string } {
  const literal = raw === "~" ? accountHome() : raw.startsWith("~/") ? accountHome() + raw.slice(1) : raw;
  const bad = strictAbsolute(literal, "racine d'exécution");
  if (bad) return { literal: null, error: bad };
  return { literal: literal.length > 1 && literal.endsWith("/") ? literal.slice(0, -1) : literal, error: null };
}

/** HERMES_HOME transmis : la racine elle-même pour le profil `default`, sinon <racine>/profiles/<profil> (comme profileHome). */
export function executionHome(executionRoot: string, profile: string): string {
  return profile === "default" ? executionRoot : `${executionRoot}/profiles/${assertSafeName(profile)}`;
}

/** Binaire administré pour une instance (canonique) : celui de l'instance, sinon le global ; null s'il n'y en a pas. */
export function hermesSpecFor(table: Pick<AssignmentsTable, "hermes" | "instances">, instanceHome: string | null): HermesBinarySpec | null {
  return (instanceHome ? table.instances?.[instanceHome]?.hermes : undefined) ?? table.hermes ?? null;
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
  for (const [key, settings] of Object.entries(table.instances ?? {})) {
    const r = await real(key);
    if (!r) {
      issues.instances[key] = (await canonicalInstance(key, roots)).error ?? `instance ${key} invalide`;
      continue;
    }
    if (r !== key) {
      issues.instances[key] = `instances : la clé doit être la racine canonique (realpath) ${r}, pas ${key}`;
      continue;
    }
    if (settings.executionRoot !== undefined) {
      const ex = expandExecutionRoot(settings.executionRoot);
      if (ex.literal === null) {
        issues.instances[key] = ex.error;
        continue;
      }
      const exReal = await realpath(ex.literal).catch(() => null);
      if (exReal !== key) issues.instances[key] = `racine d'exécution ${ex.literal} : désigne ${exReal ?? "un chemin introuvable"}, pas l'instance ${key} ; refus`;
    }
  }
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
    if (r !== a.instanceHome) {
      issues.agents[aid] = `instanceHome ${a.instanceHome} n'est pas canonique (realpath ${r}) : la table garde la racine canonique, la racine courte va dans instances[…].executionRoot`;
      continue;
    }
    const instIssue = issues.instances[r];
    if (instIssue) {
      issues.agents[aid] = `instance ${r} : ${instIssue}`;
      continue;
    }
    const key = `${r}|${a.profile}`;
    claims.set(key, [...(claims.get(key) ?? []), aid]);
  }
  for (const [key, ids] of claims) {
    if (ids.length < 2) continue;
    const [inst, profile] = key.split("|");
    for (const id of ids) issues.agents[id] = `profil ${profileHome(inst!, profile!)} revendiqué par ${ids.length} agents (${ids.join(", ")})`;
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
  const t: AssignmentsTable = { schemaVersion: 1, companies: p.companies, agents };
  if (p.hermes) t.hermes = p.hermes;
  if (p.instances) t.instances = p.instances;
  return t;
}

/** Racine d'exécution littérale et HERMES_HOME d'une affectation (la table a déjà été validée). */
export function executionOf(table: Pick<AssignmentsTable, "instances">, a: Pick<AgentAssignment, "instanceHome" | "profile">): { root: string; home: string } {
  const raw = table.instances?.[a.instanceHome]?.executionRoot;
  const ex = raw ? expandExecutionRoot(raw) : null;
  const root = ex?.literal ?? a.instanceHome;
  return { root, home: executionHome(root, a.profile) };
}

/**
 * Affectation valide d'un agent, ou la raison du refus. La table est lue directement ; la projection agents.json ne sert
 * qu'en secours quand la table est présente mais illisible pour ce lecteur ET que la projection porte son empreinte exacte.
 * `companyId` (ctx.agent.companyId) : l'affectation doit être celle de cette entreprise.
 */
export type Resolution = { ok: ResolvedAssignment; reason: null } | { ok: null; reason: string };

export async function resolveAssignment(agentId: string, opts: { companyId?: string | null; roots?: string[] } = {}): Promise<Resolution> {
  if (!agentId) return { ok: null, reason: "agent sans identifiant" };
  const roots = opts.roots ?? (await knownRoots());
  const read = await readAssignments({ roots });
  let table = read.table;
  let issues = read.issues;
  let source: ResolvedAssignment["source"] = "table";
  if (read.error) {
    const { projection } = await readProjection();
    if (!projection || !read.sha256 || projection.derivedFrom.sha256 !== read.sha256) return { ok: null, reason: `${read.error} ; aucune projection agents.json de secours à la même empreinte` };
    table = projectionTable(projection);
    issues = await relationalIssues(table, roots);
    source = "projection";
  } else if (!read.exists) {
    return { ok: null, reason: `${NOT_ASSIGNED} — table absente : ${assignmentsFile()}` };
  }
  const a = table.agents[agentId];
  if (!a) return { ok: null, reason: `${NOT_ASSIGNED} (table : ${assignmentsFile()})` };
  const issue = issues.agents[agentId];
  if (issue) return { ok: null, reason: `affectation invalide : ${issue}` };
  if (opts.companyId && a.companyId !== opts.companyId) return { ok: null, reason: `affectation enregistrée pour l'entreprise ${a.companyId}, pas pour ${opts.companyId}` };
  return { ok: { ...a, agentId, home: profileHome(a.instanceHome, a.profile), execution: executionOf(table, a), hermes: hermesSpecFor(table, a.instanceHome), source }, reason: null };
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
  await writeProjection(projectionOf(table, file, digest, (i, p) => executionOf(table, { instanceHome: i, profile: p }).home));
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
    for (const [id, why] of Object.entries(after.instances)) if (before.issues.instances[id] !== why) fresh.push(`instance ${id} : ${why}`);
    // aucun NOUVEAU partage d'instance entre entreprises (0.6.2) ; un partage déjà présent reste un diagnostic
    const sharedBefore = sharedInstances(before.table);
    for (const [i, cids] of Object.entries(sharedInstances(table))) if (cids.some((c) => !(sharedBefore[i] ?? []).includes(c))) fresh.push(`partage : ${sharedInstanceDiagnostic(i, cids, table)}`);
    if (fresh.length) throw new Error(`affectation refusée : ${fresh.join(" ; ")}`);
    await writeTable(table);
    return table;
  });
}

/**
 * Instances rattachées à PLUSIEURS entreprises (0.6.2) : le partage n'est pas une fonction prise en charge. Une table qui
 * en contient déjà (écrite avant la 0.6.2 ou à la main) produit un DIAGNOSTIC — jamais de réattribution ni de suppression
 * automatique ; les réglages communs de ces instances (binaire, racine d'exécution) sont refusés tant que l'administrateur
 * n'a pas tranché. Clé : instance (chemin tel qu'écrit dans la table, normalement canonique) → entreprises.
 */
export function sharedInstances(table: Pick<AssignmentsTable, "companies">): Record<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const [cid, c] of Object.entries(table.companies)) for (const i of new Set(c.instances)) owners.set(i, [...(owners.get(i) ?? []), cid]);
  const out: Record<string, string[]> = {};
  for (const [i, cids] of owners) if (cids.length > 1) out[i] = cids.sort();
  return out;
}

export function sharedInstanceDiagnostic(instance: string, companies: string[], table: Pick<AssignmentsTable, "companies">): string {
  return `instance ${instance} rattachée à ${companies.length} entreprises (${companies.map((id) => `« ${table.companies[id]?.name ?? id} » ${id}`).join(", ")}) : partage non pris en charge (0.6.2) ; rien n'est réattribué ni supprimé automatiquement — l'administrateur retire l'instance de toutes les entreprises sauf une (action set-company-instances)`;
}

/**
 * Instances autorisées d'une entreprise (chemins canonicalisés, existants, dans les racines connues). Depuis 0.6.2 une
 * instance déjà rattachée à une AUTRE entreprise est refusée (aucune écriture) : pas de partage implicite, pas de
 * réattribution. Une instance déjà partagée (table antérieure) peut rester dans la liste de l'entreprise qui l'a déjà
 * (diagnostic), mais n'est jamais AJOUTÉE à une entreprise de plus.
 */
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
    const already = new Set(table.companies[companyId]?.instances ?? []);
    for (const i of canonical) {
      if (already.has(i)) continue;
      const others = Object.entries(table.companies).filter(([id, c]) => id !== companyId && c.instances.includes(i));
      if (others.length) throw new Error(`affectation refusée : l'instance ${i} est déjà rattachée à ${others.map(([id, c]) => `l'entreprise « ${c.name} » (${id})`).join(", ")} ; le partage d'une instance entre entreprises n'est pas pris en charge (0.6.2) — rien n'est écrit, rien n'est réattribué`);
    }
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
    if (taken) throw new Error(`affectation refusée : le profil ${profileHome(c.real, profile)} est déjà affecté à l'agent « ${taken[1].name} » (${taken[0]})`);
    t.agents[input.agentId] = { companyId: input.companyId, instanceHome: c.real, profile, name: input.name, assignedAt: new Date().toISOString(), assignedBy: input.assignedBy };
  }, roots);
  const a = table.agents[input.agentId]!;
  return { ...a, agentId: input.agentId, home: profileHome(a.instanceHome, a.profile), execution: executionOf(table, a), hermes: hermesSpecFor(table, a.instanceHome), source: "table" };
}

/**
 * Retire l'affectation d'un agent. `companyId` (0.6.2, contexte d'action autorisé) : l'affectation, si elle existe, doit
 * appartenir à cette entreprise — vérifié SOUS LE VERROU, avant toute écriture ; sinon refus, la table ne change pas.
 */
export async function unassignAgent(agentId: string, opts: { roots?: string[]; companyId?: string | null } = {}): Promise<boolean> {
  if (!agentId) throw new Error("agentId requis");
  let removed = false;
  await mutate((t) => {
    const a = t.agents[agentId];
    if (a && opts.companyId !== undefined && a.companyId !== opts.companyId) throw new Error(`désaffectation refusée : l'agent ${agentId} est affecté pour une autre entreprise (${a.companyId}), pas pour ${opts.companyId ?? "(aucune)"} ; rien n'est écrit`);
    removed = !!a;
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
    const shared = Object.entries(sharedInstances(p.table)).map(([i, cids]) => `partage : ${sharedInstanceDiagnostic(i, cids, p.table)}`);
    const all = [...shared, ...Object.entries(issues.instances).map(([id, w]) => `instance ${id} : ${w}`), ...Object.entries(issues.companies).map(([id, w]) => `entreprise ${id} : ${w}`), ...Object.entries(issues.agents).map(([id, w]) => `agent ${id} : ${w}`)];
    if (all.length) throw new Error(`table refusée : ${all.join(" ; ")}`);
    await writeTable(p.table);
    return p.table;
  });
}

/**
 * Binaire Hermes administré : global (`instanceHome` absent) ou propre à une instance (racine canonique). Vérifié AVANT
 * d'être écrit (même contrôle qu'avant chaque passage) ; `null` retire le champ.
 */
export async function setHermesBinary(spec: HermesBinarySpec | null, opts: { instanceHome?: string | null; roots?: string[] } = {}): Promise<AssignmentsTable> {
  const roots = opts.roots ?? (await knownRoots());
  let key: string | null = null;
  if (opts.instanceHome) {
    const c = await canonicalInstance(opts.instanceHome, roots);
    if (c.real === null) throw new Error(`binaire refusé : ${c.error}`);
    key = c.real;
  }
  if (spec) {
    const v = await verifyHermesBinary(spec);
    if (v.ok === null) throw new Error(`binaire refusé : ${v.error}`);
  }
  return mutate((t) => {
    if (key === null) {
      if (spec) t.hermes = { ...spec };
      else delete t.hermes;
      return;
    }
    const s = { ...(t.instances?.[key] ?? {}) };
    if (spec) s.hermes = { ...spec };
    else delete s.hermes;
    t.instances = { ...(t.instances ?? {}), [key]: s };
  }, roots);
}

/** Racine d'exécution littérale d'une instance (absolue ou `~/…`) ; elle doit désigner la même instance (realpath). `null` la retire. */
export async function setExecutionRoot(instanceHome: string, executionRoot: string | null, opts: { roots?: string[] } = {}): Promise<AssignmentsTable> {
  const roots = opts.roots ?? (await knownRoots());
  const c = await canonicalInstance(instanceHome, roots);
  if (c.real === null) throw new Error(`racine d'exécution refusée : ${c.error}`);
  const key = c.real;
  if (executionRoot !== null) {
    const ex = expandExecutionRoot(executionRoot);
    if (ex.literal === null) throw new Error(`racine d'exécution refusée : ${ex.error}`);
    const exReal = await realpath(ex.literal).catch(() => null);
    if (exReal !== key) throw new Error(`racine d'exécution refusée : ${ex.literal} désigne ${exReal ?? "un chemin introuvable"}, pas l'instance ${key}`);
  }
  return mutate((t) => {
    const s = { ...(t.instances?.[key] ?? {}) };
    if (executionRoot !== null) s.executionRoot = executionRoot;
    else delete s.executionRoot;
    t.instances = { ...(t.instances ?? {}), [key]: s };
  }, roots);
}
