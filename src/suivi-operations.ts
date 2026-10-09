// OPÉRATIONS DE L'OPÉRATEUR sur l'état de suivi de la fraîcheur (lot B, revue Codex du 08/10 §1) : AMORÇAGE explicite
// d'une enveloppe jamais suivie et RESTAURATION CONTRÔLÉE d'une enveloppe (après une restauration voulue de la projection
// par le pack, ou une perte/corruption de l'état de suivi). Partage des rôles (docs/restauration-identites.md) :
//   - le PACK possède la projection : sa commande `identites restaurer` remet la projection, la réécrit à une révision
//     supérieure au maximum fiable que HC lui donne (`etat --json`), compteurs au moins à ce maximum, retirés conservés,
//     puis appelle `hermes-control-suivi restaurer` ;
//   - HERMES CONTROL possède son état de suivi : il ne réécrit jamais la projection ; il la valide contre le maximum
//     fiable connu et re-scelle l'enveloppe (nouveau marqueur), sans toucher aux autres enveloppes.
// Garanties : opérateur seulement (refus dans l'environnement d'un run d'agent, confirmation de l'enveloppe exacte) ;
// refus si un écrivain tourne (verrou du pack, verrou du suivi, Hermes lancé dans l'enveloppe) ; le verrou du pack est
// TENU pendant l'opération ; sauvegarde brute (octets + sha256) de la projection, du suivi, de .prec et du marqueur ; bilan
// avant/après ; maximum fiable = max(suivi courant, .prec, ancien format, sauvegardes et bilans précédents, minimums de
// l'opérateur) ; alias et pierres tombales réunis ; reprise après interruption (en-cours.json : les lecteurs refusent
// tant qu'il existe) ; événement « restauration » dans la file bornée (notifications.ts), perte visible et rejouable.
// Ce n'est pas une frontière de sécurité contre le même compte Unix : c'est un parcours contrôlé contre les erreurs.
import { copyFile, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  type EntreeSuivi,
  type Marqueur,
  type Suivi,
  SUIVI_SCHEMA,
  absorb,
  controler,
  emptyMax,
  entryErrors,
  envelopeKey,
  freshnessFile,
  inProgressFile,
  legacyEntry,
  markerFile,
  newToken,
  operationsDir,
  previousFile,
  readMarker,
  readSuiviFile,
  suiviLock,
  writeAtomic,
  writeMarker,
  writeSuivi,
} from "./identites-fraicheur.js";
import { type Projection, identitesFile, readIdentites } from "./identites.js";
import { pidAlive, withDirLock } from "./lock.js";
import { type Evenement, enfiler } from "./notifications.js";

export type TypeOperation = "amorcage" | "restauration";
export const PHASES = ["preparee", "sauvegardee", "marqueur_ecrit", "suivi_ecrit", "terminee"] as const;
export type Phase = (typeof PHASES)[number];
/** Variables posées par Paperclip / Hermes dans l'environnement d'un run d'agent : l'opération y est refusée. */
export const AGENT_ENV = ["PAPERCLIP_AGENT_ID", "PAPERCLIP_RUN_ID", "PAPERCLIP_API_KEY", "PAPERCLIP_TASK_ID", "PAPERCLIP_WAKE_REASON", "HERMES_HOME"] as const;

type Max = ReturnType<typeof emptyMax> & { restaurations: number; sources: string[] };
interface Minimums { revision?: number; e?: number; i?: number; a?: number }

export interface OperationOpts {
  root: string;
  operateur: string;
  confirmation: string; // doit être exactement `root`
  minimums?: Minimums;
  sansReference?: boolean; // restauration sans aucune référence fiable : consigné dans le bilan
  env?: NodeJS.ProcessEnv;
  processus?: () => Promise<{ pid: number; hermesHome: string }[]>; // Hermes en cours (défaut : /proc)
  arretApres?: Phase; // tests : interruption simulée juste après cette phase
}

