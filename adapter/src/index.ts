// Adaptateur « Hermes Control » : remplace l'adaptateur Hermes intégré de Paperclip (même type `hermes_local`),
// identique en tout sauf :
//  - les menus Provider / Model de l'agent proposent les providers et modèles connus de Hermes ;
//  - l'agent tourne dans le profil Hermes qui lui est AFFECTÉ EXPLICITEMENT (table ~/.config/hermes-control/assignments.json,
//    écrite par les actions d'administration du plugin ; agents.json n'est qu'une projection de secours à même empreinte) ;
//    sans affectation, affectation invalide (instance plus autorisée pour l'entreprise de l'agent, profil revendiqué deux
//    fois, instance hors racines), config.yaml absent/invalide, profil en préparation interrompue, chemin de socket trop
//    long ou lanceur-script incertain / divergent → il REFUSE de tourner (R02b : contrôle avant réveil, même « connecté ») ;
//  - les skills assignés à l'agent dans Paperclip sont liés dans `<profil>/skills` (là où Hermes les lit),
//    à la synchro Paperclip et à chaque passage ; décochés → liens retirés.
// Auteur : Cyril M — MIT.
import { createHermesLocalServerAdapter } from "@paperclipai/hermes-paperclip-adapter";
import { access, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { discoverLight } from "../../src/discovery.js";
import { type HermesInstance, homeFromLauncherFile, readConfigStrict, readModelCatalogs } from "../../src/hermes.js";
import { agentsMapError } from "../../src/agents-map.js";
import { type ResolvedAssignment, assignmentsFile, isApprovedBinary, resolveAssignment } from "../../src/assignments.js";
import { checkSocketPaths, socketPathAlert } from "../../src/health.js";
import { slug } from "../../src/match.js";
import { profileUsability } from "../../src/prepare.js";
import { exists, readWorkspace } from "../../src/workspace.js";
import { reconcileIntoProfile, snapshotForProfile } from "./skills.js";

type AnyRecord = Record<string, unknown>;
type Base = ReturnType<typeof createHermesLocalServerAdapter>;

const LIGHT_TTL_MS = 10_000;
let lightCache: { at: number; value: HermesInstance[] } | null = null;

async function instances(): Promise<HermesInstance[]> {
  if (lightCache && Date.now() - lightCache.at < LIGHT_TTL_MS) return lightCache.value;
  const value = await discoverLight([], await hermesBinary());
  lightCache = { at: Date.now(), value };
  return value;
}

/** Binaire hermes : HERMES_CONTROL_HERMES_BIN (chemin explicite), sinon ~/.local/bin/hermes si présent, sinon « hermes » (PATH de Paperclip). */
async function hermesBinary(): Promise<string> {
  const explicit = process.env["HERMES_CONTROL_HERMES_BIN"]?.trim();
  if (explicit) return explicit;
  const local = join(homedir(), ".local", "bin", "hermes");
  try {
    await access(local, fsConstants.X_OK);
    return local;
  } catch {
    return "hermes";
  }
}

/** Providers réellement configurés dans les profils Hermes (ordre : le plus fréquent d'abord). */
function providersOf(list: HermesInstance[]): string[] {
  const count = new Map<string, number>();
  for (const i of list) for (const p of i.profiles) if (p.provider && p.provider !== "auto") count.set(p.provider, (count.get(p.provider) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

function providerLabel(p: string): string {
  if (p === "auto") return "Auto";
  if (p === "openai-codex") return "OpenAI Codex (GPT)";
  return p.split("-").map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(" ");
}

/** Modèles connus de Hermes pour les providers configurés (catalogue `provider_models_cache.json`). */
async function hermesModels(list: HermesInstance[]): Promise<{ id: string; label: string }[]> {
  const providers = providersOf(list);
  const seen = new Set<string>();
  const out: { id: string; label: string }[] = [];
  for (const i of list) {
    const catalogs = await readModelCatalogs(i.home);
    for (const prov of providers.length ? providers : Object.keys(catalogs)) {
      for (const m of catalogs[prov] ?? []) {
        if (seen.has(m)) continue;
        seen.add(m);
        out.push({ id: m, label: providers.length > 1 ? `${m} (${prov})` : m });
      }
    }
    // modèles déjà choisis dans les profils, même absents du catalogue
    for (const p of i.profiles) if (p.model && !seen.has(p.model)) { seen.add(p.model); out.push({ id: p.model, label: p.model }); }
  }
  return out;
}

async function realOrResolved(p: string): Promise<string> {
  return (await realpath(p).catch(() => null)) ?? resolve(p);
}

/**
 * Affectation d'un agent, contrôlée AVANT tout passage : entrée valide dans la table (entreprise de l'agent, instance autorisée,
 * profil non revendiqué, instance dans une racine connue), profil présent (config.yaml) et lisible, profil utilisable (aucune
 * préparation interrompue), chemins de sockets de la version épinglée sous la limite, et lanceur cohérent : un binaire Hermes
 * approuvé est accepté tel quel ; un SCRIPT doit se lire sans incertitude et viser exactement le profil affecté.
 */
async function assignmentOf(agent: { id?: string; name: string; companyId?: string | null }, command: string | null): Promise<ResolvedAssignment> {
  const r = await resolveAssignment(agent.id ?? "", { companyId: agent.companyId ?? null });
  const name = agent.name;
  if (!r.ok) {
    const mapErr = await agentsMapError();
    throw new Error(`[hermes-control] « ${name} » : ${r.reason}${mapErr ? ` — ${mapErr}` : ""} ; aucun passage.`);
  }
  const rec = r.ok;
  const label = `${rec.instanceHome.split("/").pop()}/${rec.profile}`;
  if (!(await exists(join(rec.home, "config.yaml")))) {
    throw new Error(`[hermes-control] « ${name} » : affecté à ${label} mais ${rec.home}/config.yaml n'existe pas (profil à préparer : page Hermes → « Préparer l'agent ») ; aucun passage.`);
  }
  const { error } = await readConfigStrict(rec.home);
  if (error) throw new Error(`[hermes-control] « ${name} » : ${rec.home}/${error} ; aucun passage tant que le fichier n'est pas réparé.`);
  const unusable = await profileUsability(rec.instanceHome, rec.profile);
  if (unusable) throw new Error(`[hermes-control] « ${name} » : ${unusable} ; aucun passage.`);
  const sock = await checkSocketPaths(rec.home);
  if (!sock.socketPathOk) throw new Error(`[hermes-control] « ${name} » : ${socketPathAlert(sock)} ; aucun passage (le watchdog de Hermes ne pourrait pas ouvrir son socket).`);
  if (command && !isApprovedBinary(command, { approvedBinaries: r.approvedBinaries })) {
    // un script lanceur : toute incertitude est un refus, jamais une conformité
    const fromLauncher = await homeFromLauncherFile(command);
    if (fromLauncher.home === null) throw new Error(`[hermes-control] « ${name} » : lanceur incertain, refus : ${fromLauncher.error}. Déclare un binaire Hermes approuvé (HERMES_CONTROL_HERMES_BIN ou approvedBinaries dans ${assignmentsFile()}) ou corrige le lanceur.`);
    const [a, b] = await Promise.all([realOrResolved(rec.home), realOrResolved(fromLauncher.home)]);
    if (a !== b) throw new Error(`[hermes-control] « ${name} » : affectation (table) ≠ lanceur : ${a} vs ${b} (${command}) ; corrige l'un ou l'autre.`);
  }
  return rec;
}

/** `base` injectable (tests) : par défaut l'adaptateur Hermes officiel. */
export function createServerAdapter(base: Base = createHermesLocalServerAdapter()): Base {
  const execute: Base["execute"] = async (ctx) => {
    const c = ctx as unknown as { config?: AnyRecord; onLog?: (stream: "stdout" | "stderr", text: string) => Promise<void> | void; agent: { id?: string; name: string; companyId?: string | null; adapterConfig?: unknown } };
    const config: AnyRecord = { ...((c.config ?? (c.agent.adapterConfig as AnyRecord | undefined)) ?? {}) };
    const command = typeof config["hermesCommand"] === "string" && (config["hermesCommand"] as string).trim() ? (config["hermesCommand"] as string).trim() : null;
    let m: ResolvedAssignment;
    try {
      m = await assignmentOf(c.agent, command);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await c.onLog?.("stderr", msg + "\n");
      throw e;
    }
    const env = { ...((config["env"] as AnyRecord | undefined) ?? {}), HERMES_HOME: m.home };
    config["env"] = env;
    // pas de working directory choisi dans Paperclip → le dossier de l'agent dans le dossier de travail commun, s'il existe
    if (typeof config["cwd"] !== "string" || !(config["cwd"] as string).trim()) {
      const ws = await readWorkspace();
      const dir = ws ? join(ws.agents, slug(c.agent.name)) : null;
      if (dir && (await exists(dir))) {
        config["cwd"] = dir;
        await c.onLog?.("stdout", `[hermes-control] working directory = ${dir}\n`);
      }
    }
    if (typeof config["hermesCommand"] !== "string" || !(config["hermesCommand"] as string).trim()) config["hermesCommand"] = await hermesBinary();
    await c.onLog?.("stdout", `[hermes-control] ${c.agent.name} → Hermes ${m.instanceHome.split("/").pop()}/${m.profile} (affectation explicite, ${m.source === "table" ? "table" : "projection à même empreinte"}, par ${m.assignedBy} le ${m.assignedAt}) · HERMES_HOME=${m.home}\n`);
    if (Object.prototype.hasOwnProperty.call(config, "paperclipRuntimeSkills")) {
      try {
        const r = await reconcileIntoProfile(config, m.home);
        const removed = r.removed.length ? ` (retirés : ${r.removed.join(", ")})` : "";
        if (r.linked.length || r.removed.length) await c.onLog?.("stdout", `[hermes-control] skills Paperclip liés dans ${r.skillsDir} : ${r.linked.join(", ") || "aucun"}${removed}\n`);
        for (const w of r.warnings) await c.onLog?.("stderr", `[hermes-control] ${w}\n`);
      } catch (err) {
        await c.onLog?.("stderr", `[hermes-control] skills Paperclip non liés dans le profil : ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    return base.execute({ ...(ctx as object), config, agent: { ...(c.agent as object), adapterConfig: config } } as unknown as Parameters<Base["execute"]>[0]);
  };

  const getConfigSchema: NonNullable<Base["getConfigSchema"]> = async () => {
    const schema = await base.getConfigSchema!();
    const list = await instances();
    const providers = providersOf(list);
    const fields = schema.fields.map((f) => {
      if (f.key !== "provider") return f;
      const options = ["auto", ...providers].map((p) => ({ value: p, label: providerLabel(p) }));
      return { ...f, options, default: providers[0] ?? "auto", hint: `Providers configurés dans Hermes : ${providers.join(", ") || "aucun"}.` };
    });
    return { ...schema, fields };
  };

  const testEnvironment: Base["testEnvironment"] = async (ctx) => {
    const result = await base.testEnvironment(ctx);
    const list = await instances();
    const summary = list.map((i) => `${i.name} (${i.profiles.map((p) => p.name).join(", ")})`).join(" · ");
    result.checks.push({
      code: "hermes_control.instances",
      level: list.length ? "info" : "error",
      message: list.length ? `Hermes Control : ${list.length} instance(s) trouvée(s)` : "Hermes Control : aucune instance Hermes trouvée",
      detail: list.length ? summary : null,
      hint: list.length ? `Un agent tourne seulement dans le profil qui lui est affecté explicitement (${assignmentsFile()}, écrit par les actions d'affectation du plugin Hermes Control).` : "Ajoute le dossier des instances dans ~/.config/hermes-control/roots (une ligne par dossier).",
    });
    if (!list.length) result.status = "fail";
    return result;
  };

  /** Profil Hermes d'un agent connu seulement par son id (listSkills / syncSkills) : table des affectations explicites. */
  async function profileOf(agentId: string, companyId: string | null | undefined): Promise<{ home: string; label: string } | null> {
    const r = await resolveAssignment(agentId, { companyId: companyId ?? null });
    return r.ok ? { home: r.ok.home, label: `${r.ok.instanceHome.split("/").pop()}/${r.ok.profile}` } : null;
  }
  const UNKNOWN_PROFILE = "Hermes Control : profil Hermes inconnu tant que l'agent n'est pas affecté explicitement (page Hermes → « Affecter » ou « Préparer l'agent ») ; les liens de skills seront posés dans son profil au prochain passage.";

  const listSkills: NonNullable<Base["listSkills"]> = async (ctx) => {
    const snap = await base.listSkills!(ctx);
    const p = await profileOf(ctx.agentId, (ctx as { companyId?: string | null }).companyId);
    if (!p) return { ...snap, warnings: [...snap.warnings, UNKNOWN_PROFILE] };
    return snapshotForProfile(snap, p.home, p.label);
  };

  const syncSkills: NonNullable<Base["syncSkills"]> = async (ctx, desired) => {
    const snap = await base.syncSkills!(ctx, desired);
    const p = await profileOf(ctx.agentId, (ctx as { companyId?: string | null }).companyId);
    if (!p) return { ...snap, warnings: [...snap.warnings, UNKNOWN_PROFILE] };
    const r = await reconcileIntoProfile(ctx.config, p.home, desired);
    const out = await snapshotForProfile(snap, p.home, p.label);
    return { ...out, warnings: [...out.warnings, ...r.warnings] };
  };

  return {
    ...base,
    execute,
    testEnvironment,
    getConfigSchema,
    listSkills,
    syncSkills,
    listModels: async () => hermesModels(await instances()),
    refreshModels: async () => {
      lightCache = null;
      return hermesModels(await instances());
    },
    // ne devine plus à partir du premier profil venu : l'affectation est explicite (assignments.json)
    detectModel: async () => (base.detectModel ? base.detectModel() : null),
  };
}
