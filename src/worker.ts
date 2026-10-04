// Worker du plugin Hermes Control (v0.5). Paperclip est le maître :
//  - pour chaque agent Hermes, le NOM choisit le profil Hermes ; provider / modèle / thinking choisis dans
//    le menu de l'agent sont écrits dans le config.yaml de ce profil (`hermes config set`, sans shell) ;
//  - un agent Hermes créé dans Paperclip sans profil → son profil, ses dossiers et ses liens sont préparés
//    automatiquement (dossier de travail commun, voir workspace.ts) ; bouton « Préparer » en secours ;
//  - une seule donnée exposée à l'interface : « instances » ; deux actions : prepare-agent, set-telegram.
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { resolve } from "node:path";
import { instanceHomes } from "./discovery.js";
import { type HermesInstance, detectDashboards, instanceNameFromHome, readInstance, resolveHomeFromLauncher } from "./hermes.js";
import { matchAgent, slug } from "./match.js";
import { rememberAgent } from "./agents-map.js";
import { prepareAgent } from "./prepare.js";
import { setTelegramToken, startGateway, telegramConfigured } from "./telegram.js";
import { type Workspace, exists, readWorkspace } from "./workspace.js";
import { join } from "node:path";
import { type Desired, desiredFromAdapterConfig, syncProfile } from "./sync.js";

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
  agentName: string;
  title: string | null;
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
  prepared: string[] | null; // ce que la préparation automatique a créé (null = rien à préparer)
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
        out.push({ agentId: a.id, agentName: a.name, title: a.title ?? null, status: a.status ?? null, cwd: typeof ac["cwd"] === "string" ? (ac["cwd"] as string) : null, launcher, want: desiredFromAdapterConfig(ac) });
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

    /** Instance Hermes de l'entreprise dans le dossier de travail : celle qui porte le nom de l'entreprise, sinon la seule, sinon la première. */
    function companyInstance(ws: Workspace, list: HermesInstance[], companyName: string | null): HermesInstance | null {
      const inWs = list.filter((i) => i.home.startsWith(ws.profils + "/"));
      if (!inWs.length) return null;
      const want = companyName ? slug(companyName) : "";
      return inWs.find((i) => i.name === want) ?? inWs[0] ?? null;
    }

    /** Prépare le profil + dossiers d'un agent sans profil. Retourne la liste de ce qui a été créé, ou null si impossible. */
    async function prepare(a: AgentSnapshot, list: HermesInstance[], companyName: string | null): Promise<{ created: string[]; warnings: string[] } | null> {
      const ws = await readWorkspace();
      if (!ws || !(await exists(ws.profils))) return null;
      const inst = companyInstance(ws, list, companyName);
      if (!inst) return null;
      const r = await prepareAgent({ ws, instanceHome: inst.home, agentName: a.agentName, title: a.title, binary: BINARY, entreprise: companyName });
      log.info("agent préparé", { agent: a.agentName, profile: `${inst.name}/${r.profile}`, created: r.created.length, warnings: r.warnings });
      return { created: r.created, warnings: r.warnings };
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

    /** Paperclip → Hermes pour une liste d'agents ; prépare les agents sans profil ; mémorise le résultat par agent. */
    async function syncAll(snap: AgentSnapshot[], list: HermesInstance[], opts: { companyId?: string; autoPrepare?: boolean } = {}): Promise<SyncRecord[]> {
      const previous = ((await ctx.state.get(SYNC_KEY)) as SyncRecord[] | null) ?? [];
      const records: SyncRecord[] = [];
      let instancesList = list;
      for (const a of snap) {
        let m = matchAgent(a.agentName, instancesList);
        const rec: SyncRecord = { agentId: a.agentId, agentName: a.agentName, instance: m?.instance.name ?? null, profile: m?.profile.name ?? null, home: m?.profile.home ?? null, want: a.want, cwd: a.cwd, changed: [], error: null, prepared: null, at: new Date().toISOString() };
        if (!m && opts.autoPrepare !== false) {
          try {
            const p = await prepare(a, instancesList, opts.companyId ? await companyName(opts.companyId) : null);
            if (p) {
              rec.prepared = p.created;
              if (p.warnings.length) rec.error = p.warnings.join(" ");
              instancesList = await instances(snap, true);
              m = matchAgent(a.agentName, instancesList);
              if (m) Object.assign(rec, { instance: m.instance.name, profile: m.profile.name, home: m.profile.home });
            }
          } catch (e) {
            rec.error = `préparation impossible : ${e instanceof Error ? e.message : String(e)}`;
            log.warn("préparation de l'agent impossible", { agent: a.agentName, error: String(e) });
          }
        }
        if (!m) {
          rec.error = rec.error ?? "aucun profil Hermes de ce nom";
        } else {
          // carte agentId → profil, lue par l'adaptateur pour poser les liens de skills (listSkills / syncSkills n'ont que l'id)
          await rememberAgent(a.agentId, { name: a.agentName, instance: m.instance.name, profile: m.profile.name, home: m.profile.home }).catch(() => {});
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
      const sync = await syncAll(snap, list, { companyId });
      const ws = await readWorkspace();
      const telegram: Record<string, boolean> = {};
      for (const i of list) for (const p of i.profiles) telegram[p.home] = await telegramConfigured(p.home);
      return { instances: (await instances(snap, true)), sync, workspace: ws, telegram };
    });

    // ---- actions de la page ----
    ctx.actions.register("prepare-agent", async (params, actx) => {
      const agentId = String(params["agentId"] ?? "");
      const companyId = String(params["companyId"] ?? actx.companyId ?? "");
      if (!agentId || !companyId) throw new Error("agentId et companyId requis");
      if (actx.actor.type !== "user") throw new Error("action réservée à un utilisateur du board");
      const snap = await snapshotAgents(companyId);
      const a = snap.find((x) => x.agentId === agentId);
      if (!a) throw new Error("agent Hermes introuvable dans cette entreprise");
      const list = await instances(snap, true);
      const p = await prepare(a, list, await companyName(companyId));
      if (!p) throw new Error("pas de dossier de travail (~/.config/hermes-control/workspace) ou aucune instance Hermes dedans");
      await syncAll(snap, await instances(snap, true), { companyId, autoPrepare: false });
      return { created: p.created, warnings: p.warnings };
    });

    ctx.actions.register("set-telegram", async (params, actx) => {
      const home = String(params["home"] ?? "");
      const token = String(params["token"] ?? "");
      if (actx.actor.type !== "user") throw new Error("action réservée à un utilisateur du board");
      // le chemin doit être un profil connu (jamais un chemin libre venu de la page)
      const snap = ((await ctx.state.get(SNAPSHOT_KEY)) as AgentSnapshot[] | null) ?? [];
      const known = (await instances(snap, true)).flatMap((i) => i.profiles.map((p) => p.home));
      if (!known.includes(home)) throw new Error("profil Hermes inconnu");
      const changed = await setTelegramToken(home, token);
      let gateway = "";
      try {
        gateway = (await startGateway(home, BINARY)).trim().split("\n").slice(-2).join(" ");
      } catch (e) {
        gateway = e instanceof Error ? e.message : String(e);
      }
      log.info("jeton Telegram enregistré", { home: join(home, ".env"), changed });
      return { changed, gateway };
    });

    // ---- un agent modifié dans Paperclip → Hermes se synchronise ----
    for (const type of ["agent.updated", "agent.created"] as const) {
      ctx.events.on(type, async (event) => {
        const companyId = String((event as { companyId?: string }).companyId ?? "");
        if (!companyId) return;
        try {
          const snap = await snapshotAgents(companyId);
          const list = await instances(snap, true);
          await syncAll(snap, list, { companyId });
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
      await syncAll(snap, list, { autoPrepare: false }); // sans périmètre entreprise : pas de création
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