export interface Fichier { nom: string; source: string; sha256: string; octets: number }
export interface Etat {
  suivi: { etat: string; detail: string | null; generation: string | null };
  entree: { revision: number; compteurs: EntreeSuivi["compteurs"]; retires: { agents: number; entreprises: number }; restaurations: number; amorceLe: string } | null;
  marqueur: { etat: string; ecritLe: string | null; coherent: boolean | null };
  projection: { revision: number; empreinte: string; compteurs: Projection["compteurs"]; statuts: Record<string, number> } | { erreur: string };
  operationEnCours: { id: string; type: TypeOperation; phase: Phase } | null;
}
export interface Bilan {
  schema: 1;
  id: string;
  type: TypeOperation;
  root: string;
  operateur: string;
  debut: string;
  fin: string | null;
  resultat: "termine" | "refuse" | "interrompu";
  raison: string | null;
  reprises: number;
  avant: Etat;
  apres: Etat | null;
  maxFiable: { revision: number; compteurs: EntreeSuivi["compteurs"]; retires: number; sources: string[] } | null;
  sansReference: boolean;
  sauvegarde: { dossier: string; fichiers: Fichier[] } | null;
  evenement: Evenement | null;
  notification: { ecrite: boolean; erreur: string | null; perdus: string[] } | null;
}
interface EnCours { schema: 1; id: string; type: TypeOperation; root: string; operateur: string; phase: Phase; marqueur: string; dossier: string; debut: string; reprises: number; avant: Etat; minimums: Minimums; sansReference: boolean; sauvegarde: Bilan["sauvegarde"] }

export class OperationRefusee extends Error {
  readonly bilan: Bilan | null;
  constructor(message: string, bilan: Bilan | null = null) {
    super(message);
    this.name = "OperationRefusee";
    this.bilan = bilan;
  }
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/* ---------- gardes ---------- */

export function operatorRefusal(o: Pick<OperationOpts, "root" | "operateur" | "confirmation" | "env">): string | null {
  const env = o.env ?? process.env;
  const agent = AGENT_ENV.filter((k) => typeof env[k] === "string" && env[k] !== "");
  if (agent.length) return `refus : environnement d'un run d'agent (${agent.join(", ")}) ; l'amorçage et la restauration sont des gestes de l'OPÉRATEUR, jamais de l'Assistant ni d'un agent`;
  if (!o.operateur || !/^[\p{L}\p{N} ._@-]{1,64}$/u.test(o.operateur)) return "refus : nom d'opérateur manquant ou invalide (--operateur)";
  if (!isAbsolute(o.root) || normalize(o.root) !== o.root || o.root.endsWith("/")) return `refus : enveloppe ${JSON.stringify(o.root)} : chemin absolu normalisé attendu`;
  if (o.confirmation !== o.root) return "refus : confirmation différente du chemin exact de l'enveloppe";
  return null;
}

/** Processus dont HERMES_HOME est dans l'enveloppe (lecture de /proc/<pid>/environ, même compte seulement). */
export async function hermesEnCours(root: string): Promise<{ pid: number; hermesHome: string }[]> {
  const out: { pid: number; hermesHome: string }[] = [];
  for (const d of await readdir("/proc").catch(() => [] as string[])) {
    if (!/^[0-9]+$/.test(d) || Number(d) === process.pid) continue;
    const env = await readFile(`/proc/${d}/environ`).catch(() => null);
    if (!env) continue;
    for (const kv of env.toString("utf8").split("\0")) if (kv.startsWith("HERMES_HOME=")) out.push({ pid: Number(d), hermesHome: kv.slice(12) });
  }
  return out.filter((p) => p.hermesHome === root || p.hermesHome.startsWith(root + "/"));
}

/* ---------- verrou du pack (même format que pack/src/identites.ts : dossier <identites.json>.lock + owner.json) ---------- */

async function prendreVerrouPack(root: string): Promise<{ lock: string; token: string }> {
  const lock = `${identitesFile({ root })}.lock`;
  try {
    await mkdir(lock);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const o = await readFile(join(lock, "owner.json"), "utf8").then((t) => JSON.parse(t) as { pid?: number; host?: string }, () => null);
    const vivant = o && typeof o.pid === "number" && (o.host !== hostname() || pidAlive(o.pid));
    throw new OperationRefusee(`refus : un écrivain du pack tient le verrou de la projection (${lock}${o?.pid ? `, pid ${o.pid}${vivant ? "" : " ARRÊTÉ : verrou orphelin, laisse le pack le reprendre ou retire-le après vérification"}` : ""}) ; arrête les synchronisations du pack puis recommence`);
  }
  const token = randomBytes(16).toString("hex");
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), token, depuis: new Date().toISOString(), par: "hermes-control-suivi" }));
  return { lock, token };
}

