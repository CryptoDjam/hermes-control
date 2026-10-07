// Lecture des instances Hermes directement depuis leurs fichiers (fiable, sans réseau),
// et exécution contrôlée du CLI hermes (sans shell, arguments séparés, binaire administré, environnement explicite).
// Aucun script lanceur n'est lu ni exécuté (0.6.1).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat, readdir, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";
import { accountHome } from "./paths.js";
import { type HermesCallOperation, accountEnv, fixedPath, localeEnv, needsServiceManager, systemctlUserEnv, trustedSystemctl, userServiceManagerEnv } from "./admin-env.js";
export type { HermesCallOperation } from "./admin-env.js";

const run = promisify(execFile);

export interface HermesProfile {
  name: string; // "default" = racine de l'instance
  home: string;
  description: string | null;
  model: string | null;
  provider: string | null;
  authStatus: "logged_in" | "logged_out" | "unknown";
  approvalsMode: string | null;
  terminalBackend: string | null;
  toolsets: string[];
  configError: string | null; // config.yaml présent mais illisible (YAML invalide ou pas un objet) : jamais synchronisé
}

export interface HermesInstance {
  name: string;
  home: string;
  launcher: string | null; // toujours null depuis 0.6.1 (les lanceurs ne servent plus à découvrir les instances)
  dashboardUrl: string | null;
  profiles: HermesProfile[];
  errors24h: number;
  lastError: string | null;
}

export interface HermesSession {
  id: string;
  profile: string | null;
  source: string | null;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  messages: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  cwd: string | null;
  title: string | null;
}

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function assertSafeName(name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`nom de profil invalide : ${name}`);
  return name;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Exécutable Hermes VÉRIFIÉ (voir binary.ts : verifyHermesBinary) : chemin absolu administré + dossier de l'interpréteur à
 * placer en tête de PATH. Une chaîne est acceptée pour les appels de bas niveau et les tests : c'est alors l'appelant qui
 * garantit qu'elle a été vérifiée. `null` = aucun binaire administré : aucun appel possible.
 */
export interface HermesExec {
  path: string;
  pathPrefix: string[];
}
export type HermesBin = HermesExec | string | null;

export function toExec(bin: HermesBin): HermesExec | null {
  if (bin === null) return null;
  if (typeof bin === "string") return isAbsolute(bin) ? { path: bin, pathPrefix: [dirname(bin)] } : null;
  return bin;
}

/**
 * Environnement EXPLICITE d'un appel Hermes du plugin (0.6.3, voir admin-env.ts) : PATH fixé (interpréteur administré +
 * chemin système), HOME/USER/LOGNAME du compte (getpwuid), langue/fuseau contrôlés. XDG_RUNTIME_DIR et
 * DBUS_SESSION_BUS_ADDRESS : seulement pour une opération d'administration du service (`gateway_service`), dérivés de
 * l'uid du compte ; jamais repris de l'environnement du serveur.
 */
export function hermesCallEnv(home: string, exec: HermesExec, op: HermesCallOperation = "query"): Record<string, string> {
  const env: Record<string, string> = { PATH: fixedPath(exec.pathPrefix), ...accountEnv(), HERMES_HOME: home, PYTHONUNBUFFERED: "1", NO_COLOR: "1", ...localeEnv() };
  if (needsServiceManager(op)) Object.assign(env, userServiceManagerEnv());
  return env;
}

/**
 * Exécute `<binaire administré> <args>` pour un HERMES_HOME donné (jamais via un shell, jamais un nom cherché dans le PATH).
 * `op` : constante du code appelant (jamais un paramètre d'action) ; seule `gateway_service` reçoit le bus utilisateur.
 */
