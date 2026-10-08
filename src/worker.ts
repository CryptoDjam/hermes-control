// Worker du plugin Hermes Control (v0.6.2). Paperclip est le maître, l'affectation est EXPLICITE :
//  - l'affectation d'un agent = son entrée dans la table assignments.json (companyId, agentId → instance autorisée / profil),
//    écrite seulement par les actions d'administration (assign-agent, unassign-agent, set-company-instances, prepare-agent) ;
//    JAMAIS par le nom : ni à l'ouverture de la vue, ni à la synchro, ni à un renommage. Le nom ne sert qu'à une SUGGESTION
//    affichée (restreinte aux instances autorisées de l'entreprise), jamais appliquée ;
//  - pour un agent affecté, provider / modèle / thinking choisis dans le menu de l'agent sont écrits dans le config.yaml de
//    son profil (`hermes config set`, sans shell) ; un agent non affecté → « non affecté », aucune écriture dans Hermes ;
//  - la vue ne crée ni profil, ni dossier, ni lien, ne lit ni n'exécute aucun lanceur et n'écrit jamais la table ;
//    le `hermesCommand` d'un agent n'est plus utilisé (0.6.1) : il est seulement montré comme « ignoré » ;
//  - tout appel à Hermes du plugin passe par le binaire ADMINISTRÉ dans la table, vérifié avant l'appel, avec un
//    environnement explicite ; sans binaire administré valide, rien n'est exécuté ;
//  - la référence (table, roots, workspace, projection) est la même que celle de l'adaptateur : <compte>/.config/hermes-control
//    (src/paths.ts), sans variable d'environnement ; son chemin et ses empreintes sont exposés (santé, vue) ;
//  - un config.yaml, une table ou une projection corrompus (ou HYBRIDE) → refus / signalement, jamais de réécriture ;
//  - une seule donnée exposée à l'interface : « instances », FILTRÉE PAR ENTREPRISE (instances autorisées pour elle ou non
//    revendiquées, ses agents, leurs états et erreurs) ; actions : assign-agent, unassign-agent, set-company-instances,
//    prepare-agent (instance explicite, affecte en même temps), set-telegram, set-hermes-binary, set-execution-root.
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { instanceHomes } from "./discovery.js";
import { type ActionScope, actionScope, adminScope, companyScope } from "./scope.js";
import { withDirLock } from "./lock.js";
import { controlDir, legacyEnvRefusal } from "./paths.js";
import { type HermesExec, type HermesInstance, detectDashboards, instanceNameFromHome, profileHome, readInstance } from "./hermes.js";
import { matchAgent, slug } from "./match.js";
import { projectionProblem } from "./agents-map.js";
import { type AgentAssignment, type AssignmentsTable, type CompanyEntry, type TableIssues, assignAgent, assignmentsFile, canonicalInstance, executionHome, executionOf, expandExecutionRoot, hermesSpecFor, knownRoots, readAssignments, setCompanyInstances, setExecutionRoot, setHermesBinary, sharedInstanceDiagnostic, sharedInstances, unassignAgent } from "./assignments.js";
import { type HermesBinarySpec, describeBinary, verifyHermesBinary } from "./binary.js";
import { type ReferenceInfo, describeReference, referenceInfo } from "./reference.js";
import { type AgentState, type ProfileHealth, agentState, checkProfile } from "./health.js";
import { prepareAgent, profileUsability } from "./prepare.js";
import { prepareByIdentity } from "./prepare-identite.js";
import { projectionMode } from "./identites.js";
import { assertGatewayFree, setTelegramToken, startGateway, telegramConfigured } from "./telegram.js";
import { exists, readWorkspace } from "./workspace.js";
import { type Desired, desiredFromAdapterConfig, syncProfile, unreadableConfigError } from "./sync.js";

interface AgentLike {
  id: string;
  name: string;
  title?: string | null;
  status?: string;
  adapterType?: string;
  adapterConfig?: Record<string, unknown> | null;
}

/** Ce que Paperclip envoie pour un agent (les seules données qui sortent de Paperclip). */
interface AgentSnapshot {
  agentId: string;
  companyId: string;
  agentName: string;
  title: string | null;
  status: string | null;
  cwd: string | null;
  command: string | null; // hermesCommand de l'agent : IGNORÉ depuis 0.6.1 (affiché seulement)
  want: Desired;
}

export interface Suggestion {
  instance: string;
  instanceHome: string;
  profile: string;
  by: "profile-name" | "description";
}

interface SyncRecord {
  agentId: string;
  companyId: string;
  agentName: string;
  instance: string | null;
  profile: string | null;
  home: string | null;
  assignment: Pick<AgentAssignment, "instanceHome" | "profile" | "assignedAt" | "assignedBy"> | null;
  suggestion: Suggestion | null; // calculée par le nom, affichée, JAMAIS appliquée
  want: Desired;
  cwd: string | null;
  changed: string[];
  error: string | null;
  prepared: string[] | null; // ce que la préparation a créé (null = rien)
  ignoredCommand: string | null; // hermesCommand de l'agent, ignoré (seul le binaire administré est lancé)
  at: string;
}

