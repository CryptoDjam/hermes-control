// `<référence>/agents.json` : PROJECTION DÉRIVÉE de la table d'affectations (assignments.json), jamais une source.
// Réécrite uniquement à chaque écriture de la table (actions d'administration, migration), sous son verrou ; jamais
// « au passage » d'un agent ni à l'ouverture de la vue. Elle porte l'empreinte (`derivedFrom.sha256`) du fichier dont
// elle dérive. L'adaptateur lit la table directement et n'utilise la projection qu'en secours, si son empreinte est
// celle de la table présente. Une projection ancienne (format plat de la 0.4–0.5, sans schemaVersion ni derivedFrom),
// HYBRIDE (projection + entrées plates ajoutées par une 0.5 après un retour arrière) ou corrompue est ignorée et
// signalée (santé + vue) : jamais utilisée comme affectation valide.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { controlDir } from "./paths.js";
import type { AssignmentsTable, CompanyEntry, InstanceSettings } from "./assignments.js";
import type { HermesBinarySpec } from "./binary.js";

export interface ProjectionAgent {
  name: string;
  companyId: string;
  instance: string; // nom de l'instance (basename)
  instanceHome: string;
  profile: string;
  home: string; // HERMES_HOME transmis à Hermes (racine d'exécution littérale + profil)
  at: string; // assignedAt
  by: string; // assignedBy
}

export interface Projection {
  schemaVersion: 1;
  derivedFrom: { file: string; sha256: string; at: string };
  hermes?: HermesBinarySpec;
  instances?: Record<string, InstanceSettings>;
  companies: Record<string, CompanyEntry>;
  agents: Record<string, ProjectionAgent>;
}

const PROJECTION_KEYS = new Set(["schemaVersion", "derivedFrom", "hermes", "instances", "companies", "agents"]);

/** Calculé à l'appel (pas à l'import) : toujours `<référence>/agents.json` (aucune variable ne le déplace). */
export function agentsMapFile(): string {
  return join(controlDir(), "agents.json");
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
  const extra = Object.keys(parsed as Record<string, unknown>).filter((k) => !PROJECTION_KEYS.has(k));
  if (extra.length) {
    return { projection: null, error: `agents.json HYBRIDE : projection 0.6 + ${extra.length} entrée(s) plate(s) écrite(s) par une autre version (0.5 après un retour arrière ?) : ${extra.slice(0, 5).join(", ")}${extra.length > 5 ? "…" : ""} ; ignorée — une écriture de la table (action d'affectation) la régénère, ou restaure-la depuis sa sauvegarde` };
  }
  const projection: Projection = { schemaVersion: 1, derivedFrom: { file: String(p.derivedFrom.file ?? ""), sha256: p.derivedFrom.sha256, at: String(p.derivedFrom.at ?? "") }, companies: (p.companies && typeof p.companies === "object" ? p.companies : {}) as Record<string, CompanyEntry>, agents: p.agents as Record<string, ProjectionAgent> };
  if (p.hermes && typeof p.hermes === "object") projection.hermes = p.hermes;
  if (p.instances && typeof p.instances === "object") projection.instances = p.instances;
  return { projection, error: null };
}

/** État de la projection face à la table présente (santé et vue) : null si tout va bien ou si elle est absente sans table. */
export async function projectionProblem(tableSha256: string | null): Promise<string | null> {
  const { projection, error } = await readProjection();
  if (error) return error;
  if (!projection) return tableSha256 ? "agents.json absent alors que la table existe : projection à régénérer (une action d'affectation la réécrit)" : null;
  if (tableSha256 && projection.derivedFrom.sha256 !== tableSha256) return `agents.json désynchronisé : dérivé de ${projection.derivedFrom.sha256.slice(0, 12)}…, la table est ${tableSha256.slice(0, 12)}… (table modifiée à la main ?) ; une action d'affectation la régénère`;
  return null;
}

/** Projection calculée depuis la table (pure). */
export function projectionOf(table: AssignmentsTable, sourceFile: string, sha256: string, profileHomeOf: (instanceHome: string, profile: string) => string): Projection {
  const agents: Record<string, ProjectionAgent> = {};
  for (const [agentId, a] of Object.entries(table.agents)) {
    agents[agentId] = { name: a.name, companyId: a.companyId, instance: a.instanceHome.split("/").filter(Boolean).pop() ?? a.instanceHome, instanceHome: a.instanceHome, profile: a.profile, home: profileHomeOf(a.instanceHome, a.profile), at: a.assignedAt, by: a.assignedBy };
  }
  const p: Projection = { schemaVersion: 1, derivedFrom: { file: sourceFile, sha256, at: new Date().toISOString() }, companies: table.companies, agents };
  if (table.hermes) p.hermes = table.hermes;
  if (table.instances) p.instances = table.instances;
  return p;
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
