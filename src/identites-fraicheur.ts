// Lot B — FRAÎCHEUR de la projection (correction de la revue Codex du 08/10, §1). Le pack fait avancer `revision` de 1 à
// chaque écriture ; ses compteurs ne reculent jamais ; un agent retiré le reste. Hermes Control retient, dans SON état de
// suivi (jamais dans la projection, qu'il n'écrit pas), par enveloppe : la plus haute révision lue et l'empreinte de son
// contenu, les compteurs au MAXIMUM connu, les identités retirées (pierres tombales) et les alias attribués.
//
// Deux traces indépendantes :
//   - l'état de suivi   <compte>/.config/hermes-control/identites-vues.json (+ .prec : la version valide précédente) ;
//   - le MARQUEUR d'enveloppe <enveloppe>/donnees/.hermes-control-suivi.json (jeton aléatoire, écrit à l'amorçage et à
//     chaque restauration). Il vit dans un autre arbre : supprimer l'état de suivi après usage ne peut plus passer pour
//     une première utilisation.
//
// Règles (refus explicites, cause structurée `identite_inactive`, rien n'est préparé ni lancé) :
//   - JAMAIS INITIALISÉ (ni entrée de suivi ni marqueur) : refus `suivi_non_amorce` ; l'opérateur amorce EXPLICITEMENT
//     (hermes-control-suivi amorcer, restauration.ts) — aucun amorçage implicite à la première lecture ;
//   - état de suivi absent après usage (marqueur présent), tronqué, illisible, permission refusée, schéma invalide, ancien
//     format, marqueur absent/différent, restauration en cours, écriture impossible : refus `etat_suivi_invalide` — jamais
//     un état vide. Un état global illisible refuse TOUTES les enveloppes ; la réinitialisation est ciblée par enveloppe ;
//   - retour en arrière (`projection_perimee`) : révision plus basse ; même révision au contenu différent ; un compteur
//     en recul ; une identité retirée remise active (ou disparue) ; un alias qui change d'identité.
// Écriture : sous verrou (lock.ts), fichier temporaire exclusif + fsync + rename + fsync du dossier. Une lecture qui croise
// une écriture du pack peut voir l'ancienne révision : on relit une fois avant de refuser un retour en arrière.
// Limite : ce mécanisme refuse un retour en arrière OBSERVÉ ; il ne prouve pas que la projection correspond à l'état
// Paperclip courant, et ne protège pas d'un administrateur (ou du même compte) qui modifierait toutes les traces.
// Ce module n'importe que paths, lock et identites (la reproduction de Codex verifier-fraicheur.cjs le charge seul).
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { withDirLock } from "./lock.js";
import { controlDir } from "./paths.js";
import { type CauseIdentite, type IdentiteRefus, type Projection, identiteRefus, readIdentites } from "./identites.js";
import type { Workspace } from "./workspace.js";

export const SUIVI_SCHEMA = 3 as const;
export const MARQUEUR_SCHEMA = 1 as const;
type Compteurs = Projection["compteurs"];
const KEYS = ["e", "i", "a"] as const;

export interface EntreeSuivi {
  revision: number;
  sha256: string; // empreinte du texte de la projection à `revision` ("" si inconnue : restauration sur minimums)
  compteurs: Compteurs; // maximum connu, jamais abaissé
  retires: { agents: string[]; entreprises: string[] }; // pierres tombales : vues « retire », le restent
  alias: { agents: Record<string, string>; entreprises: Record<string, string> }; // id → alias, jamais modifié
  marqueur: string; // = jeton du marqueur d'enveloppe
  amorceLe: string;
  amorcePar: string;
  vuLe: string;
  restaurations: number;
}
export interface Suivi { schema: typeof SUIVI_SCHEMA; generation: string; enveloppes: Record<string, EntreeSuivi> }
// `max` : DEUXIÈME COPIE du maximum (révision, compteurs, retirés), mise à jour à chaque révision retenue, hors du dossier
// de HC : si l'état de suivi est perdu, la restauration la reprend dans son maximum fiable (sauf si l'enveloppe entière a
// été remise d'une ancienne copie en même temps : limite assumée, voir docs/restauration-identites.md).
export type MaxMarqueur = Pick<EntreeSuivi, "revision" | "sha256" | "compteurs" | "retires">;
export interface Marqueur { schema: typeof MARQUEUR_SCHEMA; root: string; marqueur: string; ecritLe: string; par: string; max?: MaxMarqueur }