const SNAPSHOT_KEY = { scopeKind: "instance" as const, stateKey: "agents" };
const SYNC_KEY = { scopeKind: "instance" as const, stateKey: "sync" };
export const NOT_ASSIGNED_SHORT = "non affecté";

/** Binaire administré (instance, sinon global), VÉRIFIÉ avant tout appel ; jamais « hermes » dans le PATH. */
async function execFor(table: Pick<AssignmentsTable, "hermes" | "instances">, instanceHome: string | null): Promise<{ exec: HermesExec | null; error: string | null; description: string | null }> {
  const legacy = legacyEnvRefusal();
  if (legacy) return { exec: null, error: legacy, description: null };
  const v = await verifyHermesBinary(hermesSpecFor(table, instanceHome));
  if (v.ok === null) return { exec: null, error: v.error, description: null };
  return { exec: { path: v.ok.path, pathPrefix: v.ok.pathPrefix }, error: null, description: describeBinary(v.ok) };
}

async function realOrResolved(p: string): Promise<string> {
  return (await realpath(p).catch(() => null)) ?? resolve(p);
}

/** Sonde de santé posée par setup() ; onHealth n'a pas de contexte Paperclip. */
let healthProbe: (() => Promise<string[]>) | null = null;

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    const log = ctx.logger;
    /** Agents Hermes de l'entreprise, réduits aux données utiles. */
    async function snapshotAgents(companyId: string): Promise<AgentSnapshot[]> {
      const agents = (await ctx.agents.list({ companyId })) as unknown as AgentLike[];
      const out: AgentSnapshot[] = [];
      for (const a of agents) {
        if (a.adapterType !== "hermes_local") continue;
        const ac = a.adapterConfig ?? {};
        const command = typeof ac["hermesCommand"] === "string" && ac["hermesCommand"].trim() ? (ac["hermesCommand"] as string).trim() : null;
        out.push({ agentId: a.id, companyId, agentName: a.name, title: a.title ?? null, status: a.status ?? null, cwd: typeof ac["cwd"] === "string" ? (ac["cwd"] as string) : null, command, want: desiredFromAdapterConfig(ac) });
      }
      // l'instantané garde les agents des autres entreprises (le job 5 min n'a pas de périmètre)
      const previous = ((await ctx.state.get(SNAPSHOT_KEY)) as AgentSnapshot[] | null) ?? [];
      await ctx.state.set(SNAPSHOT_KEY, [...out, ...previous.filter((p) => p.companyId !== companyId)]);
      return out;
    }

    /**
     * Instances : racines de la référence (~/.hermes du compte, roots, dossier de travail) ; aucun lanceur n'est lu.
     * `probe` (0.6.2) : instances (chemins réels) pour lesquelles une lecture COMPLÈTE est permise — `hermes auth status`
     * avec le binaire administré, journaux d'erreurs. Les autres sont lues en mode léger (fichiers seulement, aucune
     * exécution). Par défaut (`light`), aucune sonde.
     */
    async function instances(light: boolean, probe: Set<string> | null = null): Promise<HermesInstance[]> {
      const read = light ? null : await readAssignments();
      const detected = light ? {} : await detectDashboards();
      const out: HermesInstance[] = [];
      for (const home of await instanceHomes()) {
        try {
          const real = await realOrResolved(home);
          const full = !light && (probe === null || probe.has(real));
          // statut de connexion (`hermes auth status`) seulement avec le binaire administré et vérifié, et seulement si permis
          const exec = full && read && !read.error ? (await execFor(read.table, real)).exec : null;
          out.push(await readInstance(instanceNameFromHome(home), home, null, exec, detected[home] ?? null, { light: !full }));
        } catch (e) {
          log.warn("instance illisible", { home, error: String(e) });
        }
      }
      return out;
    }

    const companyNames = new Map<string, string | null>();
    async function companyName(companyId: string): Promise<string | null> {
      if (companyNames.has(companyId)) return companyNames.get(companyId) ?? null;
      let name: string | null = null;
      try {
        const c = (await ctx.companies.get(companyId)) as { name?: string } | null;
        name = c?.name ?? null;
      } catch {
        /* pas de périmètre entreprise (job) */
      }
      companyNames.set(companyId, name);
      return name;
    }

    /** Instance découverte dont le chemin réel est `real` (les instances de la table sont canoniques). */
    async function instanceByReal(list: HermesInstance[], real: string): Promise<HermesInstance | null> {
      for (const i of list) if ((await realOrResolved(i.home)) === real) return i;
      return null;
    }

    /**
     * Paperclip → Hermes pour une liste d'agents : l'affectation vient UNIQUEMENT de la table. Agent affecté et profil présent →
     * champs déclarés synchronisés ; non affecté → « non affecté » + suggestion par le nom (instances autorisées de son entreprise),
     * aucune écriture dans Hermes ni dans la table. Rien ici n'écrit la table ni la projection.
     */
    async function syncAll(snap: AgentSnapshot[], list: HermesInstance[]): Promise<SyncRecord[]> {
      const previous = ((await ctx.state.get(SYNC_KEY)) as SyncRecord[] | null) ?? [];
      const records: SyncRecord[] = [];
      const read = await readAssignments();
      for (const a of snap) {
        const prepared = previous.find((p) => p.agentId === a.agentId)?.prepared ?? null; // mémoire de ce que la préparation a créé
        const rec: SyncRecord = { agentId: a.agentId, companyId: a.companyId, agentName: a.agentName, instance: null, profile: null, home: null, assignment: null, suggestion: null, want: a.want, cwd: a.cwd, changed: [], error: null, prepared, ignoredCommand: a.command, at: new Date().toISOString() };
        records.push(rec);
        if (read.error) {
          rec.error = `table des affectations refusée : ${read.error} ; aucune écriture`;
          continue;
        }
        const asg = read.table.agents[a.agentId];
        const authorized = read.table.companies[a.companyId]?.instances ?? [];
        if (!asg) {
          // suggestion par le nom, limitée aux instances autorisées de l'entreprise : affichée, jamais appliquée
          const allowed: HermesInstance[] = [];
          for (const i of list) if (authorized.includes(await realOrResolved(i.home))) allowed.push(i);
          const m = matchAgent(a.agentName, allowed);
          rec.suggestion = m ? { instance: m.instance.name, instanceHome: m.instance.home, profile: m.profile.name, by: m.by } : null;
          rec.error = NOT_ASSIGNED_SHORT;
          continue;
        }
        rec.assignment = { instanceHome: asg.instanceHome, profile: asg.profile, assignedAt: asg.assignedAt, assignedBy: asg.assignedBy };
        rec.instance = instanceNameFromHome(asg.instanceHome);
        rec.profile = asg.profile;
        rec.home = profileHome(asg.instanceHome, asg.profile);
        const issue = read.issues.agents[a.agentId];
        if (issue) {
          rec.error = `affectation invalide : ${issue} ; aucune écriture`;
          continue;
        }
        if (asg.companyId !== a.companyId) {
          rec.error = `affectation enregistrée pour une autre entreprise (${asg.companyId}) ; aucune écriture`;
          continue;
        }
        const inst = await instanceByReal(list, asg.instanceHome);
        const profile = inst?.profiles.find((p) => p.name === asg.profile) ?? null;
        if (!inst || !profile) {
          rec.error = `affecté au profil ${rec.home} (${rec.instance}/${asg.profile}) mais ce profil est introuvable : prépare-le (« Préparer l'agent ») ; aucune écriture`;
          continue;
        }
        const unusable = await profileUsability(asg.instanceHome, asg.profile);
        if (unusable) {
          rec.error = `${unusable} ; aucune écriture`;
          continue;
        }
        if (profile.configError) {
          // config.yaml présent mais illisible : aucune écriture, jamais de réécriture
          rec.error = unreadableConfigError(profile.configError);
          log.warn("profil non synchronisé", { agent: a.agentName, profile: `${inst.name}/${profile.name}`, error: rec.error });
          continue;
        }
        const bin = await execFor(read.table, asg.instanceHome);
        if (!bin.exec) {
          rec.error = `binaire Hermes refusé : ${bin.error} ; aucune écriture`;
          continue;
        }
        const r = await syncProfile(profile.home, a.want, bin.exec);
        rec.changed = r.changed;
        rec.error = r.error;
        if (r.changed.length) log.info("Hermes synchronisé", { agent: a.agentName, profile: `${inst.name}/${profile.name}`, changed: r.changed });
      }
      // garder les agents absents de ce passage (autre entreprise)
      const ids = new Set(records.map((r) => r.agentId));
      const merged = [...records, ...previous.filter((p) => !ids.has(p.agentId))];
      await ctx.state.set(SYNC_KEY, merged);
      return merged;
    }

    /** Santé par profil (lecture seule) et état par agent (installé / connecté / connecté et synchronisé). */
    async function healthOf(list: HermesInstance[], sync: SyncRecord[]): Promise<{ health: Record<string, ProfileHealth>; states: Record<string, AgentState>; alerts: string[] }> {
      const health: Record<string, ProfileHealth> = {};
      const alerts: string[] = [];
      const read = await readAssignments();
      // sockets mesurés sur le HERMES_HOME TRANSMIS (racine d'exécution littérale) pour les profils affectés
      // 0.6.2 : TOUT profil d'une instance dotée d'une racine d'exécution (affecté ou non, `default` compris) est mesuré sur
      // le HERMES_HOME littéral qu'il recevrait (racine courte), plus de fausse alerte « socket trop long » sur la racine longue
      const bases = new Map<string, string>();
      if (!read.error) for (const a of Object.values(read.table.agents)) bases.set(profileHome(a.instanceHome, a.profile), executionOf(read.table, a).home);
      for (const i of list) {
        const instReal = await realOrResolved(i.home);
        const rawRoot = read.error ? undefined : read.table.instances?.[instReal]?.executionRoot;
        const ex = rawRoot ? expandExecutionRoot(rawRoot) : null;
        for (const p of i.profiles) {
          const viaRoot = ex?.literal ? executionHome(ex.literal, p.name) : null;
          health[p.home] = await checkProfile(p.home, bases.get(await realOrResolved(p.home)) ?? viaRoot ?? p.home);
          for (const a of health[p.home]!.alerts) alerts.push(`${i.name}/${p.name} : ${a}`);
        }
      }
      const legacy = legacyEnvRefusal();
      if (legacy) alerts.push(legacy);
      if (read.error) alerts.push(read.error);
      const proj = await projectionProblem(read.error ? null : read.sha256);
      if (proj) alerts.push(proj);
      if (!read.error && read.exists) {
        const bin = await verifyHermesBinary(read.table.hermes ?? null);
        if (bin.ok === null && !Object.values(read.table.instances ?? {}).some((x) => x.hermes)) alerts.push(`binaire Hermes : ${bin.error}`);
      }
      for (const [id, why] of Object.entries(read.issues.instances)) alerts.push(`instance ${id} : ${why}`);
      if (!read.error) for (const [i, cids] of Object.entries(sharedInstances(read.table))) alerts.push(`entreprise ${cids.join(", ")} : ${sharedInstanceDiagnostic(i, cids, read.table)}`);
      for (const [id, why] of Object.entries(read.issues.companies)) alerts.push(`entreprise ${id} : ${why}`);
      for (const [id, why] of Object.entries(read.issues.agents)) alerts.push(`agent ${id} : affectation invalide : ${why}`);
      for (const s of sync) if (s.ignoredCommand) alerts.push(`agent ${s.agentId} (« ${s.agentName} ») : hermesCommand ${s.ignoredCommand} ignoré depuis 0.6.1 (seul le binaire administré est lancé) ; retire-le de la configuration de l'agent`);
      const states: Record<string, AgentState> = {};
      for (const s of sync) {
        if (!s.home) continue;
        const profile = list.flatMap((i) => i.profiles).find((p) => p.home === s.home);
        if (profile) states[s.agentId] = agentState(s, profile);
      }
      return { health, states, alerts };
    }

    healthProbe = async () => {
      const sync = ((await ctx.state.get(SYNC_KEY)) as SyncRecord[] | null) ?? [];
      return (await healthOf(await instances(true), sync)).alerts;
    };

    // ---- la seule donnée pour l'interface : lecture + synchro des agents AFFECTÉS ; n'affecte, ne prépare et n'écrit la table JAMAIS ----
    ctx.data.register("instances", async (params) => {
      const companyId = String(params["companyId"] ?? "");
      if (!companyId) throw new Error("companyId manquant");
      const snap = await snapshotAgents(companyId);
      const read = await readAssignments();
      // FILTRE PAR ENTREPRISE AVANT TOUTE SONDE (0.6.2) : instances autorisées pour elle (lecture complète : `hermes auth
      // status`, journaux), ou revendiquées par aucune entreprise (lecture LÉGÈRE seulement, aucune exécution) ; les
      // instances d'une autre entreprise ne sont ni lues ni sondées
      const mine = new Set(read.error ? [] : read.table.companies[companyId]?.instances ?? []);
      const others = new Set(read.error ? [] : Object.entries(read.table.companies).filter(([id]) => id !== companyId).flatMap(([, c]) => c.instances));
      const all = await instances(false, mine);
      const visible: HermesInstance[] = [];
      for (const i of all) {
        const real = await realOrResolved(i.home);
        if (mine.has(real) || !others.has(real)) visible.push(i);
      }
      const sync = (await syncAll(snap, visible)).filter((s) => s.companyId === companyId);
      const ws = await readWorkspace();
      const visibleHomes = new Set(visible.flatMap((i) => i.profiles.map((p) => p.home)));
      const telegram: Record<string, boolean> = {};
      for (const h of visibleHomes) telegram[h] = await telegramConfigured(h);
      const { health: allHealth, states: allStates, alerts } = await healthOf(visible, sync);
      const health: Record<string, ProfileHealth> = {};
      for (const [h, v] of Object.entries(allHealth)) if (visibleHomes.has(h)) health[h] = v;
      const ids = new Set(sync.map((s) => s.agentId));
      const states: Record<string, AgentState> = {};
      for (const [id, st] of Object.entries(allStates)) if (ids.has(id)) states[id] = st;
      const visibleReal = new Set<string>();
      for (const i of visible) visibleReal.add(await realOrResolved(i.home));
      const issues: TableIssues = { companies: {}, agents: {}, instances: {} };
      if (read.issues.companies[companyId]) issues.companies[companyId] = read.issues.companies[companyId]!;
      for (const [id, why] of Object.entries(read.issues.agents)) if (ids.has(id) || read.table.agents[id]?.companyId === companyId) issues.agents[id] = why;
      for (const [id, why] of Object.entries(read.issues.instances)) if (visibleReal.has(id) || mine.has(id)) issues.instances[id] = why;
      const company: CompanyEntry | null = read.table.companies[companyId] ?? null;
      const reference: ReferenceInfo = await referenceInfo();
      const binary = await execFor(read.table, null);
      const projection = await projectionProblem(read.error ? null : read.sha256);
      const assignments = { file: assignmentsFile(), error: read.error, company, issues, reference, referenceLine: describeReference(reference), binary: { ok: !!binary.exec, description: binary.description, error: binary.error }, projection };
      // alertes générales utiles à l'entreprise (table, projection, binaire, référence), sans celles des autres entreprises
      const concernsCompany = (a: string) => a.startsWith("entreprise ") && a.slice("entreprise ".length, a.indexOf(" : ")).split(", ").includes(companyId);
      const generalAlerts = alerts.filter((a) => !/^(agent|entreprise|instance) /.test(a) || [...ids].some((id) => a.includes(id)) || concernsCompany(a));
      return { instances: visible, sync, workspace: ws, telegram, health, states, assignments, alerts: generalAlerts };
    });

    // ---- actions de la page (utilisateur du board seulement) ----
    // 0.6.2 : chaque action part du CONTEXTE D'ACTION AUTORISÉ par Paperclip (src/scope.ts) ; entreprise, agent,
    // affectation et propriétaire de l'instance / du profil sont vérifiés AVANT toute écriture ; un refus n'a aucun effet.

    async function agentOf(companyId: string, agentId: string): Promise<{ snap: AgentSnapshot[]; a: AgentSnapshot }> {
      if (!agentId || !companyId) throw new Error("agentId et companyId requis");
      const snap = await snapshotAgents(companyId);
      const a = snap.find((x) => x.agentId === agentId);
      if (!a) throw new Error("agent Hermes introuvable dans cette entreprise ; rien n'est fait");
      return { snap, a };
    }

    /** Instance (canonique) d'une entreprise : autorisée pour elle, et partagée avec aucune autre (sinon diagnostic, refus). */
    async function ownedInstance(scope: ActionScope, instanceHome: string, what: string): Promise<string> {
      const roots = await knownRoots();
      const c = await canonicalInstance(instanceHome, roots);
      if (c.real === null) throw new Error(`${what} refusé(e) : ${c.error}`);
      const read = await readAssignments({ roots });
      if (read.error) throw new Error(`${read.error} ; rien n'est écrit`);
      const owners = Object.entries(read.table.companies).filter(([, co]) => co.instances.includes(c.real!)).map(([id]) => id);
      if (owners.length > 1) throw new Error(`${what} refusé(e) : ${sharedInstanceDiagnostic(c.real, owners, read.table)}`);
      if (scope.kind === "company" && owners[0] !== scope.companyId) throw new Error(`${what} refusé(e) : ${c.real} n'est pas une instance autorisée de cette entreprise${owners.length ? ` (elle est rattachée à une autre entreprise)` : ""}`);
      return c.real;
    }

    /** Instances autorisées de l'entreprise : les instances déclarées parmi celles découvertes ; une instance d'une autre entreprise est refusée. */
    ctx.actions.register("set-company-instances", async (params, actx) => {
      const { companyId, by } = companyScope(actx, params);
      const raw = params["instances"];
      const wanted = (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split("\n") : []).map(String).map((s) => s.trim()).filter(Boolean);
      const known = await instances(true);
      const knownReal = new Map<string, string>();
      for (const i of known) knownReal.set(await realOrResolved(i.home), i.name);
      for (const w of wanted) if (!knownReal.has(await realOrResolved(w))) throw new Error(`instance inconnue : ${w} (instances découvertes : ${[...knownReal.keys()].join(", ") || "aucune"})`);
      const name = (await companyName(companyId)) ?? companyId;
      const table = await setCompanyInstances(companyId, name, wanted);
      log.info("instances autorisées de l'entreprise", { companyId, instances: table.companies[companyId]?.instances, by });
      return { company: table.companies[companyId] };
    });

    /** Affectation explicite d'un agent à (instance autorisée, profil existant ou à préparer). */
    ctx.actions.register("assign-agent", async (params, actx) => {
      const { companyId, by } = companyScope(actx, params);
      const agentId = String(params["agentId"] ?? "");
      const instanceHome = String(params["instanceHome"] ?? "");
      const profile = String(params["profile"] ?? "");
      if (!instanceHome || !profile) throw new Error("instanceHome et profile requis");
      const { snap, a } = await agentOf(companyId, agentId);
      const list = await instances(true);
      const roots = await knownRoots();
      const c = await canonicalInstance(instanceHome, roots);
      if (c.real === null) throw new Error(`affectation refusée : ${c.error}`);
      const inst = await instanceByReal(list, c.real);
      if (!inst) throw new Error(`affectation refusée : instance non découverte : ${c.real}`);
      const existing = inst.profiles.find((p) => p.name === profile);
      if (!existing && profile !== slug(a.agentName)) throw new Error(`affectation refusée : le profil « ${profile} » n'existe pas dans ${inst.name} (profils présents : ${inst.profiles.map((p) => p.name).join(", ")}) ; seul « ${slug(a.agentName)} » peut être affecté avant d'être préparé`);
      const r = await assignAgent({ agentId, companyId, companyName: await companyName(companyId), instanceHome: c.real, profile, name: a.agentName, assignedBy: by }, { roots });
      log.info("agent affecté", { agent: a.agentName, agentId, profile: `${inst.name}/${profile}`, by, toPrepare: !existing });
      await syncAll(snap, list);
      return { assignment: r, toPrepare: !existing };
    });

    /**
     * Désaffectation (0.6.2) : l'agent doit être un agent Hermes de l'entreprise autorisée, et son affectation (s'il en a
     * une) celle de cette entreprise ; une affectation orpheline (agent supprimé de Paperclip) de CETTE entreprise peut
     * être retirée. Vérifié avant l'écriture (et de nouveau sous le verrou de la table).
     */
    ctx.actions.register("unassign-agent", async (params, actx) => {
      const { companyId, by } = companyScope(actx, params);
      const agentId = String(params["agentId"] ?? "");
      if (!agentId) throw new Error("agentId requis");
      const read = await readAssignments();
      if (read.error) throw new Error(`${read.error} ; rien n'est écrit`);
      const current = read.table.agents[agentId] ?? null;
      const snap = await snapshotAgents(companyId);
      const listed = snap.find((x) => x.agentId === agentId) ?? null;
      if (current && current.companyId !== companyId) throw new Error(`désaffectation refusée : l'agent ${agentId} est affecté pour une autre entreprise ; rien n'est écrit`);
      if (!listed && !current) throw new Error("désaffectation refusée : agent Hermes introuvable dans cette entreprise ; rien n'est écrit");
      const removed = await unassignAgent(agentId, { companyId });
      log.info("agent désaffecté", { agentId, by, removed, orphan: !listed });
      await syncAll(snap, await instances(true));
      return { removed };
    });

    /** Prépare le profil + dossiers d'un agent dans une instance EXPLICITE (autorisée pour l'entreprise) et l'affecte en même temps. */
    ctx.actions.register("prepare-agent", async (params, actx) => {
      const { companyId, by } = companyScope(actx, params);
      const agentId = String(params["agentId"] ?? "");
      const { snap, a } = await agentOf(companyId, agentId);
      const ws = await readWorkspace();
      if (ws && (await projectionMode(ws))) {
        // lot B (prototype) : identité, alias, instance et dossiers viennent de la projection du pack ; rien n'est affecté ici
        const name = await companyName(companyId);
        const asked = String(params["instanceHome"] ?? "").trim() || undefined;
        const r = await prepareByIdentity({ ws, companyId, agentId, title: a.title, entreprise: name, askedInstance: asked, binaryFor: async (table, inst) => {
          const bin = await execFor(table, inst);
          if (!bin.exec) throw new Error(`préparation refusée : binaire Hermes refusé : ${bin.error}`);
          return bin.exec;
        } });
        log.info("agent préparé (projection)", { agent: a.agentName, alias: `${r.identity.companyAlias}/${r.identity.agentAlias}`, instance: r.identity.instanceAlias, created: r.created.length, warnings: r.warnings, by });
        await syncAll(snap, await instances(true));
        return { created: r.created, warnings: r.warnings };
      }
      if (!ws || !(await exists(ws.profils))) throw new Error("pas de dossier de travail (~/.config/hermes-control/workspace) ou son dossier hermes/profils n'existe pas");
      const roots = await knownRoots();
      const read = await readAssignments({ roots });
      if (read.error) throw new Error(`${read.error} ; rien n'est préparé`);
      const current = read.table.agents[agentId] ?? null;
      if (current && current.companyId !== companyId) throw new Error("préparation refusée : l'agent est affecté pour une autre entreprise ; rien n'est préparé");
      const s = slug(a.agentName);
      let instanceHome = String(params["instanceHome"] ?? "").trim();
      if (current) {
        if (current.profile !== s) throw new Error(`agent déjà affecté au profil ${profileHome(current.instanceHome, current.profile)} (≠ « ${s} ») : rien à préparer ; désaffecte-le d'abord pour changer`);
        if (instanceHome && (await canonicalInstance(instanceHome, roots)).real !== current.instanceHome) throw new Error(`agent déjà affecté à ${current.instanceHome} ; désaffecte-le d'abord pour changer d'instance`);
        instanceHome = current.instanceHome;
      }
      if (!instanceHome) throw new Error("instanceHome requis : choisis une instance autorisée de l'entreprise");
      const c = await canonicalInstance(instanceHome, roots);
      if (c.real === null) throw new Error(`préparation refusée : ${c.error}`);
      const company = read.table.companies[companyId];
      if (!company || !company.instances.includes(c.real)) throw new Error(`préparation refusée : ${c.real} n'est pas une instance autorisée de l'entreprise (autorisées : ${company?.instances.join(", ") || "aucune — déclare-les d'abord"})`);
      const taken = Object.entries(read.table.agents).find(([id, x]) => id !== agentId && x.instanceHome === c.real && x.profile === s);
      if (taken) throw new Error(`préparation refusée : le profil ${profileHome(c.real, s)} est déjà affecté à « ${taken[1].name} » (${taken[0]})`);
      const name = await companyName(companyId);
      const bin = await execFor(read.table, c.real);
      if (!bin.exec) throw new Error(`préparation refusée : binaire Hermes refusé : ${bin.error}`);
      // lot B : propriétaire du dossier métier = cette identité ; T16 mesuré sur le HERMES_HOME littéral (racine d'exécution)
      const r = await prepareAgent({ ws, instanceHome: c.real, agentName: a.agentName, title: a.title, binary: bin.exec, entreprise: name, owner: { companyId, agentId }, executionHome: executionOf(read.table, { instanceHome: c.real, profile: s }).home });
      if (!current) await assignAgent({ agentId, companyId, companyName: name, instanceHome: c.real, profile: s, name: a.agentName, assignedBy: by }, { roots });
      log.info("agent préparé", { agent: a.agentName, profile: `${instanceNameFromHome(c.real)}/${r.profile}`, created: r.created.length, warnings: r.warnings, by });
      const sync = await syncAll(snap, await instances(true));
      const rec = sync.find((x) => x.agentId === agentId);
      if (rec) {
        rec.prepared = r.created;
        await ctx.state.set(SYNC_KEY, sync);
      }
      return { created: r.created, warnings: r.warnings };
    });

    /**
     * Binaire Hermes administré (0.6.2, contrat vérifiable) :
     *  - GLOBAL (sans instanceHome) : seulement par un appel SANS entreprise, que Paperclip réserve à l'administrateur
     *    d'instance (assertInstanceAdmin) ; dans le périmètre d'une entreprise → refus, rien n'est écrit ;
     *  - par INSTANCE : instance autorisée pour l'entreprise du contexte et non partagée (ou appel administrateur sans
     *    entreprise, instance non partagée). Vérifié avant d'être écrit.
     */
    ctx.actions.register("set-hermes-binary", async (params, actx) => {
      const scope = actionScope(actx, params);
      const binary = String(params["binary"] ?? "").trim();
      const linkTarget = String(params["linkTarget"] ?? "").trim();
      const sha = String(params["sha256"] ?? "").trim();
      const instanceHome = String(params["instanceHome"] ?? "").trim();
      let key: string | null = null;
      if (instanceHome) key = await ownedInstance(scope, instanceHome, "binaire");
      else adminScope(actx, params, "binaire Hermes global");
      const spec: HermesBinarySpec | null = binary ? { binary, ...(linkTarget ? { linkTarget } : {}), ...(sha ? { sha256: sha } : {}) } : null;
      await setHermesBinary(spec, { instanceHome: key });
      const v = spec ? await verifyHermesBinary(spec) : null;
      log.info("binaire Hermes administré", { instance: key ?? "global", binary: spec?.binary ?? null, by: scope.by, scope: scope.kind === "company" ? scope.companyId : "administrateur" });
      return { binary: spec?.binary ?? null, scope: key ?? "global", description: v?.ok ? describeBinary(v.ok) : null };
    });

    /** Racine d'exécution littérale (courte) d'une instance AUTORISÉE de l'entreprise et non partagée : même instance (realpath) exigée. */
    ctx.actions.register("set-execution-root", async (params, actx) => {
      const scope = companyScope(actx, params);
      const instanceHome = String(params["instanceHome"] ?? "").trim();
      const executionRoot = String(params["executionRoot"] ?? "").trim();
      const real = await ownedInstance({ kind: "company", ...scope }, instanceHome, "racine d'exécution");
      await setExecutionRoot(real, executionRoot || null);
      log.info("racine d'exécution", { instance: real, executionRoot: executionRoot || null, by: scope.by });
      return { instance: real, executionRoot: executionRoot || null };
    });

    /**
     * Jeton Telegram (0.6.2) : désigné par l'AGENT, plus par un chemin. L'agent doit être un agent Hermes de l'entreprise
     * autorisée, affecté pour elle (affectation valide), à une instance qu'elle seule possède ; le profil écrit est celui
     * de l'affectation (un `home` fourni doit lui être identique). Tout est vérifié avant la moindre écriture (.env,
     * passerelle).
     */
    ctx.actions.register("set-telegram", async (params, actx) => {
      const scope = companyScope(actx, params);
      const agentId = String(params["agentId"] ?? "");
      const askedHome = String(params["home"] ?? "").trim();
      const token = String(params["token"] ?? "");
      if (!agentId) throw new Error("agentId requis : le jeton Telegram s'enregistre pour un agent affecté, jamais pour un chemin libre ; rien n'est écrit");
      const { a } = await agentOf(scope.companyId, agentId);
      const roots = await knownRoots();
      const read = await readAssignments({ roots });
      if (read.error) throw new Error(`${read.error} ; rien n'est écrit`);
      const asg = read.table.agents[agentId];
      if (!asg) throw new Error(`passerelle refusée : « ${a.agentName} » est non affecté ; rien n'est écrit`);
      if (asg.companyId !== scope.companyId) throw new Error("passerelle refusée : affectation enregistrée pour une autre entreprise ; rien n'est écrit");
      const issue = read.issues.agents[agentId];
      if (issue) throw new Error(`passerelle refusée : affectation invalide : ${issue} ; rien n'est écrit`);
      await ownedInstance({ kind: "company", ...scope }, asg.instanceHome, "passerelle");
      const home = profileHome(asg.instanceHome, asg.profile);
      if (askedHome && (await realOrResolved(askedHome)) !== home) throw new Error(`passerelle refusée : le profil demandé (${askedHome}) n'est pas celui de l'affectation de « ${a.agentName} » (${home}) ; rien n'est écrit`);
      const list = await instances(true);
      const known = list.flatMap((i) => i.profiles.map((p) => p.home));
      const knownReal: string[] = [];
      for (const k of known) knownReal.push(await realOrResolved(k));
      if (!knownReal.includes(home)) throw new Error(`passerelle refusée : profil ${home} introuvable (à préparer) ; rien n'est écrit`);
      const bin = await execFor(read.table, asg.instanceHome);
      if (!bin.exec) throw new Error(`passerelle refusée : binaire Hermes refusé : ${bin.error}`);
      // HERMES_HOME transmis : la racine d'exécution littérale de l'instance (sockets courts), même profil
      const gatewayHome = executionOf(read.table, asg).home;
      // un seul set-telegram à la fois : le garde-fou « passerelle unique » lit puis écrit
      const lock = join(controlDir(), "set-telegram.lock");
      return withDirLock(lock, { waitMs: 2_000, staleMs: 30_000, busy: "un autre enregistrement de jeton Telegram est en cours ; réessaie" }, async () => {
        await assertGatewayFree(home, known); // une seule passerelle Telegram par machine
        const changed = await setTelegramToken(home, token);
        let gateway = "";
        try {
          gateway = (await startGateway(gatewayHome, bin.exec!)).trim().split("\n").slice(-2).join(" ");
        } catch (e) {
          gateway = e instanceof Error ? e.message : String(e);
        }
        log.info("jeton Telegram enregistré", { agentId, home: join(home, ".env"), changed, by: scope.by });
        return { changed, gateway };
      });
    });

    // ---- un agent créé ou modifié (renommé…) dans Paperclip → seuls les agents AFFECTÉS sont synchronisés ; rien n'est affecté ni préparé ----
    for (const type of ["agent.updated", "agent.created"] as const) {
      ctx.events.on(type, async (event) => {
        const companyId = String((event as { companyId?: string }).companyId ?? "");
        if (!companyId) return;
        try {
          const snap = await snapshotAgents(companyId);
          await syncAll(snap, await instances(true));
        } catch (e) {
          log.warn("synchronisation après événement impossible", { type, error: String(e) });
        }
      });
    }

    // ---- filet toutes les 5 min, sans périmètre entreprise : on repart du dernier instantané ----
    ctx.jobs.register("sync", async () => {
      const snap = ((await ctx.state.get(SNAPSHOT_KEY)) as AgentSnapshot[] | null) ?? [];
      if (!snap.length) return;
      await syncAll(snap, await instances(true));
    });

    log.info("Hermes Control prêt (Paperclip → Hermes, affectation explicite)", { reference: describeReference(await referenceInfo()) });
  },

  async onHealth() {
    if (!healthProbe) return { status: "ok" as const, message: "Hermes Control" };
    try {
      const alerts = await healthProbe();
      if (!alerts.length) return { status: "ok" as const, message: "Hermes Control" };
      return { status: "degraded" as const, message: `Hermes Control : ${alerts.length} alerte(s) — ${alerts[0]}`, details: { alerts } };
    } catch (e) {
      return { status: "error" as const, message: `Hermes Control : sonde de santé en échec (${e instanceof Error ? e.message : String(e)})` };
    }
  },
});

export default plugin;
// Démarre la boucle JSON-RPC quand Paperclip lance `node dist/worker.js` ; inerte à l'import (tests).
runWorker(plugin, import.meta.url);