async function rendreVerrouPack(v: { lock: string; token: string }): Promise<void> {
  const o = await readFile(join(v.lock, "owner.json"), "utf8").then((t) => JSON.parse(t) as { token?: string }, () => null);
  if (o?.token === v.token) await rm(v.lock, { recursive: true, force: true });
}

/* ---------- état et bilan ---------- */

export async function etatEnveloppe(root: string): Promise<Etat> {
  const s = await readSuiviFile();
  const m = await readMarker(root);
  const e = s.kind === "ok" ? s.value.enveloppes[root] : undefined;
  const p = await readIdentites({ root });
  const statuts: Record<string, number> = {};
  if (p.projection) for (const a of p.projection.agents) statuts[`agent_${a.statut}`] = (statuts[`agent_${a.statut}`] ?? 0) + 1;
  if (p.projection) for (const c of p.projection.companies) statuts[`entreprise_${c.statut}`] = (statuts[`entreprise_${c.statut}`] ?? 0) + 1;
  const op = await lireEnCours(root).catch(() => null);
  return {
    suivi: { etat: s.kind === "ok" ? (e ? "ok" : "sans_entree") : s.kind === "absent" ? "absent" : s.regle, detail: s.kind === "invalide" ? s.why : null, generation: s.kind === "ok" ? s.value.generation : null },
    entree: e ? { revision: e.revision, compteurs: e.compteurs, retires: { agents: e.retires.agents.length, entreprises: e.retires.entreprises.length }, restaurations: e.restaurations, amorceLe: e.amorceLe } : null,
    marqueur: { etat: m.kind === "ok" ? "ok" : m.kind === "absent" ? "absent" : m.regle, ecritLe: m.kind === "ok" ? m.value.ecritLe : null, coherent: m.kind === "ok" && e ? m.value.marqueur === e.marqueur : null },
    projection: p.projection ? { revision: p.projection.revision, empreinte: sha(p.raw ?? ""), compteurs: p.projection.compteurs, statuts } : { erreur: p.error ?? "illisible" },
    operationEnCours: op ? { id: op.id, type: op.type, phase: op.phase } : null,
  };
}