export type Lu<T> = { kind: "absent" } | { kind: "ok"; value: T } | { kind: "invalide"; regle: string; why: string };

/* ---------- chemins ---------- */

export function freshnessFile(): string {
  return join(controlDir(), "identites-vues.json");
}
export function previousFile(): string {
  return `${freshnessFile()}.prec`;
}
export function suiviLock(): string {
  return `${freshnessFile()}.lock`;
}
export function markerFile(root: string): string {
  return join(root, "donnees", ".hermes-control-suivi.json");
}
export function envelopeKey(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}
/** Dossier des opérations d'une enveloppe (amorçage, restauration) : sauvegardes, bilans, opération en cours. */
export function operationsDir(root: string): string {
  return join(controlDir(), "restaurations", envelopeKey(root));
}
export function inProgressFile(root: string): string {
  return join(operationsDir(root), "en-cours.json");
}

/* ---------- validation ---------- */

const HEX = /^[0-9a-f]{16,64}$/;
const isInt = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0;
const isStrList = (x: unknown): x is string[] => Array.isArray(x) && x.every((v) => typeof v === "string");
const isStrMap = (x: unknown): x is Record<string, string> => !!x && typeof x === "object" && !Array.isArray(x) && Object.values(x).every((v) => typeof v === "string");

export function entryErrors(x: unknown): string[] {
  if (!x || typeof x !== "object" || Array.isArray(x)) return ["entrée non objet"];
  const e = x as Partial<EntreeSuivi>;
  const out: string[] = [];
  if (!isInt(e.revision)) out.push("revision");
  if (typeof e.sha256 !== "string" || !(e.sha256 === "" || /^[0-9a-f]{64}$/.test(e.sha256))) out.push("sha256");
  if (!e.compteurs || !KEYS.every((k) => isInt(e.compteurs![k]))) out.push("compteurs");
  if (!e.retires || !isStrList(e.retires.agents) || !isStrList(e.retires.entreprises)) out.push("retires");
  if (!e.alias || !isStrMap(e.alias.agents) || !isStrMap(e.alias.entreprises)) out.push("alias");
  if (typeof e.marqueur !== "string" || !HEX.test(e.marqueur)) out.push("marqueur");
  for (const k of ["amorceLe", "amorcePar", "vuLe"] as const) if (typeof e[k] !== "string") out.push(k);
  if (!isInt(e.restaurations)) out.push("restaurations");
  return out;
}

function suiviErrors(x: unknown): string[] {
  if (!x || typeof x !== "object" || Array.isArray(x)) return ["pas un objet JSON"];
  const s = x as Partial<Suivi>;
  if (s.schema !== SUIVI_SCHEMA) return [`schema ${JSON.stringify(s.schema)} (attendu ${SUIVI_SCHEMA})`];
  const out: string[] = [];
  if (typeof s.generation !== "string" || !HEX.test(s.generation)) out.push("generation");
  if (!s.enveloppes || typeof s.enveloppes !== "object" || Array.isArray(s.enveloppes)) return [...out, "enveloppes"];
  for (const [root, entry] of Object.entries(s.enveloppes)) {
    if (!isAbsolute(root)) out.push(`enveloppe ${JSON.stringify(root)} non absolue`);
    const errs = entryErrors(entry);
    if (errs.length) out.push(`enveloppe ${root} : ${errs.join(", ")}`);
  }
  return out;
}

