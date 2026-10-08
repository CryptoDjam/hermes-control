// Santé d'un profil Hermes et état d'un agent, en lecture seule (aucune commande hermes) :
//  - longueur réelle des chemins de sockets de la version épinglée (limite AF_UNIX 108 octets, cible ≤ 100), mesurée
//    AVANT tout démarrage, sans attendre qu'un socket existe : `<home>/gateway.sock`, le socket du watchdog
//    `<home>/state/gateway.loop-tick.<pid>.sock` (Hermes 0.21.5, gateway/shutdown_watchdog.py) avec un pid de 7 chiffres
//    (pire cas Linux : pid_max 4194304), et tout `*.sock` déjà présent dans `home` et `home/state` ;
//  - en-tête YAML de chaque skill (un en-tête invalide avec `platforms:` cache la skill sans bruit) ;
//  - config.yaml illisible ;
//  - trois états par agent : installé (profil présent) / connecté (authStatus logged_in) / connecté et synchronisé
//    (connecté + dernière synchro sans erreur). « Autorisé et testé » (droits, affectation, cas négatif) reste à faire.
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { type HermesProfile, readConfigStrict } from "./hermes.js";

export const SOCKET_PATH_MAX = 100;
export const SOCKET_SUN_PATH_LIMIT = 108;
/** Pire cas Linux : pid_max = 4194304 (7 chiffres). */
export const WORST_CASE_PID = "4194304";

export interface SkillHealth {
  name: string;
  yamlOk: boolean;
  hiddenByPlatforms: boolean; // en-tête invalide ET ligne `platforms:` : Hermes ignore la skill en silence
}

export interface SocketPathCheck {
  socketPathBytes: number; // le plus long des chemins mesurés
  socketPathOk: boolean;
  longest: string; // le chemin qui donne la mesure
  sockets: string[]; // fichiers *.sock présents (relatifs à home : « x.sock », « state/y.sock »)
  socketBase: string; // le dossier mesuré : HERMES_HOME littéral transmis (racine d'exécution administrée) pour un profil affecté, sinon le home du profil
}

export interface ProfileHealth extends SocketPathCheck {
  skills: SkillHealth[];
  configError: string | null;
  alerts: string[]; // une ligne courte par problème
}

export type AgentState = "installed" | "connected" | "synced";

/** En-tête YAML (entre deux lignes `---` en tête de fichier) ; null si absent. */
export function frontMatter(text: string): string | null {
  const lines = text.split("\n");
  if ((lines[0] ?? "").trim() !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  return end > 0 ? lines.slice(1, end).join("\n") : null;
}

export function checkSkillHeader(name: string, text: string): SkillHealth {
  const header = frontMatter(text);
  if (header === null) return { name, yamlOk: false, hiddenByPlatforms: false };
  let ok = false;
  try {
    const doc = YAML.parse(header, { uniqueKeys: false }) as unknown; // comme safe_load Python
    ok = !!doc && typeof doc === "object" && !Array.isArray(doc);
  } catch {
    ok = false;
  }
  return { name, yamlOk: ok, hiddenByPlatforms: !ok && /^\s*platforms\s*:/m.test(header) };
}

async function skillsOf(home: string): Promise<SkillHealth[]> {
  const dir = join(home, "skills");
  const out: SkillHealth[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || !(e.isDirectory() || e.isSymbolicLink())) continue;
    try {
      out.push(checkSkillHeader(e.name, await readFile(join(dir, e.name, "SKILL.md"), "utf8")));
    } catch {
      /* pas de SKILL.md (ou lien mort) : pas une skill */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function socketsIn(dir: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".sock")) continue;
      const st = await stat(join(dir, f)).catch(() => null);
      if (st) out.push(prefix + f);
    }
  } catch {
    /* dossier absent ou illisible : rien de présent */
  }
  return out;
}

/**
 * Suffixes des sockets que Hermes 0.21.5 lie sous HERMES_HOME (relevé du pack, étape B) : passerelle, témoin du watchdog
 * (PID au pire), et `bot-desktop/rfb.sock` (lot B, 08/10 : ajouté ici, il manquait par rapport au pack). Côté Paperclip, le
 * worker du plugin communique par un canal IPC hérité (`fork`, stdio « ipc » : paire de sockets anonyme, aucun chemin) et le
 * bac à sable d'adapter-utils lie `proxy.sock` dans son propre dossier temporaire (contrôle de longueur à lui) : ni l'un ni
 * l'autre ne dépend de l'enveloppe — lu dans le source de Paperclip 2026.1001.0, non observé en fonctionnement.
 */
