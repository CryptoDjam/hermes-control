// Santé d'un profil Hermes et état d'un agent, en lecture seule (aucune commande hermes) :
//  - longueur réelle du chemin des sockets (limite AF_UNIX 108 octets, cible ≤ 100) ;
//  - en-tête YAML de chaque skill (un en-tête invalide avec `platforms:` cache la skill sans bruit) ;
//  - config.yaml illisible ;
//  - trois états par agent : installé (profil présent) / connecté (authStatus logged_in) / autorisé (connecté + dernière synchro sans erreur).
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { type HermesProfile, readConfigStrict } from "./hermes.js";

export const SOCKET_PATH_MAX = 100;

export interface SkillHealth {
  name: string;
  yamlOk: boolean;
  hiddenByPlatforms: boolean; // en-tête invalide ET ligne `platforms:` : Hermes ignore la skill en silence
}

export interface ProfileHealth {
  socketPathBytes: number; // le plus long entre join(home, "gateway.sock") et les *.sock réellement présents
  socketPathOk: boolean;
  sockets: string[]; // fichiers *.sock présents dans home
  skills: SkillHealth[];
  configError: string | null;
  alerts: string[]; // une ligne courte par problème
}

export type AgentState = "installed" | "connected" | "authorized";

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
    const doc = YAML.parse(header) as unknown;
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

export async function checkProfile(home: string): Promise<ProfileHealth> {
  const sockets: string[] = [];
  try {
    for (const f of await readdir(home)) {
      if (!f.endsWith(".sock")) continue;
      const st = await stat(join(home, f)).catch(() => null);
      if (st) sockets.push(f);
    }
  } catch {
    /* profil illisible : mesuré sur gateway.sock seulement */
  }
  const candidates = ["gateway.sock", ...sockets].map((f) => join(home, f));
  const socketPathBytes = Math.max(...candidates.map((p) => Buffer.byteLength(p, "utf8")));
  const skills = await skillsOf(home);
  const { error: configError } = await readConfigStrict(home);
  const alerts: string[] = [];
  if (socketPathBytes > SOCKET_PATH_MAX) alerts.push(`chemin de socket trop long : ${socketPathBytes} octets (max ${SOCKET_PATH_MAX}, limite système 108) — racine trop profonde`);
  for (const s of skills) {
    if (s.hiddenByPlatforms) alerts.push(`skill « ${s.name} » cachée : en-tête YAML invalide avec \`platforms:\``);
    else if (!s.yamlOk) alerts.push(`skill « ${s.name} » : en-tête YAML invalide ou absent`);
  }
  if (configError) alerts.push(configError);
  return { socketPathBytes, socketPathOk: socketPathBytes <= SOCKET_PATH_MAX, sockets, skills, configError, alerts };
}

/** installé = profil présent ; connecté = authStatus logged_in ; autorisé et testé = connecté + dernière synchro sans erreur. */
export function agentState(rec: { error: string | null }, profile: Pick<HermesProfile, "authStatus">): AgentState {
  if (profile.authStatus !== "logged_in") return "installed";
  return rec.error === null ? "authorized" : "connected";
}

export const STATE_LABEL: Record<AgentState, string> = { installed: "installé", connected: "connecté", authorized: "autorisé et testé" };