/** Ancien format (a1eadae) : { <root>: { revision, sha256, compteurs, vuLe } }, sans marqueur ni pierres tombales. */
export function legacyEntry(x: unknown, root: string): { revision: number; sha256: string; compteurs: Compteurs } | null {
  if (!x || typeof x !== "object" || Array.isArray(x) || "schema" in (x as object)) return null;
  const e = (x as Record<string, unknown>)[root] as { revision?: unknown; sha256?: unknown; compteurs?: Partial<Compteurs> } | undefined;
  if (!e || !isInt(e.revision) || typeof e.sha256 !== "string" || !e.compteurs || !KEYS.every((k) => isInt(e.compteurs![k]))) return null;
  return { revision: e.revision, sha256: e.sha256, compteurs: { e: e.compteurs.e!, i: e.compteurs.i!, a: e.compteurs.a! } };
}

async function readJson(file: string): Promise<{ kind: "absent" } | { kind: "ok"; value: unknown; raw: string } | { kind: "invalide"; regle: string; why: string }> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "invalide", regle: code === "EACCES" || code === "EPERM" ? "permission_refusee" : "illisible", why: `${file} illisible (${code})` };
  }
  try {
    return { kind: "ok", value: JSON.parse(raw), raw };
  } catch (e) {
    return { kind: "invalide", regle: "tronque_ou_corrompu", why: `${file} tronqué ou corrompu (${(e as Error).message})` };
  }
}

export async function readSuiviFile(file = freshnessFile()): Promise<Lu<Suivi> & { legacy?: unknown }> {
  const r = await readJson(file);
  if (r.kind !== "ok") return r;
  const x = r.value;
  if (x && typeof x === "object" && !Array.isArray(x) && !("schema" in x)) return { kind: "invalide", regle: "ancien_format", why: `${file} : ancien format (sans marqueur ni pierres tombales) ; amorçage explicite requis (il reprend ses maxima)`, legacy: x };
  const errs = suiviErrors(x);
  if (errs.length) return { kind: "invalide", regle: "schema_invalide", why: `${file} : schéma invalide (${errs.join(" ; ")})` };
  return { kind: "ok", value: x as Suivi };
}

export async function readMarker(root: string): Promise<Lu<Marqueur>> {
  const f = markerFile(root);
  const r = await readJson(f);
  if (r.kind !== "ok") return r.kind === "invalide" ? { kind: "invalide", regle: `marqueur_${r.regle}`, why: r.why } : r;
  const m = r.value as Partial<Marqueur>;
  const maxOk = m?.max === undefined || (!!m.max && isInt(m.max.revision) && typeof m.max.sha256 === "string" && !!m.max.compteurs && KEYS.every((k) => isInt(m.max!.compteurs[k])) && !!m.max.retires && isStrList(m.max.retires.agents) && isStrList(m.max.retires.entreprises));
  if (!m || typeof m !== "object" || m.schema !== MARQUEUR_SCHEMA || m.root !== root || typeof m.marqueur !== "string" || !HEX.test(m.marqueur) || !maxOk) return { kind: "invalide", regle: "marqueur_invalide", why: `${f} : marqueur invalide (schéma, enveloppe ou jeton)` };
  return { kind: "ok", value: m as Marqueur };
}

/* ---------- écriture atomique ---------- */

type Faute = "suivi-avant-rename" | "marqueur-avant-rename" | null;
let fauteTest: Faute = null;
/** Réservé aux tests : simule une écriture interrompue (fichier temporaire écrit, rename jamais fait). */
export function setWriteFaultForTests(f: Faute): void {
  fauteTest = f;
}

async function fsyncDir(dir: string): Promise<void> {
  const fh = await open(dir, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** tmp exclusif (0600) + fsync + rename + fsync du dossier : le fichier final est l'ancien ou le nouveau, jamais tronqué. */
export async function writeAtomic(file: string, text: string, faute: Faute = null): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fh = await open(tmp, "wx", 0o600);
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
  if (faute && fauteTest === faute) throw new Error(`écriture interrompue (faute injectée : ${faute})`);
  try {
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  await fsyncDir(dirname(file));
}

/** Écrit l'état de suivi ; la version courante, si elle est VALIDE, devient `.prec` (référence de secours). */
export async function writeSuivi(s: Suivi, currentValid: boolean): Promise<void> {
  const errs = suiviErrors(s);
  if (errs.length) throw new Error(`état de suivi à écrire invalide (${errs.join(" ; ")}) ; rien n'est écrit`);
  if (currentValid) {
    await copyFile(freshnessFile(), previousFile()).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? undefined : Promise.reject(e)));
  }
  await writeAtomic(freshnessFile(), JSON.stringify(s, null, 2) + "\n", "suivi-avant-rename");
}

