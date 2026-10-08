// RETOUR ARRIÈRE 0.6.x → 0.5.0 : ce qui peut être automatisé, et le verdict de compatibilité.
// 0.6.2 : la simulation porte sur TOUS les agents hermes_local de toutes les entreprises (export Paperclip OBLIGATOIRE,
// contrôlé : forme, doublons, champs, couverture par entreprise, fraîcheur), pas seulement sur ceux de la table : un agent
// non affecté (refusé en 0.6) que la 0.5 retrouverait par le nom bloque le retour simplifié.
// La 0.5.0 n'a PAS d'affectation explicite : son adaptateur choisit le profil PAR LE NOM à chaque passage (matchAgent sur
// toutes les instances découvertes) et ne lit agents.json (carte plate) que pour les skills. Revenir en 0.5 ne peut donc
// conserver les affectations de la table que si, pour CHAQUE agent affecté, la règle du nom de la 0.5 retombe exactement
// sur le profil affecté. Ce module simule cette règle (même code : match.ts est identique à celui de la 0.5.0) et :
//   - classe chaque agent : identique / autre profil (homonyme, description) / aucun profil (renommé…) ;
//   - propose la carte plate 0.5 (agentId → { name, instance, profile, home, at }) dérivée de la table ;
//   - n'écrit (applyRollback) que si TOUS les agents sont compatibles, après sauvegarde : agents.json seulement
//     (assignments.json est conservé : la 0.5 l'ignore, il sert à revenir en 0.6.1) ;
//   - liste les commandes de paquets, que l'administrateur lance lui-même (rien n'est installé d'ici).
// Si un agent est incompatible, le retour « propre » est IMPOSSIBLE : seule une restauration complète depuis une sauvegarde
// à froid prise avant l'installation de la 0.6.1 ramène un état connu (voir README, section Rollback).
import { copyFile, mkdir, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { agentsMapFile, readProjection } from "./agents-map.js";
import { type AssignmentsTable, assignmentsFile, readAssignments } from "./assignments.js";
import { discoverLight } from "./discovery.js";
import { profileHome } from "./hermes.js";
import { matchAgent } from "./match.js";
import { controlDir } from "./paths.js";

export type RollbackVerdict =
  | "identique" // affecté, la 0.5 retombe sur le profil affecté
  | "autre-profil" // affecté, la 0.5 choisirait un autre profil (homonyme, description)
  | "aucun-profil" // affecté, la 0.5 ne trouverait aucun profil (renommé…) : il ne tournerait plus
  | "non-affecte-retrouve" // NON affecté en 0.6 (refusé), mais la 0.5 le ferait tourner dans un profil trouvé par le nom
  | "non-affecte-sans-profil"; // non affecté, la 0.5 ne trouverait aucun profil : échec du passage, Hermes non lancé

export interface RollbackAgent {
  agentId: string;
  name: string; // nom ACTUEL (export Paperclip)
  companyId: string;
  nameSource: "paperclip";
  assigned: string | null; // profil affecté (chemin canonique) ; null = non affecté
  under05: string | null; // profil que la 0.5 choisirait
  by: "profile-name" | "description" | null;
  verdict: RollbackVerdict;
}

export interface FlatEntry {
  name: string;
  instance: string;
  profile: string;
  home: string;
  at: string;
}

/** Export des agents Paperclip attendu par le retour arrière (scripts/export-agents.mjs). */
export interface AgentsExport {
  kind: "hermes-control/agents-export";
  version: 1;
  collectedAt: string; // ISO
  source: { api: string; method: string };
  /** 0.6.2 : collecteur administrateur d'instance (vérifié par l'export : GET /admin/users répond 200) ; sinon couverture invérifiable. */
  collector: { instanceAdmin: boolean; check: string };
  companies: { id: string; name: string; agentCount: number }[];
  agents: { id: string; name: string; companyId: string; adapterType: string; status?: string | null; hermesCommand?: string | null }[];
}

export interface Coverage {
  collectedAt: string | null;
  ageMinutes: number | null;
  companies: number;
  agents: number;
  hermesAgents: number;
  assignedInTable: number;
  assignedFoundInExport: number;
}

export interface RollbackPlan {
  reference: string;
  table: { file: string; exists: boolean; error: string | null };
  projection: { file: string; error: string | null };
  backups: string[]; // sauvegardes trouvées dans la référence (*.bak-*)
  coverage: Coverage;
  agents: RollbackAgent[];
  compatible: boolean;
  blockers: string[];
  warnings: string[];
  flatMap: Record<string, FlatEntry>;
  commands: string[];
}

const real = async (p: string) => (await realpath(p).catch(() => null)) ?? p;
export const DEFAULT_EXPORT_MAX_AGE_MINUTES = 30;

/**
 * Contrôle de l'export (forme, couverture, fraîcheur). Toute anomalie BLOQUE le retour simplifié : on ne conclut jamais
 * « compatible » sans un inventaire complet de TOUS les agents (affectés ou non) de TOUTES les entreprises.
 */
export function checkExport(raw: unknown, opts: { now: Date; maxAgeMinutes: number; tableModifiedAt: Date | null; tableCompanies: string[]; tableAgents: string[] }): { exp: AgentsExport | null; blockers: string[]; coverage: Pick<Coverage, "collectedAt" | "ageMinutes" | "companies" | "agents"> } {
  const blockers: string[] = [];
  const cov = { collectedAt: null as string | null, ageMinutes: null as number | null, companies: 0, agents: 0 };
  if (raw === null || raw === undefined) return { exp: null, blockers: ["export des agents Paperclip ABSENT (--agents FICHIER, produit par scripts/export-agents.mjs) : sans inventaire complet de tous les agents hermes_local, le retour simplifié est refusé"], coverage: cov };
  const e = raw as Partial<AgentsExport>;
  if (!e || typeof e !== "object" || Array.isArray(e) || e.kind !== "hermes-control/agents-export" || e.version !== 1) {
    return { exp: null, blockers: ["export des agents non reconnu (attendu : kind « hermes-control/agents-export », version 1, produit par scripts/export-agents.mjs ; une simple liste d'agents ne prouve pas la complétude)"], coverage: cov };
  }
  if (!Array.isArray(e.companies) || !Array.isArray(e.agents)) return { exp: null, blockers: ["export incomplet : `companies` et `agents` doivent être des listes"], coverage: cov };
  if (!e.collector || e.collector.instanceAdmin !== true) blockers.push("export collecté SANS droit d'administrateur d'instance (ou sans le vérifier) : un utilisateur limité ne voit ni toutes les entreprises ni tous les agents, la couverture est invérifiable ; refais l'export en administrateur");
  cov.companies = e.companies.length;
  cov.agents = e.agents.length;
  const at = typeof e.collectedAt === "string" ? new Date(e.collectedAt) : null;
  if (!at || Number.isNaN(at.getTime())) blockers.push("export sans date de collecte valide (`collectedAt`) : fraîcheur invérifiable");
  else {
    cov.collectedAt = at.toISOString();
    cov.ageMinutes = Math.round(((opts.now.getTime() - at.getTime()) / 60_000) * 10) / 10;
    if (at.getTime() > opts.now.getTime() + 60_000) blockers.push(`export daté du futur (${at.toISOString()}) : refusé`);
    else if (cov.ageMinutes > opts.maxAgeMinutes) blockers.push(`export PÉRIMÉ : collecté il y a ${cov.ageMinutes} min (max ${opts.maxAgeMinutes} min) ; refais l'export, mutations arrêtées`);
    if (opts.tableModifiedAt && opts.tableModifiedAt.getTime() > at.getTime()) blockers.push(`export PÉRIMÉ : assignments.json a été modifié (${opts.tableModifiedAt.toISOString()}) APRÈS la collecte (${at.toISOString()})`);
  }
  // entreprises : identifiants uniques, compte d'agents cohérent avec la liste
  const companyIds = new Set<string>();
  for (const c of e.companies) {
    if (!c || typeof c.id !== "string" || !c.id) { blockers.push("export : entreprise sans identifiant"); continue; }
    if (companyIds.has(c.id)) blockers.push(`export : entreprise ${c.id} en DOUBLE`);
    companyIds.add(c.id);
    const listed = e.agents.filter((a) => a && a.companyId === c.id).length;
    if (typeof c.agentCount !== "number") blockers.push(`export : entreprise ${c.id} sans nombre d'agents déclaré (agentCount) : couverture invérifiable`);
    else if (c.agentCount !== listed) blockers.push(`export INCOMPLET : entreprise ${c.id} déclare ${c.agentCount} agent(s), ${listed} listé(s)`);
  }
  for (const cid of opts.tableCompanies) if (!companyIds.has(cid)) blockers.push(`export INCOMPLET : l'entreprise ${cid} de la table est absente de l'export`);
  // agents : champs obligatoires, doublons, entreprise connue
  const ids = new Map<string, number>();
  for (const a of e.agents) {
    if (!a || typeof a.id !== "string" || !a.id) { blockers.push("export : agent sans identifiant"); continue; }
    ids.set(a.id, (ids.get(a.id) ?? 0) + 1);
    if (typeof a.name !== "string" || !a.name) blockers.push(`export : agent ${a.id} sans nom`);
    if (typeof a.companyId !== "string" || !a.companyId) blockers.push(`export : agent ${a.id} sans entreprise (companyId)`);
    else if (!companyIds.has(a.companyId)) blockers.push(`export : agent ${a.id} d'une entreprise ${a.companyId} absente de la liste des entreprises`);
    if (typeof a.adapterType !== "string" || !a.adapterType) blockers.push(`export : agent ${a.id} sans type d'adaptateur (adapterType) : impossible de savoir s'il redémarrerait en hermes_local`);
  }
  for (const [id, n] of ids) if (n > 1) blockers.push(`export : agent ${id} en DOUBLE (${n} fois)`);
  for (const id of opts.tableAgents) if (!ids.has(id)) blockers.push(`agent ${id} affecté dans la table mais ABSENT de l'export (supprimé, terminé, ou export incomplet) : impossible de conclure`);
  return { exp: e as AgentsExport, blockers, coverage: cov };
}

/**
 * Plan de retour 0.6.x → 0.5.0 : simulation de la règle du nom de la 0.5 sur TOUS les agents hermes_local de l'export
 * (affectés ou non). `exportData` : contenu JSON de l'export (null = absent → refus).
 */
export async function planRollback(opts: { exportData?: unknown; now?: Date; maxAgeMinutes?: number } = {}): Promise<RollbackPlan> {
  const now = opts.now ?? new Date();
  const read = await readAssignments();
  const proj = await readProjection();
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (read.error) blockers.push(`table refusée (${read.error}) : impossible de vérifier les affectations ; restauration complète requise`);
  let backups: string[] = [];
  try {
    backups = (await readdir(controlDir())).filter((f) => /\.bak-/.test(f)).sort().map((f) => join(controlDir(), f));
  } catch {
    /* référence absente */
  }
  const table: AssignmentsTable = read.table;
  const tableModifiedAt = read.exists ? await stat(assignmentsFile()).then((s) => s.mtime, () => null) : null;
  const chk = checkExport(opts.exportData ?? null, { now, maxAgeMinutes: opts.maxAgeMinutes ?? DEFAULT_EXPORT_MAX_AGE_MINUTES, tableModifiedAt, tableCompanies: Object.keys(table.companies), tableAgents: Object.keys(table.agents) });
  blockers.push(...chk.blockers);
  const list = await discoverLight([]); // mêmes racines que la 0.5 (~/.hermes, roots), lecture seule
  const agents: RollbackAgent[] = [];
  const flatMap: Record<string, FlatEntry> = {};
  const hermes = (chk.exp?.agents ?? []).filter((a) => a && a.adapterType === "hermes_local" && typeof a.id === "string" && typeof a.name === "string");
  for (const x of hermes) {
    const a = table.agents[x.id];
    const m = matchAgent(x.name, list);
    const under05 = m ? await real(m.profile.home) : null;
    if (a) {
      const assigned = profileHome(a.instanceHome, a.profile);
      const verdict: RollbackVerdict = !m ? "aucun-profil" : under05 === (await real(assigned)) ? "identique" : "autre-profil";
      agents.push({ agentId: x.id, name: x.name, companyId: x.companyId, nameSource: "paperclip", assigned, under05, by: m?.by ?? null, verdict });
      if (verdict === "aucun-profil") blockers.push(`« ${x.name} » (${x.id}) : la 0.5 ne trouverait AUCUN profil par le nom (agent renommé, ou profil au nom différent) → il ne tournerait plus`);
      if (verdict === "autre-profil") blockers.push(`« ${x.name} » (${x.id}) : la 0.5 choisirait ${under05} (${m!.by === "profile-name" ? "profil homonyme" : "description"}) au lieu du profil affecté ${assigned} → mauvaise instance / mauvais compte`);
      if (a.companyId !== x.companyId) blockers.push(`« ${x.name} » (${x.id}) : entreprise ${x.companyId} dans Paperclip, ${a.companyId} dans la table : incohérence`);
      flatMap[x.id] = { name: x.name, instance: a.instanceHome.split("/").filter(Boolean).pop() ?? a.instanceHome, profile: a.profile, home: assigned, at: now.toISOString() };
    } else {
      const verdict: RollbackVerdict = m ? "non-affecte-retrouve" : "non-affecte-sans-profil";
      agents.push({ agentId: x.id, name: x.name, companyId: x.companyId, nameSource: "paperclip", assigned: null, under05, by: m?.by ?? null, verdict });
      if (m) blockers.push(`« ${x.name} » (${x.id}, entreprise ${x.companyId}) : NON affecté en 0.6 (refusé), mais la 0.5 le ferait tourner dans ${under05} (${m.by === "profile-name" ? "profil homonyme" : "description"}) → exécution qui n'existe pas aujourd'hui`);
      else warnings.push(`« ${x.name} » (${x.id}) : non affecté ; la 0.5 ne trouverait aucun profil (échec du passage, Hermes non lancé, relances de Paperclip)`);
    }
  }
  for (const [id, a] of Object.entries(table.agents)) {
    const x = chk.exp?.agents.find((y) => y && y.id === id);
    if (x && x.adapterType !== "hermes_local") warnings.push(`agent ${id} (« ${a.name} ») affecté dans la table mais de type ${x.adapterType} dans Paperclip : ignoré par la 0.5`);
  }
  const commands = [
    "# à lancer par l'administrateur, MUTATIONS ARRÊTÉES (pas de création/renommage d'agent, pas d'action du plugin) entre l'export et la réinstallation ; à vérifier en recette (rien n'est installé par ce script)",
    "paperclipai plugin uninstall hermes-control        # sans --force : l'état du plugin est conservé",
    "# depuis 0.7.0, les paquets s'appellent @cyberservices-ai/paperclip-{plugin,adapter}-hermes-control ; la 0.5.0 n'existe que sous les anciens noms ci-dessous (même id de plugin hermes-control, même type hermes_local : l'enregistrement est remplacé, voir docs/migration-0.7.0.md)",
    "paperclipai plugin install paperclip-plugin-hermes-control@0.5.0",
    `paperclipai adapter install --payload-json '{"packageName":"paperclip-adapter-hermes-control","version":"0.5.0"}'`,
    "# les agents doivent retrouver leur hermesCommand d'avant (lanceurs) : la 0.6.x ne les modifie pas ; s'ils ont été retirés, les remettre",
  ];
  return {
    reference: controlDir(),
    table: { file: assignmentsFile(), exists: read.exists, error: read.error },
    projection: { file: agentsMapFile(), error: proj.error },
    backups,
    coverage: { ...chk.coverage, hermesAgents: hermes.length, assignedInTable: Object.keys(table.agents).length, assignedFoundInExport: Object.keys(table.agents).filter((id) => chk.exp?.agents.some((y) => y && y.id === id)).length },
    agents,
    compatible: blockers.length === 0,
    blockers,
    warnings,
    flatMap,
    commands,
  };
}

/** Refus de `--apply` (incompatible) : erreur typée, que le script rend par un message et le code 2 (pas une trace). */
export class RollbackRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RollbackRefused";
  }
}

/**
 * Écrit la carte plate 0.5 (agents.json) dérivée de la table — seulement si le plan est compatible. Sauvegarde d'abord
 * agents.json et assignments.json (`.bak-rollback-<date>`). assignments.json n'est pas modifié.
 */
export async function applyRollback(plan: RollbackPlan): Promise<{ written: string; backups: string[] }> {
  if (!plan.compatible) throw new RollbackRefused(`retour arrière refusé : ${plan.blockers.length} incompatibilité(s) — ${plan.blockers.join(" ; ")} ; seule une restauration complète depuis la sauvegarde à froid est sûre`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backups: string[] = [];
  for (const f of [agentsMapFile(), assignmentsFile()]) {
    try {
      await copyFile(f, `${f}.bak-rollback-${stamp}`);
      backups.push(`${f}.bak-rollback-${stamp}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  const file = agentsMapFile();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(plan.flatMap, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
  return { written: file, backups };
}
