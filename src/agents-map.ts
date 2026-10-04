// Carte agentId Paperclip → profil Hermes, partagée par le plugin et l'adaptateur.
// Pourquoi : Paperclip appelle listSkills / syncSkills avec seulement l'identifiant de l'agent (pas son nom) ;
// l'adaptateur a besoin du profil pour poser les liens de skills dans `<profil>/skills`.
// Écrite par l'adaptateur à chaque passage (execute) et par le plugin à chaque synchro.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RememberedAgent {
  name: string;
  instance: string;
  profile: string;
  home: string;
  at: string;
}

/** Calculé à l'appel (pas à l'import) : HOME peut changer, notamment dans les tests. */
export function agentsMapFile(): string {
  return join(homedir(), ".config", "hermes-control", "agents.json");
}

async function readMap(): Promise<Record<string, RememberedAgent>> {
  try {
    const parsed = JSON.parse(await readFile(agentsMapFile(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, RememberedAgent>) : {};
  } catch {
    return {};
  }
}

export async function rememberAgent(agentId: string, m: Omit<RememberedAgent, "at">): Promise<void> {
  if (!agentId) return;
  const map = await readMap();
  const prev = map[agentId];
  if (prev && prev.home === m.home && prev.name === m.name && prev.instance === m.instance && prev.profile === m.profile) return;
  map[agentId] = { ...m, at: new Date().toISOString() };
  const file = agentsMapFile();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}

export async function recallAgent(agentId: string): Promise<RememberedAgent | null> {
  if (!agentId) return null;
  return (await readMap())[agentId] ?? null;
}