export async function hermes(home: string, args: string[], binary: HermesBin, timeoutMs = 20_000, op: HermesCallOperation = "query"): Promise<string> {
  const exec = toExec(binary);
  if (!exec) throw new Error(`aucun binaire Hermes administré (chemin absolu vérifié) : appel « hermes ${args.slice(0, 2).join(" ")} » refusé`);
  const { stdout } = await run(exec.path, args, {
    env: hermesCallEnv(home, exec, op),
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

export function parseConfig(text: string): Record<string, unknown> {
  try {
    const doc = YAML.parse(text);
    return doc && typeof doc === "object" ? (doc as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function pick(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/**
 * Lecture stricte de <home>/config.yaml : absent → {} sans erreur ; présent mais YAML invalide, ou qui n'est pas un objet
 * → `error` renseigné (le fichier n'est jamais réécrit ; vide ou commentaires seuls = objet vide, valide).
 */
export async function readConfigStrict(home: string): Promise<{ cfg: Record<string, unknown>; error: string | null }> {
  let text: string;
  try {
    text = await readFile(join(home, "config.yaml"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { cfg: {}, error: null };
    return { cfg: {}, error: `config.yaml illisible : ${(e as Error).message}` };
  }
  let doc: unknown;
  try {
    doc = YAML.parse(text, { uniqueKeys: false }); // comme safe_load Python : clés dupliquées tolérées
  } catch (e) {
    return { cfg: {}, error: `config.yaml invalide : ${(e as Error).message.split("\n")[0]}` };
  }
  if (doc === null || doc === undefined) return { cfg: {}, error: null };
  if (typeof doc !== "object" || Array.isArray(doc)) return { cfg: {}, error: `config.yaml invalide : le contenu n'est pas un objet (${Array.isArray(doc) ? "liste" : typeof doc})` };
  return { cfg: doc as Record<string, unknown>, error: null };
}

async function readDescription(home: string): Promise<string | null> {
  try {
    const doc = parseConfig(await readFile(join(home, "profile.yaml"), "utf8"));
    const d = doc["description"];
    return typeof d === "string" && d.trim() ? d.trim() : null;
  } catch {
    return null;
  }
}

/** Les négations d'abord : « not logged in », « invalid », « expired » contiennent les mots positifs. */
export function parseAuthStatus(text: string): HermesProfile["authStatus"] {
  const t = text.toLowerCase();
  if (/not logged|logged out|no .*credentials|invalid|expired|not authenticated/.test(t)) return "logged_out";
  if (/logged in|authenticated|valid/.test(t)) return "logged_in";
  return "unknown";
}

async function readAuth(home: string, provider: string | null, binary: HermesBin): Promise<HermesProfile["authStatus"]> {
  if (!provider || provider === "auto" || !toExec(binary)) return "unknown";
  try {
    return parseAuthStatus(await hermes(home, ["auth", "status", provider], binary));
  } catch (e) {
    return parseAuthStatus(String((e as { stdout?: string }).stdout ?? ""));
  }
}

async function readProfile(name: string, home: string, binary: HermesBin, light = false): Promise<HermesProfile> {
  const { cfg, error: configError } = await readConfigStrict(home);
  const model = pick(cfg, ["model", "default"]);
  const provider = pick(cfg, ["model", "provider"]);
  const toolsets = pick(cfg, ["toolsets"]);
  const providerStr = typeof provider === "string" ? provider : null;
  return {
    name,
    home,
    description: await readDescription(home),
    model: typeof model === "string" && model ? model : null,
    provider: providerStr,
    authStatus: light ? "unknown" : await readAuth(home, providerStr, binary),
    approvalsMode: (pick(cfg, ["approvals", "mode"]) as string | undefined) ?? null,
    terminalBackend: (pick(cfg, ["terminal", "backend"]) as string | undefined) ?? null,
    toolsets: Array.isArray(toolsets) ? toolsets.map(String) : [],
    configError,
  };
}

/** Lit l'instance (racine = profil « default ») et ses profils (`profiles/<nom>/`). */
export async function readInstance(name: string, home: string, launcher: string | null, binary: HermesBin, dashboardUrl: string | null, opts: { light?: boolean } = {}): Promise<HermesInstance> {
  const light = opts.light === true;
  const profiles: HermesProfile[] = [await readProfile("default", home, binary, light)];
  const dir = join(home, "profiles");
  if (await exists(dir)) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory())) {
      if (!SAFE_NAME.test(entry.name)) continue;
      profiles.push(await readProfile(entry.name, join(dir, entry.name), binary, light));
    }
  }
  const errs = light ? { count: 0, lines: [] } : await readErrors(home, 24 * 3600 * 1000, 1);
  return { name, home, launcher, dashboardUrl, profiles, errors24h: errs.count, lastError: errs.lines[0] ?? null };
}

export interface ErrorsSummary {
  count: number;
  lines: string[];
}

/** Dernières erreurs de `logs/errors.log` (lignes datées « YYYY-MM-DD HH:MM:SS,mmm LEVEL … »). */
export async function readErrors(home: string, windowMs: number, limit = 20): Promise<ErrorsSummary> {
  let text = "";
  try {
    const p = join(home, "logs", "errors.log");
    const st = await stat(p);
    text = await readFile(p, "utf8");
    if (st.size > 512 * 1024) text = text.slice(-512 * 1024);
  } catch {
    return { count: 0, lines: [] };
  }
  const since = Date.now() - windowMs;
  const out: string[] = [];
  let count = 0;
  for (const line of text.split("\n").reverse()) {
    const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(line);
    if (!m) continue;
    if (!/\b(ERROR|CRITICAL|WARNING)\b/.test(line)) continue;
    const ts = Date.parse(m[1]!.replace(" ", "T"));
    if (ts < since) break;
    count++;
    if (out.length < limit) out.push(line.length > 400 ? line.slice(0, 400) + "…" : line);
  }
  return { count, lines: out };
}

/** Sessions depuis state.db (lecture seule, node:sqlite — pas de module natif à compiler). */
export async function readSessions(home: string, limit = 20, profile?: string): Promise<HermesSession[]> {
  const db = join(home, "state.db");
  if (!(await exists(db))) return [];
  const { DatabaseSync } = await import("node:sqlite");
  const conn = new DatabaseSync(db, { readOnly: true });
  try {
    const where = profile ? "WHERE profile_name = ?" : "";
    const stmt = conn.prepare(
      `SELECT id, profile_name, source, model, started_at, ended_at, end_reason, message_count, tool_call_count,
              input_tokens, output_tokens, estimated_cost_usd, actual_cost_usd, cwd, title
       FROM sessions ${where} ORDER BY started_at DESC LIMIT ?`,
    );
    const rows = (profile ? stmt.all(profile, limit) : stmt.all(limit)) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      profile: (r.profile_name as string | null) ?? null,
      source: (r.source as string | null) ?? null,
      model: (r.model as string | null) ?? null,
      startedAt: new Date(Number(r.started_at) * 1000).toISOString(),
      endedAt: r.ended_at ? new Date(Number(r.ended_at) * 1000).toISOString() : null,
      endReason: (r.end_reason as string | null) ?? null,
      messages: Number(r.message_count ?? 0),
      toolCalls: Number(r.tool_call_count ?? 0),
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      costUsd: r.actual_cost_usd != null ? Number(r.actual_cost_usd) : r.estimated_cost_usd != null ? Number(r.estimated_cost_usd) : null,
      cwd: (r.cwd as string | null) ?? null,
      title: (r.title as string | null) ?? null,
    }));
  } finally {
    conn.close();
  }
}

/** Modèles connus par Hermes pour un fournisseur (cache local écrit par `hermes model`). */
export async function readModelCatalog(home: string, provider: string | null): Promise<string[]> {
  const all = await readModelCatalogs(home);
  if (provider) return all[provider] ?? [];
  return [...new Set(Object.values(all).flat())];
}

/** Catalogue complet `provider_models_cache.json` : fournisseur → modèles. */
export async function readModelCatalogs(home: string): Promise<Record<string, string[]>> {
  try {
    const raw = JSON.parse(await readFile(join(home, "provider_models_cache.json"), "utf8")) as Record<string, unknown>;
    const out: Record<string, string[]> = {};
    for (const [prov, entry] of Object.entries(raw)) {
      const list = Array.isArray(entry) ? entry : Array.isArray((entry as Record<string, unknown> | undefined)?.["models"]) ? ((entry as Record<string, unknown>)["models"] as unknown[]) : [];
      out[prov] = list.map((m) => (typeof m === "string" ? m : String((m as Record<string, unknown>)["id"] ?? ""))).filter(Boolean);
    }
    return out;
  } catch {
    return {};
  }
}

export function instanceNameFromHome(home: string): string {
  return basename(home);
}

/**
 * Tableaux de bord `hermes dashboard` lancés par des unités systemd utilisateur
 * (`~/.config/systemd/user/hermes-dashboard-*.service`) : HERMES_HOME → URL.
 * Détection facultative ; sans systemd, la carte est vide et les réglages prennent le relais.
 */
export async function detectDashboards(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  // dossier du compte (getpwuid) : Paperclip lance le worker sans HOME
  const dir = join(accountHome(), ".config", "systemd", "user");
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.startsWith("hermes-dashboard-") && f.endsWith(".service"));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const unit = await readFile(join(dir, f), "utf8");
      const home = /Environment=HERMES_HOME=(\S+)/.exec(unit)?.[1];
      const exec = /ExecStart=.*hermes\s+dashboard\b(.*)$/m.exec(unit)?.[1] ?? "";
      const port = /--port\s+(\d+)/.exec(exec)?.[1];
      const host = /--host\s+(\S+)/.exec(exec)?.[1] ?? "127.0.0.1";
      if (home && port) out[resolve(home)] = `http://${host}:${port}`;
    } catch {
      /* unité illisible : ignorée */
    }
  }
  return out;
}

