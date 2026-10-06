// Adaptateur « Hermes Control » : remplace l'adaptateur Hermes intégré de Paperclip (même type `hermes_local`),
// identique en tout sauf :
//  - les menus Provider / Model de l'agent proposent les providers et modèles connus de Hermes ;
//  - EXÉCUTION MAÎTRISÉE (0.6.1, src/execution.ts) : l'agent tourne seulement dans le profil qui lui est AFFECTÉ
//    EXPLICITEMENT (table <référence>/assignments.json, référence = <compte>/.config/hermes-control, la même que le plugin) ;
//    l'adaptateur construit lui-même la commande : binaire Hermes ADMINISTRÉ (chemin absolu vérifié), HERMES_HOME =
//    racine d'exécution littérale + profil, environnement explicite. Le `hermesCommand` de l'agent, un nom nu ou le PATH
//    ne servent jamais à lancer ; aucun script lanceur n'est lu ni exécuté ;
//  - tout refus de CONFIGURATION (non affecté, table refusée, affectation invalide, profil inutilisable, binaire refusé,
//    racine d'exécution incohérente, socket trop long, -p dans extraArgs) est RENDU comme un échec `configuration_incomplete`
//    (Paperclip 2026.1001.0 bloque alors le ticket pour un humain au lieu de replanifier) ; Hermes n'est pas appelé ;
//  - les skills assignés à l'agent dans Paperclip sont liés dans `<profil>/skills` (là où Hermes les lit),
//    à la synchro Paperclip et à chaque passage ; décochés → liens retirés.
// Auteur : Cyril M — MIT.
import { createHermesLocalServerAdapter } from "@paperclipai/hermes-paperclip-adapter";
import { join } from "node:path";
import { discoverLight } from "../../src/discovery.js";
import { type HermesInstance, readModelCatalogs } from "../../src/hermes.js";
import { agentsMapError } from "../../src/agents-map.js";
import { assignmentsFile, resolveAssignment } from "../../src/assignments.js";
import { describeBinary } from "../../src/binary.js";
import { type ExecutionPlan, HermesControlRefusal, buildAgentEnv, checkExtraArgs, planExecution } from "../../src/execution.js";
import { slug } from "../../src/match.js";
import { describeReference, referenceInfo } from "../../src/reference.js";
import { exists, readWorkspace } from "../../src/workspace.js";
import { reconcileIntoProfile, snapshotForProfile } from "./skills.js";

type AnyRecord = Record<string, unknown>;
type Base = ReturnType<typeof createHermesLocalServerAdapter>;

const LIGHT_TTL_MS = 10_000;
let lightCache: { at: number; value: HermesInstance[] } | null = null;

async function instances(): Promise<HermesInstance[]> {
  if (lightCache && Date.now() - lightCache.at < LIGHT_TTL_MS) return lightCache.value;
  const value = await discoverLight([]); // lecture seule : aucun appel à Hermes
  lightCache = { at: Date.now(), value };
  return value;
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

/** Code d'erreur que Paperclip 2026.1001.0 traite comme NON réessayable (recovery → ticket bloqué pour un humain). */
export const REFUSAL_ERROR_CODE = "configuration_incomplete";

/** Résultat d'échec rendu à Paperclip pour un refus de configuration (pas d'exception : une exception devient « adapter_failed », réessayé). */
function refusalResult(agent: { id?: string; name: string; companyId?: string | null }, refusal: HermesControlRefusal, message: string) {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    errorMessage: message,
    errorCode: REFUSAL_ERROR_CODE,
    resultJson: {
      configurationIncomplete: {
        reason: `hermes_control_${refusal.kind}`,
        companyId: agent.companyId ?? null,
        agentId: agent.id ?? null,
        // empreinte stable : un même refus répété réutilise la même action de reprise côté Paperclip
        fingerprint: `hermes_control:${refusal.kind}:${agent.id ?? "?"}`,
        missingBindings: [],
      },
      hermesControl: { refused: true, kind: refusal.kind },
    },
  };
}

/** `base` injectable (tests) : par défaut l'adaptateur Hermes officiel. */
export function createServerAdapter(base: Base = createHermesLocalServerAdapter()): Base {
  const execute: Base["execute"] = async (ctx) => {
    const c = ctx as unknown as { config?: AnyRecord; onLog?: (stream: "stdout" | "stderr", text: string) => Promise<void> | void; agent: { id?: string; name: string; companyId?: string | null; adapterConfig?: unknown } };
    const config: AnyRecord = { ...((c.config ?? (c.agent.adapterConfig as AnyRecord | undefined)) ?? {}) };
    let plan: ExecutionPlan;
    try {
      const badArgs = checkExtraArgs(config["extraArgs"]);
      if (badArgs) throw new HermesControlRefusal("arguments", badArgs);
      plan = await planExecution(c.agent);
    } catch (e) {
      if (e instanceof HermesControlRefusal) {
        const mapErr = await agentsMapError().catch(() => null);
        const msg = `[hermes-control] « ${c.agent.name} » : refus (${e.kind}) : ${e.message}${mapErr ? ` — ${mapErr}` : ""} ; Hermes n'est pas lancé.`;
        await c.onLog?.("stderr", msg + "\n");
        return refusalResult(c.agent, e, msg) as Awaited<ReturnType<Base["execute"]>>;
      }
      throw e; // erreur inattendue (disque, etc.) : temporaire, Paperclip peut réessayer
    }
    const m = plan.assignment;
    // la commande : le binaire ADMINISTRÉ, jamais celui de l'agent
    const ignored = [config["hermesCommand"], config["command"]].filter((x) => typeof x === "string" && (x as string).trim() && x !== plan.binary.path) as string[];
    config["hermesCommand"] = plan.binary.path;
    delete config["command"];
    const { env, dropped } = buildAgentEnv(config["env"], plan);
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
    await c.onLog?.("stdout", `[hermes-control] ${c.agent.name} → Hermes ${m.instanceHome.split("/").pop()}/${m.profile} (affectation explicite, ${m.source === "table" ? "table" : "projection à même empreinte"}, par ${m.assignedBy} le ${m.assignedAt}) · HERMES_HOME=${plan.hermesHome}${plan.hermesHome !== m.home ? ` (= ${m.home})` : ""} · socket max ${plan.socket.socketPathBytes} octets · binaire ${describeBinary(plan.binary)}\n`);
    if (ignored.length) await c.onLog?.("stdout", `[hermes-control] commande de l'agent ignorée (${ignored.join(", ")}) : seul le binaire administré est lancé\n`);
    if (dropped.length) await c.onLog?.("stdout", `[hermes-control] env de l'agent : ${dropped.join(", ")} ignoré(s) (administré par Hermes Control)\n`);
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
      hint: list.length ? `Un agent tourne seulement dans le profil qui lui est affecté explicitement (${assignmentsFile()}, écrit par les actions d'affectation du plugin Hermes Control), avec le binaire Hermes administré dans cette table.` : "Ajoute le dossier des instances dans <référence>/roots (une ligne par dossier).",
    });
    const ref = await referenceInfo();
    result.checks.push({
      code: "hermes_control.reference",
      level: ref.legacyEnv.length ? "error" : "info",
      message: `Hermes Control : ${describeReference(ref)}`,
      detail: null,
      hint: ref.legacyEnv.length ? `Retire ${ref.legacyEnv.join(", ")} de l'environnement du service : plus lues depuis 0.6.1.` : "Plugin et adaptateur lisent ce même dossier (calculé depuis le compte Unix, pas depuis l'environnement).",
    });
    if (!list.length || ref.legacyEnv.length) result.status = "fail";
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