async function lireEnCours(root: string): Promise<EnCours | null> {
  let t: string;
  try {
    t = await readFile(inProgressFile(root), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const x = JSON.parse(t) as EnCours;
  if (x?.schema !== 1 || x.root !== root || !(PHASES as readonly string[]).includes(x.phase)) throw new OperationRefusee(`refus : opération en cours ${inProgressFile(root)} invalide ; examine-la (sauvegarde dans ${operationsDir(root)}) avant toute action`);
  return x;
}

const ecrireEnCours = (op: EnCours) => writeAtomic(inProgressFile(op.root), JSON.stringify(op, null, 2) + "\n");

/* ---------- sauvegarde brute ---------- */

async function sauvegarder(root: string, dossier: string): Promise<Fichier[]> {
  await mkdir(dossier, { recursive: true, mode: 0o700 });
  const out: Fichier[] = [];
  for (const [nom, source] of [["identites.json", identitesFile({ root })], ["identites-vues.json", freshnessFile()], ["identites-vues.json.prec", previousFile()], ["marqueur.json", markerFile(root)]] as const) {
    let buf: Buffer;
    try {
      buf = await readFile(source);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw new OperationRefusee(`refus : ${source} illisible (${code}) ; impossible de le sauvegarder avant l'opération, rien n'est modifié`);
    }
    await copyFile(source, join(dossier, nom));
    const fh = await open(join(dossier, nom), "r+");
    await fh.sync().finally(() => fh.close());
    const relu = await readFile(join(dossier, nom));
    if (sha(relu) !== sha(buf)) throw new OperationRefusee(`refus : sauvegarde de ${source} non conforme (empreinte relue différente) ; rien n'est modifié`);
    out.push({ nom, source, sha256: sha(buf), octets: buf.length });
  }
  return out;
}

/* ---------- maximum fiable ---------- */

function plus(m: Max, e: Pick<EntreeSuivi, "revision" | "sha256" | "compteurs" | "retires" | "alias"> & { restaurations?: number }, source: string): void {
  if (e.revision > m.revision || (e.revision === m.revision && !m.sha256)) {
    m.revision = e.revision;
    m.sha256 = e.sha256;
  } else if (e.revision === m.revision && e.sha256 !== m.sha256) m.sha256 = ""; // deux contenus pour une révision : aucun n'est retenu
  for (const k of ["e", "i", "a"] as const) m.compteurs[k] = Math.max(m.compteurs[k], e.compteurs[k]);
  m.retires = { agents: [...new Set([...m.retires.agents, ...e.retires.agents])].sort(), entreprises: [...new Set([...m.retires.entreprises, ...e.retires.entreprises])].sort() };
  for (const [id, al] of Object.entries(e.alias.agents)) m.alias.agents[id] ??= al;
  for (const [id, al] of Object.entries(e.alias.entreprises)) m.alias.entreprises[id] ??= al;
  m.restaurations = Math.max(m.restaurations, e.restaurations ?? 0);
  m.sources.push(source);
}

async function entreeDe(file: string, root: string): Promise<{ entry: EntreeSuivi | null; legacy: ReturnType<typeof legacyEntry> }> {
  const s = await readSuiviFile(file);
  if (s.kind === "ok") return { entry: s.value.enveloppes[root] ?? null, legacy: null };
  if (s.kind === "invalide" && "legacy" in s) return { entry: null, legacy: legacyEntry(s.legacy, root) };
  return { entry: null, legacy: null };
}

/** Maximum fiable connu : suivi courant, .prec, ancien format, TOUTES les sauvegardes et bilans de cette enveloppe, minimums. */
async function maxFiable(root: string, minimums: Minimums): Promise<Max> {
  const m: Max = { ...emptyMax(), restaurations: 0, sources: [] };
  const fichiers: [string, string][] = [[freshnessFile(), "suivi courant"], [previousFile(), "suivi précédent (.prec)"]];
  // sauvegardes de TOUTES les enveloppes : l'état de suivi est commun, une sauvegarde prise pour une autre enveloppe
  // contient aussi l'entrée de celle-ci (et l'ancien format écrasé par un amorçage voisin)
  const base = join(operationsDir(root), "..");
  for (const env of await readdir(base).catch(() => [] as string[])) {
    for (const op of await readdir(join(base, env)).catch(() => [] as string[])) {
      for (const nom of ["identites-vues.json", "identites-vues.json.prec"]) fichiers.push([join(base, env, op, nom), `sauvegarde ${env === envelopeKey(root) ? "" : `${env}/`}${op}/${nom}`]);
    }
  }
  for (const [f, label] of fichiers) {
    const { entry, legacy } = await entreeDe(f, root);
    if (entry && !entryErrors(entry).length) plus(m, entry, label);
    else if (legacy) plus(m, { ...legacy, retires: { agents: [], entreprises: [] }, alias: { agents: {}, entreprises: {} } }, `${label} (ancien format)`);
  }
  // deuxième copie du maximum : marqueur courant et marqueurs sauvegardés
  const marqueurs: [string, string][] = [[markerFile(root), "marqueur d'enveloppe"]];
  for (const op of await readdir(operationsDir(root)).catch(() => [] as string[])) marqueurs.push([join(operationsDir(root), op, "marqueur.json"), `sauvegarde ${op}/marqueur.json`]);
  for (const [f, label] of marqueurs) {
    const mk = await readFile(f, "utf8").then((t) => JSON.parse(t) as Marqueur, () => null);
    if (mk?.root === root && mk.max && entryErrors({ ...mk.max, alias: { agents: {}, entreprises: {} }, marqueur: "0".repeat(32), amorceLe: "", amorcePar: "", vuLe: "", restaurations: 0 }).length === 0) plus(m, { ...mk.max, alias: { agents: {}, entreprises: {} } }, label);
  }
  for (const op of await readdir(operationsDir(root)).catch(() => [] as string[])) {
    const b = await readFile(join(operationsDir(root), op, "bilan.json"), "utf8").then((t) => JSON.parse(t) as Bilan, () => null);
    if (b?.resultat === "termine" && b.maxFiable) plus(m, { revision: b.maxFiable.revision, sha256: "", compteurs: b.maxFiable.compteurs, retires: { agents: [], entreprises: [] }, alias: { agents: {}, entreprises: {} } }, `bilan ${op}`);
  }
  if (minimums.revision !== undefined || minimums.e !== undefined || minimums.i !== undefined || minimums.a !== undefined) {
    plus(m, { revision: minimums.revision ?? 0, sha256: "", compteurs: { e: minimums.e ?? 0, i: minimums.i ?? 0, a: minimums.a ?? 0 }, retires: { agents: [], entreprises: [] }, alias: { agents: {}, entreprises: {} } }, "minimums de l'opérateur");
  }
  return m;
}

/* ---------- opération ---------- */

async function ecrireBilan(b: Bilan): Promise<void> {
  if (!b.sauvegarde) return;
  await writeAtomic(join(b.sauvegarde.dossier, "bilan.json"), JSON.stringify(b, null, 2) + "\n");
}

/**
 * Amorçage (enveloppe jamais suivie) ou restauration contrôlée. Reprend une opération interrompue de la même enveloppe.
 * Rend le bilan (avant/après, sauvegarde, maximum fiable, notification) ; lève OperationRefusee sans rien modifier sinon.
 */
export async function operer(type: TypeOperation, o: OperationOpts): Promise<Bilan> {
  const garde = operatorRefusal(o);
  if (garde) throw new OperationRefusee(garde);
  const root = o.root;
  const enCours = await (o.processus ?? (() => hermesEnCours(root)))();
  if (enCours.length) throw new OperationRefusee(`refus : Hermes tourne dans l'enveloppe (pid ${enCours.map((p) => p.pid).join(", ")}) ; arrête ces agents (pause dans Paperclip) puis recommence`);
  const pack = await prendreVerrouPack(root);
  try {
    return await withDirLock(suiviLock(), { waitMs: 0, staleMs: 30_000, busy: `refus : l'état de suivi est en cours d'écriture (${suiviLock()}) ; recommence quand les lectures en cours sont finies` }, () => executer(type, o));
  } catch (e) {
    if (e instanceof OperationRefusee) throw e;
    if (/^refus : /.test((e as Error).message)) throw new OperationRefusee((e as Error).message);
    throw e;
  } finally {
    await rendreVerrouPack(pack);
  }
}

async function executer(type: TypeOperation, o: OperationOpts): Promise<Bilan> {
  const root = o.root;
  let op = await lireEnCours(root);
  if (op) {
    op.reprises += 1;
    if (op.type !== type) throw new OperationRefusee(`refus : une opération « ${op.type} » interrompue est en cours pour cette enveloppe (${op.id}, phase ${op.phase}) ; reprends-la avec la même commande`);
  } else {
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
    const avant = await etatEnveloppe(root);
    op = { schema: 1, id, type, root, operateur: o.operateur, phase: "preparee", marqueur: newToken(), dossier: join(operationsDir(root), id), debut: new Date().toISOString(), reprises: 0, avant, minimums: o.minimums ?? {}, sansReference: !!o.sansReference, sauvegarde: null };
  }
  const bilan = (resultat: Bilan["resultat"], raison: string | null, extra: Partial<Bilan> = {}): Bilan => ({ schema: 1, id: op!.id, type: op!.type, root, operateur: op!.operateur, debut: op!.debut, fin: new Date().toISOString(), resultat, raison, reprises: op!.reprises, avant: op!.avant, apres: null, maxFiable: null, sansReference: op!.sansReference, sauvegarde: op!.sauvegarde, evenement: null, notification: null, ...extra });
  const stop = async (ph: Phase) => {
    if (o.arretApres === ph) throw new Error(`interruption simulée après la phase ${ph}`);
  };
  // 1. en-cours d'abord : à partir d'ici les lecteurs refusent l'enveloppe (etat_suivi_invalide / restauration_en_cours)
  await ecrireEnCours(op);
  const abandon = async (raison: string): Promise<never> => {
    const b = bilan("refuse", raison, { apres: await etatEnveloppe(root) });
    await ecrireBilan(b);
    await rm(inProgressFile(root), { force: true });
    throw new OperationRefusee(raison, b);
  };
  // 2. sauvegarde brute (une seule fois, même après reprise)
  if (op.phase === "preparee") {
    let fichiers: Fichier[];
    try {
      fichiers = await sauvegarder(root, op.dossier);
    } catch (e) {
      await rm(inProgressFile(root), { force: true });
      throw e;
    }
    op.sauvegarde = { dossier: op.dossier, fichiers };
    op.phase = "sauvegardee";
    await ecrireEnCours(op);
    await stop("sauvegardee");
  }
  // 3. préconditions et validation (recalculées à chaque reprise : déterministes, sources sauvegardées comprises)
  const p = await readIdentites({ root });
  if (!p.projection) return abandon(`refus : ${p.error} ; le pack doit d'abord remettre une projection valide`);
  const psha = sha(p.raw ?? "");
  const cur = await readSuiviFile();
  const m = await maxFiable(root, op.minimums);
  if (type === "amorcage" && op.phase === "sauvegardee") {
    const mk = await readMarker(root);
    if (cur.kind === "invalide" && cur.regle !== "ancien_format") return abandon(`refus : état de suivi invalide (${cur.why}) ; l'amorçage ne remplace jamais un état existant : utilise « restaurer »`);
    if (cur.kind === "ok" && cur.value.enveloppes[root]) return abandon("refus : enveloppe déjà amorcée ; pour la ré-ancrer après une restauration voulue, utilise « restaurer »");
    if (mk.kind !== "absent") return abandon(`refus : marqueur d'enveloppe présent (${markerFile(root)}) : l'enveloppe a déjà été suivie, ce n'est pas une première utilisation ; utilise « restaurer »`);
    // suivi ET marqueur supprimés après usage : les autres traces (.prec, sauvegardes, marqueurs sauvegardés, bilans) prouvent
    // que l'enveloppe a déjà été suivie ; seul l'ancien format (repris avec ses maxima) n'en est pas une
    const traces = m.sources.filter((x) => !x.endsWith("(ancien format)") && x !== "minimums de l'opérateur");
    if (traces.length) return abandon(`refus : l'enveloppe a déjà été suivie (traces : ${traces.join(", ")}) : ce n'est pas une première utilisation, aucune remise à zéro ; utilise « restaurer »`);
  }
  if (type === "restauration" && !m.sources.length && !op.sansReference) return abandon("refus : aucune référence fiable (ni suivi lisible, ni .prec, ni sauvegarde, ni bilan) pour cette enveloppe ; donne --revision-min / --compteurs-min relevés ailleurs (projection sauvegardée du pack, journaux), ou --sans-reference (consigné dans le bilan)");
  const ecart = controler(m, p.projection, psha);
  if (ecart) return abandon(`refus : la projection r${p.projection.revision} ne respecte pas le maximum fiable connu (r${m.revision}, compteurs e${m.compteurs.e} i${m.compteurs.i} a${m.compteurs.a}, ${m.retires.agents.length + m.retires.entreprises.length} retiré(s)) : ${ecart.message} ; le pack doit la réécrire à une révision supérieure, compteurs au moins à ce maximum, retirés conservés (sources : ${m.sources.join(", ") || "aucune"})`);
  const maxFiableBilan = { revision: m.revision, compteurs: m.compteurs, retires: m.retires.agents.length + m.retires.entreprises.length, sources: m.sources };
  const nouveau = absorb({ revision: m.revision, sha256: m.sha256, compteurs: { ...m.compteurs }, retires: m.retires, alias: m.alias }, p.projection, psha);
  // 4. marqueur (nouveau jeton) puis suivi : entre les deux, marqueur ≠ suivi → les lecteurs refusent (jamais d'état vide)
  if (op.phase === "sauvegardee") {
    await writeMarker(root, op.marqueur, `${op.type}:${op.operateur}`, nouveau);
    op.phase = "marqueur_ecrit";
    await ecrireEnCours(op);
    await stop("marqueur_ecrit");
  }
  if (op.phase === "marqueur_ecrit") {
    const base: Suivi = cur.kind === "ok" ? (JSON.parse(JSON.stringify(cur.value)) as Suivi) : { schema: SUIVI_SCHEMA, generation: newToken(), enveloppes: {} };
    const prev = base.enveloppes[root];
    const now = new Date().toISOString();
    const entry: EntreeSuivi = {
      ...nouveau,
      marqueur: op.marqueur,
      amorceLe: prev?.amorceLe ?? now,
      amorcePar: prev?.amorcePar ?? `${op.type}:${op.operateur}`,
      vuLe: now,
      restaurations: m.restaurations + (type === "restauration" ? 1 : 0),
    };
    base.enveloppes[root] = entry;
    await writeSuivi(base, cur.kind === "ok");
    op.phase = "suivi_ecrit";
    await ecrireEnCours(op);
    await stop("suivi_ecrit");
  }
  // 5. bilan après, événement de restauration enregistré dans la file (notification en attente : jamais « livrée » sans reçu), fin
  const apres = await etatEnveloppe(root);
  apres.operationEnCours = null;
  let evenement: Evenement | null = null;
  let notification: Bilan["notification"] = null;
  if (type === "restauration") {
    const a = op.avant.entree;
    evenement = { schema: 1, id: `restauration-${op.id}`, type: "restauration", at: new Date().toISOString(), root, operateur: op.operateur, resume: `Restauration contrôlée de l'enveloppe ${root} par ${op.operateur} : projection r${p.projection.revision} acceptée (maximum fiable r${m.revision}), compteurs e${p.projection.compteurs.e} i${p.projection.compteurs.i} a${p.projection.compteurs.a}, ${m.retires.agents.length + m.retires.entreprises.length} identité(s) retirée(s) conservée(s).`, preuve: join(op.dossier, "bilan.json"), avant: a ? { revision: a.revision, compteurs: a.compteurs } : null, apres: { revision: p.projection.revision, compteurs: p.projection.compteurs } };
    try {
      const r = await enfiler(evenement);
      notification = { ecrite: true, erreur: null, perdus: r.perdus.map((x) => x.id) };
    } catch (e) {
      // la restauration est faite et prouvée (bilan) : la notification manquante est visible et rejouable
      notification = { ecrite: false, erreur: (e as NodeJS.ErrnoException).code ?? (e as Error).message, perdus: [] };
    }
  }
  const b = bilan("termine", null, { apres, maxFiable: maxFiableBilan, evenement, notification });
  await ecrireBilan(b);
  await rm(inProgressFile(root), { force: true });
  return b;
}

export const amorcer = (o: OperationOpts) => operer("amorcage", o);
export const restaurer = (o: OperationOpts) => operer("restauration", o);

/** Bilans des opérations d'une enveloppe (les plus récents en dernier). */
export async function historique(root: string): Promise<Bilan[]> {
  const out: Bilan[] = [];
  for (const op of (await readdir(operationsDir(root)).catch(() => [] as string[])).sort()) {
    const b = await readFile(join(operationsDir(root), op, "bilan.json"), "utf8").then((t) => JSON.parse(t) as Bilan, () => null);
    if (b) out.push(b);
  }
  return out;
}
