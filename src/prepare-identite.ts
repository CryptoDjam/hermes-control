// Préparation en MODE PROJECTION (lot B, prototype, cible 0.2) : tout vient de l'identité Paperclip (companyId, agentId)
// résolue dans <ws>/donnees/identites.json (écrite par le pack seul) — jamais d'un nom ni d'un paramètre libre.
//   profil  : <ws>/donnees/h/<i>/profiles/<a>     (instance créée par le pack ; HC n'en crée pas)
//   données : <ws>/donnees/e/<e>/a/<a>            (propriétaire enregistré à la création, voir proprietaire.ts)
// Refus (rien n'est créé) : projection invalide, alias absent, entreprise incohérente, agent retiré ou non affecté,
// instance absente ou hors des racines, lien sur le chemin des données, dossier d'une autre identité, budget T16 dépassé
// sur le HERMES_HOME littéral (racine d'exécution administrée comprise).
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type AssignmentsTable, canonicalInstance, executionOf, knownRoots, readAssignments } from "./assignments.js";
import { budgetSockets } from "./health.js";
import type { HermesBin } from "./hermes.js";
import { type Identity, readIdentites, resolveIdentity } from "./identites.js";
import { type PrepareResult, prepareAgent } from "./prepare.js";
import type { Workspace } from "./workspace.js";

export interface PrepareByIdentityInput {
  ws: Workspace;
  companyId: string; // contexte d'action autorisé par Paperclip
  agentId: string;
  title?: string | null;
  entreprise?: string | null;
  askedInstance?: string; // instanceHome éventuellement envoyé par l'interface : doit désigner l'instance de la projection
  binaryFor: (table: AssignmentsTable, instanceReal: string) => Promise<HermesBin>;
}

export async function prepareByIdentity(input: PrepareByIdentityInput): Promise<PrepareResult & { identity: Identity; executionHome: string }> {
  const { projection, error } = await readIdentites(input.ws);
  if (!projection) throw new Error(`préparation refusée : ${error} ; rien n'est préparé`);
  const r = resolveIdentity(input.ws, projection, { companyId: input.companyId, agentId: input.agentId });
  if (!r.ok) throw new Error(`préparation refusée : ${r.reason}`);
  const id = r.ok;
  const roots = await knownRoots();
  const read = await readAssignments({ roots });
  if (read.error) throw new Error(`préparation refusée : ${read.error}`);
  const c = await canonicalInstance(id.instanceHome, roots);
  if (c.real === null) throw new Error(`préparation refusée : instance ${id.instanceAlias} : ${c.error} (le pack crée les instances ; HC n'en crée pas)`);
  if (input.askedInstance && (await canonicalInstance(input.askedInstance, roots)).real !== c.real) throw new Error(`préparation refusée : l'instance demandée (${input.askedInstance}) n'est pas celle de la projection (${id.instanceAlias}) ; l'affectation s'administre dans le pack`);
  // T16 sur la chaîne littérale transmise (racine d'exécution administrée), AVANT de créer quoi que ce soit
  const executionHome = executionOf(read.table, { instanceHome: c.real, profile: id.profile }).home;
  const budget = budgetSockets(executionHome);
  if (!budget.ok) throw new Error(`préparation refusée avant toute création : socket ${budget.pire} = ${budget.octets} octets UTF-8 > ${budget.limite} (T16, chaîne transmise à bind()) ; enveloppe ou racine d'exécution trop longue ; rien n'est créé`);
  // le parent des données doit être exactement <ws>/donnees/e/<e>/a, sans AUCUN lien sur le chemin : chaque composant est
  // vérifié (lstat) avant d'être créé (mkdir non récursif) — on n'écrit jamais à travers un lien étranger
  let cur = input.ws.root;
  for (const part of ["donnees", "e", id.companyAlias, "a"]) {
    cur = join(cur, part);
    const st = await lstat(cur).catch(() => null);
    if (st?.isSymbolicLink()) throw new Error(`préparation refusée : ${cur} est un lien (vers ${await realpath(cur).catch(() => "?")}) : lien sur le chemin des données ; rien n'est créé`);
    if (st && !st.isDirectory()) throw new Error(`préparation refusée : ${cur} n'est pas un dossier ; rien n'est créé`);
    if (!st) await mkdir(cur).catch((e: NodeJS.ErrnoException) => (e.code === "EEXIST" ? undefined : Promise.reject(e)));
  }
  const parent = dirname(id.agentDir);
  const wanted = join(await realpath(input.ws.root), "donnees", "e", id.companyAlias, "a");
  if ((await realpath(parent)) !== wanted) throw new Error(`préparation refusée : ${parent} ne se résout pas en ${wanted} (lien sur le chemin des données) ; rien n'est créé`);
  const res = await prepareAgent({
    ws: input.ws,
    instanceHome: c.real,
    agentName: id.name,
    title: input.title ?? null,
    entreprise: input.entreprise ?? null,
    binary: await input.binaryFor(read.table, c.real),
    owner: { companyId: id.companyId, agentId: id.agentId, companyAlias: id.companyAlias, agentAlias: id.agentAlias },
    profile: id.profile,
    agentDir: id.agentDir,
    executionHome,
  });
  return { ...res, identity: id, executionHome };
}
