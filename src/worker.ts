// Worker du plugin Hermes Control (v0.3). Paperclip est le maître :
//  - pour chaque agent Hermes, le NOM choisit le profil Hermes ; provider / modèle / thinking choisis dans
//    le menu de l'agent sont écrits dans le config.yaml de ce profil (`hermes config set`, sans shell) ;
//  - une seule donnée exposée à l'interface : « instances » (lecture seule).
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { resolve } from "node:path";
import { instanceHomes } from "./discovery.js";
import { type HermesInstance, detectDashboards, instanceNameFromHome, readInstance, resolveHomeFromLauncher } from "./hermes.js";
import { matchAgent } from "./match.js";
import { type Desired, desiredFromAdapterConfig, syncProfile } from "./sync.js";

interface AgentLike {
  id: string;
  name: string;
  status?: string;
  adapterType?: string;
  adapterConfig?: Record<string, unknown> | null;
}

/** Ce que Paperclip envoie pour un agent (les seules données qui sortent de Paperclip). */
interface AgentSnapshot {
  agentId: string;
  agentName: string;
  status: string | null;
  cwd: string | null;
  launcher: string | null;
  want: Desired;
}

interface SyncRecord {
  agentId: string;
  agentName: string;
  instance: string | null;
  profile: string | null;
  home: string | null;
  want: Desired;
  cwd: string | null;
  changed: string[];
  error: string | null;
  at: string;
}

const SNAPSHOT_KEY = { scopeKind: "instance" as const, stateKey: "agents" };
const SYNC_KEY = { scopeKind: "instance" as const, stateKey: "sync" };
const BINARY = "hermes";

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    const log = ctx.logger;
    const launcherHomes = new Map<string, string | null>();

    /** Agents Hermes de l'entreprise, réduits aux données utiles. */
    async function snapshotAgents(companyId: string): Promise<AgentSnapshot[]> {
      const agents = (await ctx.agents.list({ companyId })) as unknown as AgentLike[];
      const out: AgentSnapshot[] = [];
      for (const a of agents) {
        if (a.adapterType !== "hermes_local") continue;
        const ac = a.adapterConfig ?? {};
        const launcher = typeof ac["hermesCommand"] === "string" && ac["hermesCommand"].includes("/") ? (ac["hermesCommand"] as string) : null;
        out.push({ agentId: a.id, agentName: a.name, status: a.status ?? null, cwd: typeof ac["cwd"] === "string" ? (ac["cwd"] as string) : null, launcher, want: desiredFromAdapterConfig(ac) });
      }
      await ctx.state.set(SNAPSHOT_KEY, out);
      return out;
    }

    /** Instances : racines configurées (~/.hermes, ~/.hermes-control) + celles derrière les lanceurs des agents. */
    async function instances(snap: AgentSnapshot[], light: boolean): Promise<HermesInstance[]> {
      const extra: string[] = [];
      for (const a of snap) {
        if (!a.launcher) continue;
        if (!launcherHomes.has(a.launcher)) launcherHomes.set(a.launcher, await resolveHomeFromLauncher(a.launcher));
        const home = launcherHomes.get(a.launcher);
        if (!home) continue;
        const parts = home.split("/");
        const i = parts.lastIndexOf("profiles");
        extra.push(i > 0 ? resolve(home, "..", "..") : home);
      }
      const detected = light ? {} : await detectDashboards();
      const out: HermesInstance[] = [];
      for (const home of await instanceHomes(extra)) {
        try {
          out.push(await readInstance(instanceNameFromHome(home), home, null, BINARY, detected[home] ?? null, { light }));
        } catch (e) {
          log.warn("instance illisible", { home, error: String(e) });
        }
      }
      return out;
    }

    /** Paperclip → Hermes pour une liste d'agents ; mémorise le résultat par agent. */
    async function syncAll(snap: AgentSnapshot[], list: HermesInstance[]): Promise<SyncRecord[]> {
      const previous = ((await ctx.state.get(SYNC_KEY)) as SyncRecord[] | null) ?? [];
      const records: SyncRecord[] = [];
      for (const a of snap) {
        const m = matchAgent(a.agentName, list);
        const rec: SyncRecord = { agentId: a.agentId, agentName: a.agentName, instance: m?.instance.name ?? null, profile: m?.profile.name ?? null, home: m?.profile.home ?? null, want: a.want, cwd: a.cwd, changed: [], error: null, at: new Date().toISOString() };
        if (!m) {
          rec.error = "aucun profil Hermes de ce nom";
        } else {
          const r = await syncProfile(m.profile.home, a.want, BINARY);
          rec.changed = r.changed;
          rec.error = r.error;
          if (r.changed.length) log.info("Hermes synchronisé", { agent: a.agentName, profile: `${m.instance.name}/${m.profile.name}`, changed: r.changed });
        }
        records.push(rec);
      }
      // garder les agents absents de ce passage (autre entreprise)
      const ids = new Set(records.map((r) => r.agentId));
      const merged = [...records, ...previous.filter((p) => !ids.has(p.agentId))];
      await ctx.state.set(SYNC_KEY, merged);
      return merged;
    }

    // ---- la seule donnée pour l'interface ----
    ctx.data.register("instances", async (params) => {
      const companyId = String(params["companyId"] ?? "");
      if (!companyId) throw new Error("companyId manquant");
      const snap = await snapshotAgents(companyId);
      const list = await instances(snap, false);
      const sync = await syncAll(snap, list);
      return { instances: list, sync };
    });

    // ---- un agent modifié dans Paperclip → Hermes se synchronise ----
    for (const type of ["agent.updated", "agent.created"] as const) {
      ctx.events.on(type, async (event) => {
        const companyId = String((event as { companyId?: string }).companyId ?? "");
        if (!companyId) return;
        try {
          const snap = await snapshotAgents(companyId);
          const list = await instances(snap, true);
          await syncAll(snap, list);
        } catch (e) {
          log.warn("synchronisation après événement impossible", { type, error: String(e) });
        }
      });
    }

    // ---- filet toutes les 5 min, sans périmètre entreprise : on repart du dernier instantané ----
    ctx.jobs.register("sync", async () => {
      const snap = ((await ctx.state.get(SNAPSHOT_KEY)) as AgentSnapshot[] | null) ?? [];
      if (!snap.length) return;
      const list = await instances(snap, true);
      await syncAll(snap, list);
    });

    log.info("Hermes Control prêt (Paperclip → Hermes)");
  },

  async onHealth() {
    return { status: "ok" as const, message: "Hermes Control" };
  },
});

export default plugin;
// Démarre la boucle JSON-RPC quand Paperclip lance `node dist/worker.js` ; inerte à l'import (tests).
runWorker(plugin, import.meta.url);