export async function writeMarker(root: string, marqueur: string, par: string, max?: MaxMarqueur): Promise<void> {
  const m: Marqueur = { schema: MARQUEUR_SCHEMA, root, marqueur, ecritLe: new Date().toISOString(), par, ...(max ? { max: { revision: max.revision, sha256: max.sha256, compteurs: { ...max.compteurs }, retires: max.retires } } : {}) };
  await writeAtomic(markerFile(root), JSON.stringify(m, null, 2) + "\n", "marqueur-avant-rename");
}

export const newToken = (): string => randomBytes(16).toString("hex");

/* ---------- contrôle (fonction pure) ---------- */

export interface Ecart { regle: string; message: string }

/**
 * Retour en arrière de `p` par rapport à l'entrée de suivi `e` (ou à un maximum fiable synthétisé), null sinon.
 * Utilisé par la lecture ET par la restauration contrôlée (mêmes règles).
 */
export function controler(e: Pick<EntreeSuivi, "revision" | "sha256" | "compteurs" | "retires" | "alias">, p: Projection, sha: string): Ecart | null {
  if (p.revision < e.revision) return { regle: "revision_inferieure", message: `révision r${p.revision} < r${e.revision} déjà lue (copie ancienne, restauration partielle ou second écrivain ?)` };
  if (p.revision === e.revision && sha !== e.sha256) return { regle: "contenu_different", message: `révision r${p.revision} déjà lue avec un autre contenu (écriture hors du pack ?)` };
  const recul = KEYS.filter((k) => p.compteurs[k] < e.compteurs[k]);
  if (recul.length) return { regle: "compteur_en_recul", message: `compteur(s) d'alias en recul (${recul.map((k) => `${k} ${p.compteurs[k]} < ${e.compteurs[k]}`).join(", ")}) : un alias pourrait être réattribué` };
  for (const id of e.retires.agents) {
    const a = p.agents.find((x) => x.agentId === id);
    if (!a) return { regle: "retiree_disparue", message: `agent retiré ${id} absent de la projection (une identité retirée reste listée, son alias n'est jamais réattribué)` };
    if (a.statut !== "retire") return { regle: "retiree_reactivee", message: `agent ${id} (${a.profileAlias}) retiré mais au statut « ${a.statut} » dans cette révision : une identité retirée n'est jamais remise active` };
  }
  for (const id of e.retires.entreprises) {
    const c = p.companies.find((x) => x.companyId === id);
    if (!c) return { regle: "retiree_disparue", message: `entreprise retirée ${id} absente de la projection` };
    if (c.statut !== "retire") return { regle: "retiree_reactivee", message: `entreprise ${id} (${c.alias}) retirée mais au statut « ${c.statut} » dans cette révision : une identité retirée n'est jamais remise active` };
  }
  const byAliasA = new Map(Object.entries(e.alias.agents).map(([id, al]) => [al, id]));
  for (const a of p.agents) {
    const known = e.alias.agents[a.agentId];
    if (known !== undefined && known !== a.profileAlias) return { regle: "alias_modifie", message: `agent ${a.agentId} : alias ${a.profileAlias} ≠ ${known} déjà vu (une identité ne change pas d'alias)` };
    const owner = byAliasA.get(a.profileAlias);
    if (owner !== undefined && owner !== a.agentId) return { regle: "alias_modifie", message: `alias ${a.profileAlias} déjà vu pour l'agent ${owner}, maintenant pour ${a.agentId} (jamais de réattribution)` };
  }
  const byAliasE = new Map(Object.entries(e.alias.entreprises).map(([id, al]) => [al, id]));
  for (const c of p.companies) {
    const known = e.alias.entreprises[c.companyId];
    if (known !== undefined && known !== c.alias) return { regle: "alias_modifie", message: `entreprise ${c.companyId} : alias ${c.alias} ≠ ${known} déjà vu` };
    const owner = byAliasE.get(c.alias);
    if (owner !== undefined && owner !== c.companyId) return { regle: "alias_modifie", message: `alias ${c.alias} déjà vu pour l'entreprise ${owner}, maintenant pour ${c.companyId}` };
  }
  return null;
}

