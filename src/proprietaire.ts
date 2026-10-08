// Propriétaire d'un dossier métier d'agent (lot B, court terme de C2 — revue Codex du 08/10 §2, commentaires §3).
// Un dossier métier (0.6.x : <ws>/agents/<slug> ; cible 0.2 : <ws>/donnees/e/<e>/a/<a>) appartient à UNE identité Paperclip
// (companyId, agentId). Le propriétaire est enregistré au moment où Hermes Control CRÉE le dossier, et seulement alors :
//   <dossier>/.hermes-control/proprietaire.json  { schemaVersion, companyId, agentId, companyAlias?, agentAlias?, creeLe }
// Création atomique : dossier temporaire `.creation-<empreinte de l'agentId>` du même parent, marqueur écrit dedans, puis
// rename vers le nom final (échoue si un dossier non vide existe déjà : deux préparations simultanées → un seul gagnant).
// Règles :
//  - dossier existant AVEC marqueur d'une autre identité → refus (rien n'est créé, ni profil ni lien) ;
//  - dossier existant SANS marqueur → refus : aucune adoption automatique (il peut déjà être partagé, ex. agents/chef de
//    deux instances) ; il relève de l'inventaire de migration (plan 0.1 → 0.2) ;
//  - le dossier, ses sous-dossiers et le lien mémoire du profil doivent se résoudre là où on les attend : un lien étranger
//    (vers le dossier d'un autre agent ou hors de l'enveloppe) est refusé, jamais suivi ni remplacé.
// Limite : un processus du même compte Unix peut réécrire le marqueur ; il protège contre les collisions et les erreurs de
// configuration, pas contre un agent malveillant du même UID (isolation = comptes ou conteneurs, plus tard).
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface Owner { companyId: string; agentId: string; companyAlias?: string; agentAlias?: string }
interface OwnerFile extends Owner { schemaVersion: 1; creeLe: string }

export const OWNER_REL = join(".hermes-control", "proprietaire.json");

export async function readOwner(dir: string): Promise<{ owner: OwnerFile | null; error: string | null }> {
  let txt: string;
  try {
    txt = await readFile(join(dir, OWNER_REL), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { owner: null, error: null };
    return { owner: null, error: `marqueur de propriétaire illisible (${(e as NodeJS.ErrnoException).code})` };
  }
  try {
    const o = JSON.parse(txt) as OwnerFile;
    if (o.schemaVersion !== 1 || typeof o.companyId !== "string" || typeof o.agentId !== "string") return { owner: null, error: "marqueur de propriétaire invalide" };
    return { owner: o, error: null };
  } catch {
    return { owner: null, error: "marqueur de propriétaire corrompu" };
  }
}

function same(o: Owner, w: Owner): boolean {
  return o.companyId === w.companyId && o.agentId === w.agentId && (w.agentAlias === undefined || o.agentAlias === w.agentAlias) && (w.companyAlias === undefined || o.companyAlias === w.companyAlias);
}

async function verifyExisting(dir: string, expectedReal: string, owner: Owner): Promise<void> {
  const st = await lstat(dir);
  if (st.isSymbolicLink()) throw new Error(`préparation refusée : ${dir} est un lien (vers ${await realpath(dir).catch(() => "?")}) ; un dossier métier n'est jamais atteint à travers un lien`);
  if (!st.isDirectory()) throw new Error(`préparation refusée : ${dir} existe et n'est pas un dossier`);
  const real = await realpath(dir);
  if (real !== expectedReal) throw new Error(`préparation refusée : ${dir} se résout en ${real}, pas en ${expectedReal} (lien sur le chemin)`);
  const r = await readOwner(dir);
  if (r.error) throw new Error(`préparation refusée : ${dir} : ${r.error} ; rien n'est créé`);
  if (!r.owner) throw new Error(`préparation refusée : le dossier métier ${dir} existe sans propriétaire enregistré ; il peut appartenir à une autre identité (dossier partagé par nom) : aucune adoption automatique — à traiter par l'inventaire de migration ; rien n'est créé`);
  if (!same(r.owner, owner)) throw new Error(`préparation refusée : le dossier métier ${dir} appartient à une autre identité (agent ${r.owner.agentId}, entreprise ${r.owner.companyId}) ; rien n'est créé`);
}

/**
 * Le dossier métier `dir` appartient-il à `owner` ? Le crée (avec son marqueur) s'il n'existe pas. `expectedReal` est le
 * chemin canonique attendu (parent résolu + nom) : il refuse un lien n'importe où sur le chemin. Rend "cree" ou "existant".
 */
export async function claimAgentDir(dir: string, owner: Owner): Promise<"cree" | "existant"> {
  const parent = dirname(dir);
  await mkdir(parent, { recursive: true });
  const expectedReal = join(await realpath(parent), basename(dir));
  if (await lstat(dir).then(() => true, () => false)) {
    await verifyExisting(dir, expectedReal, owner);
    return "existant";
  }
  const tmp = join(parent, `.creation-${createHash("sha256").update(`${owner.companyId}/${owner.agentId}`).digest("hex").slice(0, 16)}`);
  await rm(tmp, { recursive: true, force: true }); // reste d'une préparation interrompue de CETTE identité (nom dérivé de l'identifiant)
  await mkdir(join(tmp, ".hermes-control"), { recursive: true });
  const rec: OwnerFile = { schemaVersion: 1, ...owner, creeLe: new Date().toISOString() };
  await writeFile(join(tmp, OWNER_REL), JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
  try {
    await rename(tmp, dir);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR") {
      await verifyExisting(dir, expectedReal, owner); // créé entre-temps : seulement s'il est à nous
      return "existant";
    }
    throw e;
  }
  return "cree";
}

/** Un sous-chemin du dossier métier doit se résoudre DANS ce dossier (lien étranger → refus). Absent : rien à vérifier. */
export async function assertInside(path: string, dirReal: string): Promise<void> {
  const real = await realpath(path).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e)));
  if (real === null) {
    if (await lstat(path).then((s) => s.isSymbolicLink(), () => false)) throw new Error(`préparation refusée : ${path} est un lien mort ; rien n'est remplacé`);
    return;
  }
  if (real !== dirReal && !real.startsWith(dirReal + "/")) throw new Error(`préparation refusée : ${path} se résout hors du dossier de l'agent (${real}) : lien étranger ; rien n'est suivi ni remplacé`);
}
