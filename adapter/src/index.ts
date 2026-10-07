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
//    à la synchro Paperclip et à chaque passage ; décochés → liens retirés. 0.6.2 : profil résolu d'abord, jamais
//    d'écriture ni de lecture dans `$HOME/.hermes/skills` (l'inventaire n'est plus transmis à l'adaptateur officiel) ;
//  - 0.6.2 : « Test environment » STATIQUE (rien n'est exécuté) ; un échec d'authentification du MODÈLE est rendu
//    `configuration_incomplete` (pas de relance en boucle), une panne transitoire reste réessayable.
// 0.6.3 (recette seulement) — VOIE 1 : l'adaptateur officiel et adapter-utils sont des COPIES CORRIGÉES localement
// (adapter/voie1 : base 2026.1001.0 publiée + correctifs, intégrité et empreintes vérifiées à la fabrication). Le processus
// Hermes reçoit un environnement FINAL construit par liste blanche (rien du serveur ; HOME/USER/LOGNAME du compte) ;
// l'annulation est portée par le correctif (signal du serveur → groupe arrêté → acquittement seulement si le groupe est
// vide). Au passage, l'adaptateur VÉRIFIE que les copies réellement chargées sont corrigées, sinon refus.
// Auteur : Cyril M — MIT.
import { createHermesLocalServerAdapter } from "@paperclipai/hermes-paperclip-adapter";
import * as hermesServer from "@paperclipai/hermes-paperclip-adapter/server";
import { join } from "node:path";
import { discoverLight } from "../../src/discovery.js";
import { type HermesInstance, readModelCatalogs } from "../../src/hermes.js";
import { agentsMapError } from "../../src/agents-map.js";
import { assignmentsFile, hermesSpecFor, readAssignments, resolveAssignment } from "../../src/assignments.js";
import { describeBinary, verifyHermesBinary } from "../../src/binary.js";
import { ADMINISTERED_ENV, type ExecutionPlan, HermesControlRefusal, NEUTRALIZED_ENV, buildAgentEnv, checkExtraArgs, planExecution } from "../../src/execution.js";
import { slug } from "../../src/match.js";
import { describeReference, referenceInfo } from "../../src/reference.js";
import { exists, readWorkspace } from "../../src/workspace.js";
import { type FailureClass, Tail, classifyFailure } from "./failure.js";
import { managedSnapshot, reconcileIntoProfile, skillsDirProblem, snapshotForProfile } from "./skills.js";

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
        // texte exact du refus : le commentaire que Paperclip 2026.1001.0 pose sur le ticket est FIGÉ côté serveur
        // (recovery/stranded-notice.js : « required secret/env bindings are missing ») et ne lit pas ce champ
        message,
      },
      hermesControl: { refused: true, kind: refusal.kind, failureClass: "configuration" },
    },
  };
}

/** État des copies corrigées (voie 1) RÉELLEMENT chargées : marqueurs exportés par les modules résolus à l'exécution. */
export function voie1Status(mod: Record<string, unknown> = hermesServer as unknown as Record<string, unknown>): { ok: boolean; hermes: string | null; adapterUtils: string | null; adapterUtilsUrl: string | null; message: string } {
  const hermes = typeof mod["HERMES_FINAL_ENV_PATCH"] === "string" ? (mod["HERMES_FINAL_ENV_PATCH"] as string) : null;
  const au = (mod["HERMES_FINAL_ENV_ADAPTER_UTILS"] ?? null) as { patch?: unknown; url?: unknown } | null;
  const adapterUtils = au && typeof au.patch === "string" ? au.patch : null;
  const adapterUtilsUrl = au && typeof au.url === "string" ? au.url : null;
  const ok = !!hermes && !!adapterUtils;
  const message = ok
    ? `voie 1 : ${hermes} ; adapter-utils chargé par l'adaptateur officiel : ${adapterUtilsUrl} (${adapterUtils})`
    : `copies corrigées (voie 1) ABSENTES : hermes-paperclip-adapter ${hermes ?? "non corrigé"}, adapter-utils ${adapterUtils ?? "non corrigé"}${adapterUtilsUrl ? ` (${adapterUtilsUrl})` : ""} — l'environnement final ne serait pas appliqué ; réinstalle l'adaptateur depuis son archive (npm ci sur son verrou)`;
  return { ok, hermes, adapterUtils, adapterUtilsUrl, message };
}

