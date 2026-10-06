// RETOUR ARRIÈRE 0.6.1 → 0.5.0 : ce qui peut être automatisé, et le verdict de compatibilité.
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
import { copyFile, mkdir, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { agentsMapFile, readProjection } from "./agents-map.js";
import { type AssignmentsTable, assignmentsFile, readAssignments } from "./assignments.js";
import { discoverLight } from "./discovery.js";
import { profileHome } from "./hermes.js";
import { matchAgent } from "./match.js";
import { controlDir } from "./paths.js";

export type RollbackVerdict = "identique" | "autre-profil" | "aucun-profil";

export interface RollbackAgent {
  agentId: string;
  name: string; // nom utilisé pour la simulation (export Paperclip si fourni, sinon celui de la table)
  nameSource: "paperclip" | "table";
  assigned: string; // profil affecté (chemin canonique)
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

export interface RollbackPlan {
  reference: string;
  table: { file: string; exists: boolean; error: string | null };
  projection: { file: string; error: string | null };
  backups: string[]; // sauvegardes trouvées dans la référence (*.bak-*)
  agents: RollbackAgent[];
  compatible: boolean;
  blockers: string[];
  flatMap: Record<string, FlatEntry>;
  commands: string[];
}

const real = async (p: string) => (await realpath(p).catch(() => null)) ?? p;

export async function planRollback(opts: { agentNames?: Record<string, string> | null } = {}): Promise<RollbackPlan> {
  const read = await readAssignments();
  const proj = await readProjection();
  const blockers: string[] = [];
  if (read.error) blockers.push(`table refusée (${read.error}) : impossible de vérifier les affectations ; restauration complète requise`);
  let backups: string[] = [];
  try {
    backups = (await readdir(controlDir())).filter((f) => /\.bak-/.test(f)).sort().map((f) => join(controlDir(), f));
  } catch {
    /* référence absente */
  }
  const table: AssignmentsTable = read.table;
  const list = await discoverLight([]); // mêmes racines que la 0.5 (~/.hermes, roots), lecture seule
  const agents: RollbackAgent[] = [];
  const flatMap: Record<string, FlatEntry> = {};
  for (const [agentId, a] of Object.entries(table.agents)) {
    const current = opts.agentNames?.[agentId];
    const name = current ?? a.name;
    const assigned = profileHome(a.instanceHome, a.profile);
    const m = matchAgent(name, list);
    const under05 = m ? await real(m.profile.home) : null;
    const verdict: RollbackVerdict = !m ? "aucun-profil" : under05 === (await real(assigned)) ? "identique" : "autre-profil";
    agents.push({ agentId, name, nameSource: current ? "paperclip" : "table", assigned, under05, by: m?.by ?? null, verdict });
    if (verdict === "aucun-profil") blockers.push(`« ${name} » (${agentId}) : la 0.5 ne trouverait AUCUN profil par le nom (agent renommé, ou profil au nom différent) → il ne tournerait plus`);
    if (verdict === "autre-profil") blockers.push(`« ${name} » (${agentId}) : la 0.5 choisirait ${under05} (${m!.by === "profile-name" ? "profil homonyme" : "description"}) au lieu du profil affecté ${assigned} → mauvaise instance / mauvais compte`);
    flatMap[agentId] = { name, instance: a.instanceHome.split("/").filter(Boolean).pop() ?? a.instanceHome, profile: a.profile, home: assigned, at: new Date().toISOString() };
  }
  if (!opts.agentNames && agents.length) blockers.push("noms actuels des agents inconnus (simulation faite avec les noms de la table, au moment de l'affectation) : fournis l'export des agents Paperclip (--agents FICHIER) pour détecter les renommages");
  const commands = [
    "# à lancer par l'administrateur, Paperclip arrêté puis relancé ; à vérifier en recette (rien n'est installé par ce script)",
    "paperclipai plugin uninstall hermes-control        # sans --force : l'état du plugin est conservé",
    "paperclipai plugin install paperclip-plugin-hermes-control@0.5.0",
    `paperclipai adapter install --payload-json '{"packageName":"paperclip-adapter-hermes-control","version":"0.5.0"}'`,
    "# les agents doivent retrouver leur hermesCommand d'avant (lanceurs) : la 0.6.1 ne les modifie pas ; s'ils ont été retirés, les remettre",
  ];
  return {
    reference: controlDir(),
    table: { file: assignmentsFile(), exists: read.exists, error: read.error },
    projection: { file: agentsMapFile(), error: proj.error },
    backups,
    agents,
    compatible: blockers.length === 0,
    blockers,
    flatMap,
    commands,
  };
}

/**
 * Écrit la carte plate 0.5 (agents.json) dérivée de la table — seulement si le plan est compatible. Sauvegarde d'abord
 * agents.json et assignments.json (`.bak-rollback-<date>`). assignments.json n'est pas modifié.
 */
export async function applyRollback(plan: RollbackPlan): Promise<{ written: string; backups: string[] }> {
  if (!plan.compatible) throw new Error(`retour arrière refusé : ${plan.blockers.length} incompatibilité(s) — ${plan.blockers.join(" ; ")} ; seule une restauration complète depuis la sauvegarde à froid est sûre`);
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