/** Instances trouvées dans un dossier racine : chaque sous-dossier contenant un config.yaml. */
export async function listInstancesInRoot(root: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !SAFE_NAME.test(e.name)) continue;
    const home = join(root, e.name);
    if (await exists(join(home, "config.yaml"))) out.push(home);
  }
  return out;
}

export function profileHome(instanceHome: string, profile: string): string {
  return profile === "default" ? instanceHome : join(instanceHome, "profiles", assertSafeName(profile));
}

// ---- commandes Hermes exposées à Paperclip (toutes sans shell, arguments séparés) ----

export async function profileCreate(instanceHome: string, name: string, description: string | null, binary: HermesBin, opts: { clone?: boolean } = {}): Promise<string> {
  const args = ["profile", "create", assertSafeName(name), "--no-alias"];
  if (opts.clone) args.push("--clone");
  if (description) args.push("--description", description.slice(0, 500));
  return hermes(instanceHome, args, binary, 120_000);
}

export async function profileDescribe(instanceHome: string, name: string, text: string, binary: HermesBin): Promise<string> {
  const args = ["profile", "describe", assertSafeName(name), "--text", text.slice(0, 500)];
  return hermes(instanceHome, args, binary);
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,120}$/;

export async function setModel(home: string, model: string, provider: string | null, binary: HermesBin): Promise<string> {
  if (!MODEL_RE.test(model)) throw new Error(`nom de modèle invalide : ${model}`);
  if (provider && !/^[a-z0-9-]{1,40}$/.test(provider)) throw new Error(`fournisseur invalide : ${provider}`);
  let out = await hermes(home, ["config", "set", "model.default", model, "--force"], binary);
  if (provider) out += "\n" + (await hermes(home, ["config", "set", "model.provider", provider, "--force"], binary));
  return out;
}

export async function authStatus(home: string, provider: string | null, binary: HermesBin): Promise<string> {
  const args = ["auth", "status"];
  if (provider) args.push(provider);
  try {
    return await hermes(home, args, binary);
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? (e as Error).message);
  }
}

export async function doctor(home: string, binary: HermesBin): Promise<string> {
  try {
    return await hermes(home, ["doctor"], binary, 120_000);
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? "") + "\n" + String((e as { stderr?: string }).stderr ?? (e as Error).message);
  }
}

/**
 * Redémarre l'unité systemd utilisateur du tableau de bord d'une instance, si elle existe. 0.6.3 : `systemctl` de
 * CONFIANCE (chemin système fixe, root, non modifiable par d'autres) et environnement MINIMAL propre (PATH système,
 * compte, bus utilisateur dérivé de l'uid) — jamais l'environnement du serveur ni un `systemctl` trouvé dans son PATH.
 */
export async function restartDashboard(instance: string): Promise<string> {
  const unit = `hermes-dashboard-${assertSafeName(instance)}.service`;
  const { stdout, stderr } = await run(trustedSystemctl(), ["--user", "restart", unit], { timeout: 30_000, env: systemctlUserEnv() });
  return (stdout + stderr).trim() || `${unit} redémarré`;
}