/** Entrée enrichie par la projection acceptée : maxima, pierres tombales et alias réunis (rien n'est jamais retiré). */
export function absorb<T extends Pick<EntreeSuivi, "revision" | "sha256" | "compteurs" | "retires" | "alias">>(e: T, p: Projection, sha: string): T {
  const out = JSON.parse(JSON.stringify(e)) as T;
  if (p.revision >= out.revision) {
    out.revision = p.revision;
    out.sha256 = sha;
  }
  for (const k of KEYS) out.compteurs[k] = Math.max(out.compteurs[k], p.compteurs[k]);
  const ra = new Set(out.retires.agents);
  for (const a of p.agents) if (a.statut === "retire") ra.add(a.agentId);
  const rc = new Set(out.retires.entreprises);
  for (const c of p.companies) if (c.statut === "retire") rc.add(c.companyId);
  out.retires = { agents: [...ra].sort(), entreprises: [...rc].sort() };
  for (const a of p.agents) out.alias.agents[a.agentId] ??= a.profileAlias;
  for (const c of p.companies) out.alias.entreprises[c.companyId] ??= c.alias;
  return out;
}

export const emptyMax = (): Pick<EntreeSuivi, "revision" | "sha256" | "compteurs" | "retires" | "alias"> => ({ revision: 0, sha256: "", compteurs: { e: 0, i: 0, a: 0 }, retires: { agents: [], entreprises: [] }, alias: { agents: {}, entreprises: {} } });

/* ---------- lecture contrôlée ---------- */

export interface Refus { cause: CauseIdentite; regle: string; message: string }
const AIDE = "hermes-control-suivi (opérateur seulement) : `etat` pour le bilan, `amorcer --enveloppe <dossier>` pour une enveloppe jamais amorcée, `restaurer --enveloppe <dossier>` après une restauration voulue ou une perte d'état";

async function present(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    (e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? false : Promise.reject(e)),
  );
}

