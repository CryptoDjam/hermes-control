// Lecture des instances Hermes directement depuis leurs fichiers (fiable, sans réseau),
// et exécution contrôlée du CLI hermes (sans shell, arguments séparés).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath, stat, readdir, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";

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
  launcher: string | null; // hermesCommand de Paperclip ayant mené à cette instance
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

/** Exécute `hermes <args>` pour un HERMES_HOME donné (jamais via un shell). */
export async function hermes(home: string, args: string[], binary = "hermes", timeoutMs = 20_000): Promise<string> {
  const { stdout } = await run(binary, args, {
    env: { ...process.env, HERMES_HOME: home, PYTHONUNBUFFERED: "1", NO_COLOR: "1" },
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

/**
 * @deprecated Exécute le lanceur (`<lanceur> config path`) : la vue ne doit rien exécuter. Préférer homeFromLauncherFile.
 * Retrouve le HERMES_HOME derrière un lanceur (hermesCommand) : `<lanceur> config path` → …/config.yaml
 */
export async function resolveHomeFromLauncher(launcher: string): Promise<string | null> {
  const path = resolve(launcher);
  if (!(await exists(path))) return null;
  try {
    const { stdout } = await run(path, ["config", "path"], { timeout: 20_000, env: { ...process.env, NO_COLOR: "1" } });
    const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    if (!line.endsWith("config.yaml")) return null;
    return dirname(line);
  } catch {
    return null;
  }
}

const LAUNCHER_MAX_BYTES = 64 * 1024;
const ASSIGN_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Valeur d'une affectation shell : apostrophes = littéral (mais une apostrophe qui contient `$` n'est pas résoluble
 * → null) ; guillemets = expansion ; sans guillemets, un mot suivi d'autres mots est une commande préfixée
 * (`HERMES_HOME=/x exec …`) → "ignore" (la ligne ne compte pas).
 */
function literalValue(raw: string): { value: string; quoted: "single" | "double" | null } | "ignore" | null {
  const t = raw.trim();
  const sq = /^'([^']*)'(?:\s*(#.*)?)?$/.exec(t);
  if (sq) return sq[1]!.includes("$") ? null : { value: sq[1]!, quoted: "single" };
  const dq = /^"([^"]*)"(?:\s*(#.*)?)?$/.exec(t);
  if (dq) return { value: dq[1]!, quoted: "double" };
  if (/^["']/.test(t)) return null; // guillemet ouvert, non fermé sur la ligne
  const word = t.split(/\s+#/)[0]!.trim();
  if (/\s/.test(word)) return "ignore"; // `VAR=x commande …`
  return { value: word, quoted: null };
}

/** Remplace $VAR / ${VAR} / ~ par les valeurs connues ; null si une variable reste inconnue ou si la valeur n'est pas littérale. */
function expand(value: string, vars: Record<string, string>): string | null {
  if (/\$\(|`|\$\{[A-Za-z_][A-Za-z0-9_]*[:#%/]/.test(value)) return null; // sous-shell ou expansion conditionnelle : pas littéral
  let missing = false;
  let out = value.replace(/^~(?=\/|$)/, vars["HOME"] ?? "~");
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a: string | undefined, b: string | undefined) => {
    const v = vars[(a ?? b)!];
    if (v === undefined) missing = true;
    return v ?? "";
  });
  return missing ? null : out;
}

export type LauncherHome = { home: string; error: null } | { home: null; error: string };

const launcherError = (error: string): LauncherHome => ({ home: null, error });

/**
 * HERMES_HOME d'un lanceur (hermesCommand) par lecture STATIQUE du script, sans l'exécuter : ligne `HERMES_HOME=…`,
 * avec $HOME / ~ → homedir, $PROJETC → <dossier du lanceur>/../.. (nos lanceurs le calculent ainsi) et toute variable
 * affectée littéralement plus haut dans le fichier. Toute incertitude est une ERREUR explicite, jamais une conformité :
 * lanceur relatif, absent, trop gros ou binaire ; aucun HERMES_HOME ; valeur non résolue (variable inconnue, sous-shell,
 * expansion conditionnelle) ; PLUSIEURS affectations de HERMES_HOME (le shell appliquerait la dernière : refus).
 */
export async function homeFromLauncherFile(launcher: string): Promise<LauncherHome> {
  if (!isAbsolute(launcher)) return launcherError(`lanceur relatif (${launcher}) : dépend du cwd de Paperclip`);
  let path = resolve(launcher);
  try {
    path = await realpath(path); // les lanceurs font `readlink -f "$0"`
    const st = await stat(path);
    if (!st.isFile()) return launcherError(`lanceur ${path} : pas un fichier`);
    if (st.size > LAUNCHER_MAX_BYTES) return launcherError(`lanceur ${path} : trop gros pour une lecture statique (${st.size} octets)`);
  } catch (e) {
    return launcherError(`lanceur ${launcher} illisible : ${(e as Error).message}`);
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    return launcherError(`lanceur ${path} illisible : ${(e as Error).message}`);
  }
  if (text.includes("\0")) return launcherError(`lanceur ${path} : fichier binaire, HERMES_HOME non lisible`);
  const vars: Record<string, string> = { HOME: homedir(), PROJETC: resolve(dirname(path), "..", "..") };
  const homes: { line: number; value: string | null }[] = [];
  text.split("\n").forEach((line, i) => {
    const m = ASSIGN_RE.exec(line);
    if (!m) return;
    const [, name, raw] = m as unknown as [string, string, string];
    const lit = literalValue(raw);
    if (lit === "ignore") return;
    const value = lit === null ? null : lit.quoted === "single" ? lit.value : expand(lit.value, vars);
    if (name === "HERMES_HOME") homes.push({ line: i + 1, value: value && value.startsWith("/") ? value : null });
    else if (value !== null) vars[name] = value;
  });
  if (!homes.length) return launcherError(`lanceur ${path} : aucune affectation HERMES_HOME lisible`);
  if (homes.length > 1) return launcherError(`lanceur ${path} : plusieurs HERMES_HOME (lignes ${homes.map((h) => h.line).join(", ")}) ; le shell appliquerait la dernière — refus`);
  const only = homes[0]!;
  if (!only.value) return launcherError(`lanceur ${path} : HERMES_HOME non résolu (ligne ${only.line} : variable inconnue, sous-shell ou valeur non littérale)`);
  const home = resolve(only.value);
  return { home: (await realpath(home).catch(() => null)) ?? home, error: null }; // chemin réel quand le dossier existe
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

async function readAuth(home: string, provider: string | null, binary: string): Promise<HermesProfile["authStatus"]> {
  if (!provider || provider === "auto") return "unknown";
  try {
    return parseAuthStatus(await hermes(home, ["auth", "status", provider], binary));
  } catch (e) {
    return parseAuthStatus(String((e as { stdout?: string }).stdout ?? ""));
  }
}

async function readProfile(name: string, home: string, binary: string, light = false): Promise<HermesProfile> {
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
export async function readInstance(name: string, home: string, launcher: string | null, binary: string, dashboardUrl: string | null, opts: { light?: boolean } = {}): Promise<HermesInstance> {
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
  // Paperclip lance le worker sans HOME : homedir() lit /etc/passwd en secours.
  const dir = join(homedir(), ".config", "systemd", "user");
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

export async function profileCreate(instanceHome: string, name: string, description: string | null, binary: string, opts: { clone?: boolean } = {}): Promise<string> {
  const args = ["profile", "create", assertSafeName(name), "--no-alias"];
  if (opts.clone) args.push("--clone");
  if (description) args.push("--description", description.slice(0, 500));
  return hermes(instanceHome, args, binary, 120_000);
}

export async function profileDescribe(instanceHome: string, name: string, text: string, binary: string): Promise<string> {
  const args = ["profile", "describe", assertSafeName(name), "--text", text.slice(0, 500)];
  return hermes(instanceHome, args, binary);
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,120}$/;

export async function setModel(home: string, model: string, provider: string | null, binary: string): Promise<string> {
  if (!MODEL_RE.test(model)) throw new Error(`nom de modèle invalide : ${model}`);
  if (provider && !/^[a-z0-9-]{1,40}$/.test(provider)) throw new Error(`fournisseur invalide : ${provider}`);
  let out = await hermes(home, ["config", "set", "model.default", model, "--force"], binary);
  if (provider) out += "\n" + (await hermes(home, ["config", "set", "model.provider", provider, "--force"], binary));
  return out;
}

export async function authStatus(home: string, provider: string | null, binary: string): Promise<string> {
  const args = ["auth", "status"];
  if (provider) args.push(provider);
  try {
    return await hermes(home, args, binary);
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? (e as Error).message);
  }
}

export async function doctor(home: string, binary: string): Promise<string> {
  try {
    return await hermes(home, ["doctor"], binary, 120_000);
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? "") + "\n" + String((e as { stderr?: string }).stderr ?? (e as Error).message);
  }
}

/** Redémarre l'unité systemd utilisateur du tableau de bord d'une instance, si elle existe. */
export async function restartDashboard(instance: string): Promise<string> {
  const unit = `hermes-dashboard-${assertSafeName(instance)}.service`;
  const { stdout, stderr } = await run("systemctl", ["--user", "restart", unit], { timeout: 30_000 });
  return (stdout + stderr).trim() || `${unit} redémarré`;
}
