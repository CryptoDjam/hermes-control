// `~/.config/hermes-control/agents.json` : PROJECTION DÉRIVÉE de la table d'affectations (assignments.json), jamais une
// source. Écrite uniquement par le plugin (sous le verrou de la table) à partir de la table ; elle porte l'empreinte
// (`derivedFrom.sha256`) du fichier dont elle dérive. L'adaptateur lit la table directement et n'utilise la projection
// qu'en secours, si son empreinte est celle de la table présente. Une projection ancienne (format plat de la 0.4–0.6.0,
// sans schemaVersion ni derivedFrom) ou corrompue est ignorée et signalée : jamais utilisée comme affectation valide.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { controlDir } from "./paths.js";
import type { AssignmentsTable, CompanyEntry } from "./assignments.js";

export interface ProjectionAgent {
  name: string;
  companyId: string;
  instance: string; // nom de l'instance (basename)
  instanceHome: string;
  profile: string;
  home: string; // racine du profil (HERMES_HOME au passage)
  at: string; // assignedAt
  by: string; // assignedBy
}

export interface Projection {
  schemaVersion: 1;
  derivedFrom: { file: string; sha256: string; at: string };
  companies: Record<string, CompanyEntry>;
  agents: Record<string, ProjectionAgent>;
}

/** Calculé à l'appel (pas à l'import) : HERMES_CONTROL_AGENTS_MAP si défini, sinon ~/.config/hermes-control/agents.json. */
export function agentsMapFile(): string {
  const env = process.env["HERMES_CONTROL_AGENTS_MAP"]?.trim();
  return env || join(controlDir(), "agents.json");
}

/** Absent → null sans erreur ; projection valide → objet ; format ancien ou corrompu → `error` (le fichier reste tel quel). */
export async function readProjection(): Promise<{ projection: Projection | null; error: string | null }> {
  let text: string;
  try {
    text = await readFile(agentsMapFile(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { projection: null, error: null };
    return { projection: null, error: `agents.json illisible : ${(e as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { projection: null, error: `agents.json corrompu : ${(e as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { projection: null, error: "agents.json corrompu : le contenu n'est pas un objet JSON" };
  const p = parsed as Partial<Projection>;
  if (p.schemaVersion !== 1 || !p.derivedFrom || typeof p.derivedFrom !== "object" || typeof p.derivedFrom.sha256 !== "string") {
    return { projection: null, error: `agents.json : projection ancienne ou sans empreinte (schemaVersion/derivedFrom absents) ; ignorée — relance la migration (scripts/migrate-assignments.mjs) ou une action d'affectation` };
  }
  if (!p.agents || typeof p.agents !== "object" || Array.isArray(p.agents)) return { projection: null, error: "agents.json : projection sans table `agents`" };
  return { projection: { schemaVersion: 1, derivedFrom: { file: String(p.derivedFrom.file ?? ""), sha256: p.derivedFrom.sha256, at: String(p.derivedFrom.at ?? "") }, companies: (p.companies && typeof p.companies === "object" ? p.companies : {}) as Record<string, CompanyEntry>, agents: p.agents as Record<string, ProjectionAgent> }, error: null };
}

/** Projection calculée depuis la table (pure). */
export function projectionOf(table: AssignmentsTable, sourceFile: string, sha256: string, profileHomeOf: (instanceHome: string, profile: string) => string): Projection {
  const agents: Record<string, ProjectionAgent> = {};
  for (const [agentId, a] of Object.entries(table.agents)) {
    agents[agentId] = { name: a.name, companyId: a.companyId, instance: a.instanceHome.split("/").filter(Boolean).pop() ?? a.instanceHome, instanceHome: a.instanceHome, profile: a.profile, home: profileHomeOf(a.instanceHome, a.profile), at: a.assignedAt, by: a.assignedBy };
  }
  return { schemaVersion: 1, derivedFrom: { file: sourceFile, sha256, at: new Date().toISOString() }, companies: table.companies, agents };
}

/** Écriture atomique (tmp + rename, mode 600). À appeler sous le verrou de la table seulement. */
export async function writeProjection(projection: Projection): Promise<void> {
  const file = agentsMapFile();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(projection, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}

/** Erreur de lecture de agents.json (null si absent ou valide) : pour l'afficher sans la confondre avec « agent inconnu ». */
export async function agentsMapError(): Promise<string | null> {
  return (await readProjection()).error;
}