/** Raison du refus si `p` ne peut pas être utilisée ; sinon null (et la révision acceptée est retenue, maxima compris). */
async function checkAndRecord(root: string, p: Projection, sha: string): Promise<Refus | null> {
  return withDirLock(suiviLock(), { waitMs: 5_000, staleMs: 30_000, busy: `projection : verrou de l'état de suivi tenu trop longtemps (${suiviLock()})` }, async () => {
    const suivi = (s: Omit<Refus, "cause">): Refus => ({ cause: "etat_suivi_invalide", ...s, message: `${s.message} ; refus non réessayé ; ${AIDE}` });
    try {
      if (await present(inProgressFile(root))) return suivi({ regle: "restauration_en_cours", message: `état de suivi : une opération de l'opérateur est en cours ou interrompue pour l'enveloppe ${root} (${inProgressFile(root)}) ; elle doit être reprise jusqu'au bout` });
    } catch (e) {
      return suivi({ regle: "illisible", message: `état de suivi : ${inProgressFile(root)} illisible (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})` });
    }
    const s = await readSuiviFile();
    const m = await readMarker(root);
    if (s.kind === "invalide") return suivi({ regle: s.regle, message: `état de suivi invalide : ${s.why} (jamais traité comme un état vide)` });
    if (m.kind === "invalide") return suivi({ regle: m.regle, message: `marqueur d'enveloppe invalide : ${m.why}` });
    const entry = s.kind === "ok" ? s.value.enveloppes[root] : undefined;
    if (!entry) {
      if (m.kind === "ok") return suivi({ regle: s.kind === "absent" ? "suivi_absent_apres_usage" : "enveloppe_absente_du_suivi", message: `état de suivi ${s.kind === "absent" ? `${freshnessFile()} absent` : `sans entrée pour ${root}`} alors que l'enveloppe a déjà été suivie (marqueur ${markerFile(root)} du ${m.value.ecritLe}) : perte ou suppression après usage` });
      return { cause: "suivi_non_amorce", regle: "jamais_amorce", message: `enveloppe ${root} jamais amorcée pour Hermes Control (ni état de suivi ni marqueur) ; refus non réessayé ; amorçage explicite par l'opérateur : ${AIDE}` };
    }
    if (m.kind === "absent") return suivi({ regle: "marqueur_absent", message: `marqueur d'enveloppe ${markerFile(root)} absent alors que l'état de suivi la connaît (enveloppe restaurée d'une copie antérieure à l'amorçage ?)` });
    if (m.value.marqueur !== entry.marqueur) return suivi({ regle: "marqueur_different", message: `marqueur d'enveloppe ${markerFile(root)} différent de celui de l'état de suivi (copie d'une autre génération ?)` });
    const ecart = controler(entry, p, sha);
    if (ecart) return { cause: "projection_perimee", regle: ecart.regle, message: `projection périmée : ${ecart.message} ; refus non réessayé ; le pack doit réécrire la projection courante (révision supérieure, compteurs au maximum, retirés conservés) ; après une restauration voulue : ${AIDE}` };
    if (p.revision === entry.revision) return null; // même contenu : rien à retenir
    const next: Suivi = JSON.parse(JSON.stringify(s.kind === "ok" ? s.value : null)) as Suivi;
    const updated: EntreeSuivi = { ...absorb(entry, p, sha), vuLe: new Date().toISOString() };
    next.enveloppes[root] = updated;
    try {
      await writeSuivi(next, true);
    } catch (e) {
      return suivi({ regle: "ecriture_impossible", message: `état de suivi : nouvelle révision r${p.revision} non enregistrée (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})` });
    }
    // deuxième copie du maximum dans le marqueur (même jeton) : au mieux — l'état de suivi, déjà écrit, fait foi
    await writeMarker(root, entry.marqueur, m.value.par, updated).catch(() => undefined);
    return null;
  });
}

export type LectureCourante = { projection: Projection; error: null; refus: null; sha256: string } | { projection: null; error: string; refus: IdentiteRefus };

/**
 * Projection valide ET pas plus ancienne que ce que HC a déjà lu : c'est la seule lecture utilisée par les chemins qui
 * font tourner un agent (préparation, exécution, reprise, skills de l'adaptateur). `refus` : cause structurée.
 */
export async function readCurrentIdentites(ws: Pick<Workspace, "root">): Promise<LectureCourante> {
  let last: { refus: Refus; sha: string; revision: number } | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await readIdentites(ws);
    if (!r.projection) return { projection: null, error: r.error!, refus: identiteRefus("projection_invalide", { regle: r.regle ?? "illisible" }) };
    const sha = createHash("sha256").update(r.raw ?? "").digest("hex");
    let refus: Refus | null;
    try {
      refus = await checkAndRecord(r.projection.envelope.root, r.projection, sha);
    } catch (e) {
      refus = { cause: "etat_suivi_invalide", regle: "verrou", message: `état de suivi inaccessible : ${(e as Error).message} ; refus non réessayé` };
    }
    if (!refus) return { projection: r.projection, error: null, refus: null, sha256: sha };
    last = { refus, sha, revision: r.projection.revision };
    if (refus.cause !== "projection_perimee") break; // seule une course avec l'écrivain justifie une relecture
  }
  return { projection: null, error: last!.refus.message, refus: identiteRefus(last!.refus.cause, { regle: last!.refus.regle, empreinte: last!.sha, revision: last!.revision }) };
}