export const HERMES_SOCKET_SUFFIXES = ["gateway.sock", `state/gateway.loop-tick.${WORST_CASE_PID}.sock`, "bot-desktop/rfb.sock"] as const;

/** Chemins de sockets attendus pour la version épinglée, même quand aucun socket n'existe encore. */
export function expectedSocketPaths(home: string): string[] {
  return HERMES_SOCKET_SUFFIXES.map((s) => join(home, s));
}

/**
 * Budget calculé SANS toucher au disque, sur la chaîne LITTÉRALE qui sera transmise en HERMES_HOME (celle que Hermes passe à
 * bind()) — à utiliser AVANT la création d'un profil. La destination canonique (droits, appartenance) se vérifie à part.
 */
export function budgetSockets(literalHome: string): { hermesHome: string; pire: string; octets: number; limite: number; ok: boolean } {
  const home = literalHome.replace(/\/+$/, "");
  let pire = "";
  for (const s of HERMES_SOCKET_SUFFIXES) {
    const p = `${home}/${s}`;
    if (Buffer.byteLength(p, "utf8") > Buffer.byteLength(pire, "utf8")) pire = p;
  }
  const octets = Buffer.byteLength(pire, "utf8");
  return { hermesHome: home, pire, octets, limite: SOCKET_PATH_MAX, ok: octets <= SOCKET_PATH_MAX };
}

/** Mesure (en octets UTF-8) des chemins attendus + de tout *.sock présent dans home et home/state. Pure lecture. */
export async function checkSocketPaths(home: string): Promise<SocketPathCheck> {
  const socketBase = home;
  const sockets = [...(await socketsIn(home, "")), ...(await socketsIn(join(home, "state"), "state/")), ...(await socketsIn(join(home, "bot-desktop"), "bot-desktop/"))];
  const candidates = [...expectedSocketPaths(home), ...sockets.map((f) => join(home, f))];
  let longest = candidates[0]!;
  for (const c of candidates) if (Buffer.byteLength(c, "utf8") > Buffer.byteLength(longest, "utf8")) longest = c;
  const socketPathBytes = Buffer.byteLength(longest, "utf8");
  return { socketPathBytes, socketPathOk: socketPathBytes <= SOCKET_PATH_MAX, longest, sockets, socketBase };
}

export function socketPathAlert(c: SocketPathCheck): string {
  return `chemin de socket trop long : ${c.socketPathBytes} octets (max ${SOCKET_PATH_MAX}, limite système ${SOCKET_SUN_PATH_LIMIT}) pour ${c.longest} — racine trop profonde`;
}

/**
 * `socketBase` : le HERMES_HOME littéral (sans realpath) que reçoit Hermes, construit depuis la racine d'exécution administrée —
 * Hermes lie ses sockets sur ce chemin tel quel (un lien court vers une racine profonde est donc accepté). Sinon `home`.
 */
export async function checkProfile(home: string, socketBase: string = home): Promise<ProfileHealth> {
  const sock = await checkSocketPaths(socketBase);
  const skills = await skillsOf(home);
  const { error: configError } = await readConfigStrict(home);
  const alerts: string[] = [];
  if (!sock.socketPathOk) alerts.push(socketPathAlert(sock));
  for (const s of skills) {
    if (s.hiddenByPlatforms) alerts.push(`skill « ${s.name} » cachée : en-tête YAML invalide avec \`platforms:\``);
    else if (!s.yamlOk) alerts.push(`skill « ${s.name} » : en-tête YAML invalide ou absent`);
  }
  if (configError) alerts.push(configError);
  return { ...sock, skills, configError, alerts };
}

/** installé = profil présent ; connecté = authStatus logged_in ; connecté et synchronisé = connecté + dernière synchro sans erreur. */
export function agentState(rec: { error: string | null }, profile: Pick<HermesProfile, "authStatus">): AgentState {
  if (profile.authStatus !== "logged_in") return "installed";
  return rec.error === null ? "synced" : "connected";
}

export const STATE_LABEL: Record<AgentState, string> = { installed: "installé", connected: "connecté", synced: "connecté et synchronisé" };
