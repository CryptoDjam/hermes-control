// Carte agentId Paperclip → profil Hermes (« affectation »), partagée par le plugin et l'adaptateur.
// Pourquoi : Paperclip appelle listSkills / syncSkills avec seulement l'identifiant de l'agent (pas son nom) ;
// et depuis la 0.6 l'adaptateur refuse de lancer un agent qui n'y figure pas (R02b : affectation contrôlée avant réveil).
// Écrite par le plugin à chaque synchro / préparation, sous verrou ; un fichier corrompu n'est jamais réécrit.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withDirLock } from "./lock.js";
import { controlDir } from "./paths.js";

export interface RememberedAgent {
  name: string;
  instance: string;
  profile: string;
  home: string;
  at: string;
}

const LOCK_WAIT_MS = 2_000; // délai maximal d'attente du verrou
const LOCK_STALE_MS = 30_000; // au-delà, un verrou oublié (processus mort) est repris

/** Calculé à l'appel (pas à l'import) : HERMES_CONTROL_AGENTS_MAP si défini, sinon ~/.config/hermes-control/agents.json. */
export function agentsMapFile(): string {
  const env = process.env["HERMES_CONTROL_AGENTS_MAP"]?.trim();
  return env || join(controlDir(), "agents.json");
}

/** Absent → carte vide ; présent mais pas un objet JSON valide → `error` (le fichier reste tel quel). */
async function readMap(): Promise<{ map: Record<string, RememberedAgent>; error: string | null }> {
  let text: string;
  try {
    text = await readFile(agentsMapFile(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { map: {}, error: null };
    return { map: {}, error: `agents.json illisible : ${(e as Error).message}` };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { map: {}, error: "agents.json corrompu : le contenu n'est pas un objet JSON" };
    return { map: parsed as Record<string, RememberedAgent>, error: null };
  } catch (e) {
    return { map: {}, error: `agents.json corrompu : ${(e as Error).message}` };
  }
}

/** Verrou autour d'une lecture-modification-écriture de la carte. */
function withMapLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = `${agentsMapFile()}.lock`;
  return withDirLock(lock, { waitMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS, busy: `agents.json : verrou tenu trop longtemps (${lock})` }, fn);
}

/** Mémorise l'affectation d'un agent. Refuse (erreur explicite, fichier intact) si agents.json est corrompu. */
export async function rememberAgent(agentId: string, m: Omit<RememberedAgent, "at">): Promise<void> {
  if (!agentId) return;
  await withMapLock(async () => {
    const { map, error } = await readMap();
    if (error) throw new Error(`${error} ; rien n'est écrit — répare ou supprime ${agentsMapFile()}`);
    const prev = map[agentId];
    if (prev && prev.home === m.home && prev.name === m.name && prev.instance === m.instance && prev.profile === m.profile) return;
    map[agentId] = { ...m, at: new Date().toISOString() };
    const file = agentsMapFile();
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, file);
  });
}

/** Affectation d'un agent ; null si inconnu ou si agents.json est corrompu (voir agentsMapError). */
export async function recallAgent(agentId: string): Promise<RememberedAgent | null> {
  if (!agentId) return null;
  const { map, error } = await readMap();
  if (error) return null;
  const r = map[agentId];
  return r && typeof r === "object" && typeof r.home === "string" ? r : null;
}

/** Erreur de lecture de agents.json (null si absent ou valide) : pour l'afficher sans la confondre avec « agent inconnu ». */
export async function agentsMapError(): Promise<string | null> {
  return (await readMap()).error;
}
