// Adaptateur « Hermes Control » : remplace l'adaptateur Hermes intégré de Paperclip (même type `hermes_local`),
// identique en tout sauf :
//  - les menus Provider / Model de l'agent proposent les providers et modèles connus de Hermes ;
//  - le NOM de l'agent choisit son instance/profil Hermes (HERMES_HOME) au moment du passage ;
//  - les skills assignés à l'agent dans Paperclip sont liés dans `<profil>/skills` (là où Hermes les lit),
//    à la synchro Paperclip et à chaque passage ; décochés → liens retirés.
// Auteur : Cyril M — MIT.
import { createHermesLocalServerAdapter } from "@paperclipai/hermes-paperclip-adapter";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverLight, rootsFile } from "../../src/discovery.js";
import { type HermesInstance, readModelCatalogs } from "../../src/hermes.js";
import { type Match, matchAgent } from "../../src/match.js";
import { recallAgent, rememberAgent } from "../../src/agents-map.js";
import { slug } from "../../src/match.js";
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

/** Binaire hermes : ~/.local/bin/hermes si présent, sinon « hermes » (PATH de Paperclip). */
async function hermesBinary(): Promise<string> {
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

async function remember(agentId: string | undefined, m: Match, name: string): Promise<void> {
  if (!agentId) return;
  try {
    await rememberAgent(agentId, { name, instance: m.instance.name, profile: m.profile.name, home: m.profile.home });
  } catch {
    /* la carte est un confort : ne jamais bloquer un passage */
  }
}

export function createServerAdapter(): Base {
  const base = createHermesLocalServerAdapter();

  const execute: Base["execute"] = async (ctx) => {
    const c = ctx as unknown as { config?: AnyRecord; onLog?: (stream: "stdout" | "stderr", text: string) => Promise<void> | void; agent: { id?: string; name: string; adapterConfig?: unknown } };
    const config: AnyRecord = { ...((c.config ?? (c.agent.adapterConfig as AnyRecord | undefined)) ?? {}) };
    const list = await instances();
    const m = matchAgent(c.agent.name, list);
    if (!m) {
      const known = list.flatMap((i) => i.profiles.map((p) => `${i.name}/${p.name}${p.description ? ` (${p.description.slice(0, 30)})` : ""}`)).join(", ") || "aucune instance trouvée";
      const msg = `[hermes-control] Aucun profil Hermes ne correspond à l'agent « ${c.agent.name} ». Profils connus : ${known}. Nomme un profil « ${c.agent.name} » ou commence sa description par ce nom. Instances cherchées : ~/.hermes et ${rootsFile()}.`;
      await c.onLog?.("stderr", msg + "\n");
      throw new Error(msg);
    }
    const env = { ...((config["env"] as AnyRecord | undefined) ?? {}), HERMES_HOME: m.profile.home };
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
    await c.onLog?.("stdout", `[hermes-control] ${c.agent.name} → Hermes ${m.instance.name}/${m.profile.name} (${m.by === "profile-name" ? "profil du même nom" : "description"}) · HERMES_HOME=${m.profile.home}\n`);
    await remember(c.agent.id, m, c.agent.name);
    if (Object.prototype.hasOwnProperty.call(config, "paperclipRuntimeSkills")) {
      try {
        const r = await reconcileIntoProfile(config, m.profile.home);
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
      hint: list.length ? "Le nom de l'agent choisit son profil (profil du même nom, ou description qui commence par ce nom)." : `Ajoute le dossier des instances dans ${rootsFile()} (une ligne par dossier).`,
    });
    if (!list.length) result.status = "fail";
    return result;
  };

  /** Profil Hermes d'un agent connu seulement par son id (listSkills / syncSkills) : carte écrite à l'exécution et par le plugin. */
  async function profileOf(agentId: string): Promise<{ home: string; label: string } | null> {
    const r = await recallAgent(agentId);
    return r ? { home: r.home, label: `${r.instance}/${r.profile}` } : null;
  }
  const UNKNOWN_PROFILE = "Hermes Control : profil Hermes inconnu tant que l'agent n'a pas tourné (ou que le plugin n'a pas synchronisé) ; les liens de skills seront posés dans son profil au prochain passage.";

  const listSkills: NonNullable<Base["listSkills"]> = async (ctx) => {
    const snap = await base.listSkills!(ctx);
    const p = await profileOf(ctx.agentId);
    if (!p) return { ...snap, warnings: [...snap.warnings, UNKNOWN_PROFILE] };
    return snapshotForProfile(snap, p.home, p.label);
  };

  const syncSkills: NonNullable<Base["syncSkills"]> = async (ctx, desired) => {
    const snap = await base.syncSkills!(ctx, desired);
    const p = await profileOf(ctx.agentId);
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
    detectModel: async () => {
      const list = await instances();
      const p = list.flatMap((i) => i.profiles).find((x) => x.model);
      if (!p) return base.detectModel ? base.detectModel() : null;
      const candidates = (await hermesModels(list)).map((m) => m.id);
      return { model: p.model!, provider: p.provider ?? "auto", source: `hermes-control:${list[0]?.name ?? "hermes"}`, candidates };
    },
  };
}
