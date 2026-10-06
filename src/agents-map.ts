// Carte agentId Paperclip → profil Hermes (« affectation »), partagée par le plugin et l'adaptateur.
// Pourquoi : Paperclip appelle listSkills / syncSkills avec seulement l'identifiant de l'agent (pas son nom) ;
// et depuis la 0.6 l'adaptateur refuse de lancer un agent qui n'y figure pas (R02b : affectation contrôlée avant réveil).
// Écrite par le plugin à chaque synchro / préparation, sous verrou ; un fichier corrompu n'est jamais réécrit.
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RememberedAgent {
  name: string;
  instance: string;
  profile: string;
  home: string;
  at: string;
}

const LOCK_WAIT_MS = 2_000; // délai maximal d'attente du verrou
const LOCK_STALE_MS = 30_000; // au-delà, un verrou oublié (processus mort) est repris
const LOCK_RETRY_MS = 25;

/** Calculé à l'appel (pas à l'import) : HOME peut changer, notamment dans les tests. */
export function agentsMapFile(): string {
  return join(homedir(), ".config", "hermes-control", "agents.json");
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Verrou par dossier (mkdir atomique) autour d'une lecture-modification-écriture. */
async function withMapLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = `${agentsMapFile()}.lock`;
  await mkdir(dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const st = await stat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`agents.json : verrou tenu trop longtemps (${lock})`);
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
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