/** `base` injectable (tests) : par défaut l'adaptateur Hermes officiel. */
export function createServerAdapter(base: Base = createHermesLocalServerAdapter(), opts: { finalEnvModule?: Record<string, unknown> } = {}): Base {
  const finalEnv = () => voie1Status(opts.finalEnvModule);
  const execute: Base["execute"] = async (ctx) => {
    const c = ctx as unknown as { config?: AnyRecord; onLog?: (stream: "stdout" | "stderr", text: string) => Promise<void> | void; agent: { id?: string; name: string; companyId?: string | null; adapterConfig?: unknown } };
    const config: AnyRecord = { ...((c.config ?? (c.agent.adapterConfig as AnyRecord | undefined)) ?? {}) };
    let plan: ExecutionPlan;
    try {
      const badArgs = checkExtraArgs(config["extraArgs"]);
      if (badArgs) throw new HermesControlRefusal("arguments", badArgs);
      const v1 = finalEnv();
      if (!v1.ok) throw new HermesControlRefusal("runtime", v1.message);
      plan = await planExecution(c.agent);
      // skills : le dossier du profil affecté doit être dans le profil (sinon refus AVANT toute écriture)
      if (Object.prototype.hasOwnProperty.call(config, "paperclipRuntimeSkills")) {
        const problem = await skillsDirProblem(plan.assignment.home);
        if (problem) throw new HermesControlRefusal("profile", `skills : ${problem}`);
      }
    } catch (e) {
      if (e instanceof HermesControlRefusal) {
        const mapErr = await agentsMapError().catch(() => null);
        const head = e.kind === "not_assigned" ? `agent NON AFFECTÉ à un profil Hermes (ce n'est pas un secret manquant) : ${e.message}` : `refus (${e.kind}) : ${e.message}`;
        const msg = `[hermes-control] « ${c.agent.name} » : ${head}${mapErr ? ` — ${mapErr}` : ""} ; Hermes n'est pas lancé.`;
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
    await c.onLog?.("stdout", `[hermes-control] ${finalEnv().message}\n`);
    await c.onLog?.("stdout", `[hermes-control] ${c.agent.name} → Hermes ${m.instanceHome.split("/").pop()}/${m.profile} (affectation explicite, ${m.source === "table" ? "table" : "projection à même empreinte"}, par ${m.assignedBy} le ${m.assignedAt}) · HERMES_HOME=${plan.hermesHome}${plan.hermesHome !== m.home ? ` (= ${m.home})` : ""} · socket max ${plan.socket.socketPathBytes} octets · binaire ${describeBinary(plan.binary)}\n`);
    if (ignored.length) await c.onLog?.("stdout", `[hermes-control] commande de l'agent ignorée (${ignored.join(", ")}) : seul le binaire administré est lancé\n`);
    if (dropped.length) await c.onLog?.("stdout", `[hermes-control] env de l'agent : ${dropped.join(", ")} ignoré(s) (administré par Hermes Control ; environnement final construit par la voie 1)\n`);
    if (Object.prototype.hasOwnProperty.call(config, "paperclipRuntimeSkills")) {
      try {
        const r = await reconcileIntoProfile(config, m.home);
        const removed = r.removed.length ? ` (retirés : ${r.removed.join(", ")})` : "";
        if (r.linked.length || r.removed.length) await c.onLog?.("stdout", `[hermes-control] skills Paperclip liés dans ${r.skillsDir} : ${r.linked.join(", ") || "aucun"}${removed}\n`);
        for (const w of r.warnings) await c.onLog?.("stderr", `[hermes-control] ${w}\n`);
      } catch (err) {
        await c.onLog?.("stderr", `[hermes-control] skills Paperclip non liés dans le profil : ${err instanceof Error ? err.message : String(err)}\n`);
      }
      // 0.6.2 : l'adaptateur officiel réconcilierait AUSSI ces skills dans `$HOME/.hermes/skills` (global, ou HOME venu de
      // config.env) au démarrage du run : l'inventaire ne lui est pas transmis, la projection dans le profil suffit
      delete config["paperclipRuntimeSkills"];
    }
    // sortie de Hermes gardée (fin seulement) pour classer un échec : authentification du modèle ≠ panne transitoire
    const tail = new Tail();
    const onLog = async (stream: "stdout" | "stderr", text: string) => {
      tail.push(text);
      await c.onLog?.(stream, text);
    };
    // ANNULATION (0.6.3) : portée par le correctif voie 1 (un seul propriétaire). ctx.signal et ctx.onCancellationReady
    // sont transmis tels quels à l'adaptateur officiel corrigé : inscription avant le lancement, SIGTERM au groupe puis
    // SIGKILL après graceSec, groupe vérifié vide → executionCancellation « acknowledged », sinon « unverified » (le
    // serveur répond alors que l'arrêt n'a pas pu être vérifié). Hermes Control ne réécrit JAMAIS cet état.
    const result = await base.execute({ ...(ctx as object), config, onLog, agent: { ...(c.agent as object), adapterConfig: config } } as unknown as Parameters<Base["execute"]>[0]);
    const cancellation = ((result as { resultJson?: Record<string, unknown> | null }).resultJson?.["executionCancellation"] ?? null) as { state?: string; forced?: boolean } | null;
    if (cancellation) {
      await c.onLog?.("stderr", cancellation.state === "acknowledged"
        ? `[hermes-control] passage annulé : groupe de processus de Hermes arrêté et vérifié vide${cancellation.forced ? " (SIGKILL après le délai de grâce)" : ""} ; arrêt acquitté\n`
        : `[hermes-control] passage annulé : arrêt du groupe de Hermes NON vérifié (état ${cancellation.state ?? "?"}) ; non acquitté\n`);
      return result;
    }
    return classifyResult(result, tail.text(), c);
  };

  /** Échec d'authentification du modèle → rendu `configuration_incomplete` (pas de relance) ; le reste inchangé, classe notée. */
  async function classifyResult(result: Awaited<ReturnType<Base["execute"]>>, output: string, c: { agent: { id?: string; name: string; companyId?: string | null }; onLog?: (stream: "stdout" | "stderr", text: string) => Promise<void> | void }): Promise<Awaited<ReturnType<Base["execute"]>>> {
    const r = result as { exitCode: number | null; timedOut: boolean; errorMessage?: string | null; errorCode?: string | null; resultJson?: Record<string, unknown> | null };
    const failed = r.timedOut || (typeof r.exitCode === "number" && r.exitCode !== 0) || (r.exitCode === null && !!r.errorMessage);
    if (!failed) return result;
    const { cls, evidence } = classifyFailure(output, { exitCode: r.exitCode, timedOut: r.timedOut });
    const resultJson: Record<string, unknown> = { ...(r.resultJson ?? {}) };
    resultJson["hermesControl"] = { ...((resultJson["hermesControl"] as Record<string, unknown> | undefined) ?? {}), failureClass: cls satisfies FailureClass, evidence };
    if (cls !== "model_auth") return { ...result, resultJson } as Awaited<ReturnType<Base["execute"]>>;
    const msg = `[hermes-control] « ${c.agent.name} » : authentification du MODÈLE manquante ou expirée (Hermes : « ${evidence} ») ; reconnecte le profil (hermes auth / hermes model) — pas de relance automatique, le ticket attend une intervention.`;
    await c.onLog?.("stderr", msg + "\n");
    resultJson["configurationIncomplete"] = {
      reason: "hermes_control_model_auth",
      companyId: c.agent.companyId ?? null,
      agentId: c.agent.id ?? null,
      fingerprint: `hermes_control:model_auth:${c.agent.id ?? "?"}`,
      missingBindings: [],
      message: msg,
    };
    return { ...result, errorCode: REFUSAL_ERROR_CODE, errorMessage: msg, resultJson } as Awaited<ReturnType<Base["execute"]>>;
  }

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

  /**
   * « Test environment » (0.6.2) : diagnostic STATIQUE, soumis au même contrôle qu'un passage. Paperclip 2026.1001.0
   * (routes/agents.js, POST /companies/:id/adapters/:type/test-environment) n'envoie que { companyId, adapterType, config,
   * … } — aucun agent, donc aucune affectation à résoudre. L'adaptateur officiel lancerait `hermesCommand --version` (deux
   * fois) puis `python3 --version` cherché dans le PATH : il n'est PLUS appelé. Rien n'est exécuté ici : on vérifie, sans
   * le lancer, le binaire administré des instances de l'entreprise, et on signale ce qu'un passage refuserait ou ignorerait.
   */
  const testEnvironment: Base["testEnvironment"] = async (ctx) => {
    const t = ctx as unknown as { companyId?: string | null; config?: AnyRecord };
    const config: AnyRecord = t.config ?? {};
    const checks: { code: string; level: "info" | "warn" | "error"; message: string; detail?: string | null; hint?: string | null }[] = [];
    checks.push({ code: "hermes_control.static", level: "info", message: "Hermes Control : diagnostic statique — aucune commande lancée (ni hermesCommand, ni `hermes`/`python3` du PATH)", detail: null, hint: "Un passage ne lance que le binaire administré de la table, après contrôle de l'affectation de l'agent." });
    const cmd = [config["hermesCommand"], config["command"]].filter((x) => typeof x === "string" && (x as string).trim()) as string[];
    if (cmd.length) checks.push({ code: "hermes_control.command_ignored", level: "warn", message: `Hermes Control : commande de l'agent ignorée (${cmd.join(", ")})`, detail: null, hint: "Retire hermesCommand : seul le binaire administré (assignments.json) est lancé." });
    const envKeys = config["env"] && typeof config["env"] === "object" && !Array.isArray(config["env"]) ? Object.keys(config["env"] as AnyRecord) : [];
    const reserved = envKeys.filter((k) => (ADMINISTERED_ENV as readonly string[]).includes(k) || (NEUTRALIZED_ENV as readonly string[]).includes(k));
    if (reserved.length) checks.push({ code: "hermes_control.env_dropped", level: "warn", message: `Hermes Control : variables ignorées au passage (${reserved.join(", ")})`, detail: null, hint: "HERMES_HOME, PATH, PYTHON*, LD_* … sont administrés par Hermes Control." });
    const badArgs = checkExtraArgs(config["extraArgs"]);
    if (badArgs) checks.push({ code: "hermes_control.arguments", level: "error", message: `Hermes Control : ${badArgs}`, detail: null, hint: null });
    const v1 = finalEnv();
    checks.push({ code: "hermes_control.final_env", level: v1.ok ? "info" : "error", message: `Hermes Control : ${v1.message}`, detail: null, hint: v1.ok ? "Le processus Hermes reçoit un environnement final par liste blanche (rien du serveur) ; les noms de config.env hors liste sont refusés au passage (journal)." : "Aucun passage sans les copies corrigées." });
    const ref = await referenceInfo();
    checks.push({ code: "hermes_control.reference", level: ref.legacyEnv.length ? "error" : "info", message: `Hermes Control : ${describeReference(ref)}`, detail: null, hint: ref.legacyEnv.length ? `Retire ${ref.legacyEnv.join(", ")} de l'environnement du service : plus lues depuis 0.6.1.` : "Plugin et adaptateur lisent ce même dossier (calculé depuis le compte Unix, pas depuis l'environnement)." });
    const read = await readAssignments();
    const companyId = typeof t.companyId === "string" ? t.companyId : null;
    if (read.error) checks.push({ code: "hermes_control.table", level: "error", message: `Hermes Control : ${read.error}`, detail: null, hint: "Aucun passage tant que la table n'est pas réparée." });
    else {
      const company = companyId ? read.table.companies[companyId] : undefined;
      if (!company || !company.instances.length) checks.push({ code: "hermes_control.instances", level: "warn", message: "Hermes Control : aucune instance Hermes autorisée pour cette entreprise", detail: null, hint: `Déclare-les dans la page Hermes (table ${assignmentsFile()}), puis affecte l'agent.` });
      else {
        checks.push({ code: "hermes_control.instances", level: "info", message: `Hermes Control : ${company.instances.length} instance(s) autorisée(s) pour cette entreprise`, detail: company.instances.join(" · "), hint: "Un agent tourne seulement dans le profil qui lui est affecté explicitement." });
        for (const i of company.instances) {
          const v = await verifyHermesBinary(hermesSpecFor(read.table, i)); // lecture seule : rien n'est lancé
          checks.push(v.ok ? { code: "hermes_control.binary", level: "info", message: `Hermes Control : binaire administré pour ${i.split("/").pop()} vérifié (non lancé)`, detail: describeBinary(v.ok), hint: null } : { code: "hermes_control.binary", level: "error", message: `Hermes Control : binaire refusé pour ${i.split("/").pop()} : ${v.error}`, detail: null, hint: "Aucun passage avec ce binaire." });
        }
      }
    }
    const hasErr = checks.some((x) => x.level === "error");
    const hasWarn = checks.some((x) => x.level === "warn");
    return { adapterType: "hermes_local", status: hasErr ? "fail" : hasWarn ? "warn" : "pass", checks, testedAt: new Date().toISOString() } as Awaited<ReturnType<Base["testEnvironment"]>>;
  };

  /** Profil Hermes d'un agent connu seulement par son id (listSkills / syncSkills) : table des affectations explicites. */
  async function profileOf(agentId: string, companyId: string | null | undefined): Promise<{ home: string; label: string } | null> {
    const r = await resolveAssignment(agentId, { companyId: companyId ?? null });
    return r.ok ? { home: r.ok.home, label: `${r.ok.instanceHome.split("/").pop()}/${r.ok.profile}` } : null;
  }
  const UNKNOWN_PROFILE = "Hermes Control : profil Hermes inconnu tant que l'agent n'est pas affecté explicitement (page Hermes → « Affecter » ou « Préparer l'agent ») ; les liens de skills seront posés dans son profil au prochain passage.";

  // 0.6.2 : profil résolu D'ABORD ; ni lecture ni écriture du dossier global (`$HOME/.hermes/skills`) — l'officiel n'est
  // plus appelé ; non affecté → instantané sans écriture, avec l'avertissement.
  const listSkills: NonNullable<Base["listSkills"]> = async (ctx) => {
    const p = await profileOf(ctx.agentId, (ctx as { companyId?: string | null }).companyId);
    const snap = await managedSnapshot(ctx.config as AnyRecord);
    if (!p) return { ...snap, warnings: [...snap.warnings, UNKNOWN_PROFILE] };
    return snapshotForProfile(snap, p.home, p.label);
  };

  const syncSkills: NonNullable<Base["syncSkills"]> = async (ctx, desired) => {
    const p = await profileOf(ctx.agentId, (ctx as { companyId?: string | null }).companyId);
    if (!p) {
      const snap = await managedSnapshot(ctx.config as AnyRecord, desired);
      return { ...snap, warnings: [...snap.warnings, `${UNKNOWN_PROFILE} Aucun lien n'a été posé.`] };
    }
    // refus (dossier des skills hors du profil) : instantané avec l'avertissement, AUCUNE écriture (pas d'exception : le
    // serveur la rendrait en « Internal server error » sans le motif)
    const problem = await skillsDirProblem(p.home);
    if (problem) {
      const snap = await managedSnapshot(ctx.config as AnyRecord, desired);
      return { ...snap, warnings: [...snap.warnings, `Hermes Control : skills non liés — ${problem} ; aucun lien n'a été posé.`] };
    }
    const r = await reconcileIntoProfile(ctx.config as AnyRecord, p.home, desired);
    const out = await snapshotForProfile(await managedSnapshot(ctx.config as AnyRecord, desired), p.home, p.label);
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
