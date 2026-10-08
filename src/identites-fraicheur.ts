// Lot B — projection PÉRIMÉE. Le pack fait avancer `revision` de 1 à chaque écriture et ses compteurs ne reculent jamais.
// Hermes Control retient, dans SON dossier de référence (jamais dans la projection, qu'il n'écrit pas), la plus haute
// révision lue par enveloppe, avec l'empreinte de son contenu et les compteurs. Refus (rien n'est préparé ni lancé) :
//   - révision plus basse que celle déjà lue : copie ancienne, restauration partielle ou second écrivain ;
//   - même révision, contenu différent : écriture hors du pack ;
//   - un compteur d'alias en recul : un alias pourrait être réattribué (choix de Cyril M : jamais de réutilisation).
// Une lecture qui croise une écriture du pack peut voir l'ancienne révision : on relit une fois avant de refuser.
// Après une restauration VOULUE de la projection, le pack réécrit une révision supérieure ; sinon l'administrateur
// supprime le fichier d'état (nommé dans le refus).
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withDirLock } from "./lock.js";
import { controlDir } from "./paths.js";
import { type Projection, readIdentites } from "./identites.js";
import type { Workspace } from "./workspace.js";

interface Seen { revision: number; sha256: string; compteurs: Projection["compteurs"]; vuLe: string }
type State = Record<string, Seen>; // clé : envelope.root

export function freshnessFile(): string {
  return join(controlDir(), "identites-vues.json");
}

async function readState(): Promise<State> {
  try {
    const x = JSON.parse(await readFile(freshnessFile(), "utf8"));
    return x && typeof x === "object" && !Array.isArray(x) ? (x as State) : {};
  } catch {
    return {}; // absent (ou illisible : on repart de la projection lue ; jamais un refus de ce seul fait)
  }
}

/** Raison du refus si `p` est plus ancienne que ce que HC a déjà lu ; sinon null (et la nouvelle révision est retenue). */
async function checkAndRecord(root: string, p: Projection, sha: string): Promise<string | null> {
  const lock = `${freshnessFile()}.lock`;
  return withDirLock(lock, { waitMs: 5_000, staleMs: 30_000, busy: `projection : verrou de fraîcheur tenu trop longtemps (${lock})` }, async () => {
    const state = await readState();
    const seen = state[root];
    const fix = `le pack doit réécrire la projection courante (révision supérieure) ; après une restauration voulue, supprime ${freshnessFile()}`;
    if (seen) {
      if (p.revision < seen.revision) return `projection périmée : révision r${p.revision} < r${seen.revision} déjà lue par Hermes Control le ${seen.vuLe} (copie ancienne, restauration partielle ou second écrivain ?) ; refus non réessayé ; ${fix}`;
      if (p.revision === seen.revision && sha !== seen.sha256) return `projection incohérente : révision r${p.revision} déjà lue avec un autre contenu (écriture hors du pack ?) ; refus non réessayé ; ${fix}`;
      const recul = (["e", "i", "a"] as const).filter((k) => p.compteurs[k] < seen.compteurs[k]);
      if (recul.length) return `projection périmée : compteur(s) d'alias en recul (${recul.map((k) => `${k} ${p.compteurs[k]} < ${seen.compteurs[k]}`).join(", ")}) : un alias pourrait être réattribué ; refus non réessayé ; ${fix}`;
      if (p.revision === seen.revision) return null;
    }
    state[root] = { revision: p.revision, sha256: sha, compteurs: { ...p.compteurs }, vuLe: new Date().toISOString() };
    const tmp = `${freshnessFile()}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2) + "\n");
    await rename(tmp, freshnessFile());
    return null;
  });
}

/**
 * Projection valide ET pas plus ancienne que la dernière lue : c'est la seule lecture utilisée par les chemins qui font
 * tourner un agent (préparation, exécution, reprise, skills de l'adaptateur).
 */
export async function readCurrentIdentites(ws: Pick<Workspace, "root">): Promise<{ projection: Projection | null; error: string | null }> {
  let refusal: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await readIdentites(ws);
    if (!r.projection) return { projection: null, error: r.error };
    refusal = await checkAndRecord(r.projection.envelope.root, r.projection, createHash("sha256").update(r.raw ?? "").digest("hex"));
    if (!refusal) return { projection: r.projection, error: null };
  }
  return { projection: null, error: refusal };
}
