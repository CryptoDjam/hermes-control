// File locale BORNÉE des événements (lue plus tard par un notifier ; aujourd'hui affichée à l'opérateur) et REÇUS DURABLES
// d'acquittement (revue Codex du 08/10 §5) :
//   <compte>/.config/hermes-control/notifications/file.jsonl     — file ACTIVE : événements sans reçu, au plus NOTIF_MAX
//   <compte>/.config/hermes-control/notifications/recus/<clé>.json — UN reçu par événement, jamais borné ni élagué :
//        id, chemin du bilan conservé et son SHA-256, source (notifier | operateur | migration), ticket éventuel, dates
//   <compte>/.config/hermes-control/notifications/etat.json      — pertes (bornées, affichées) et compteurs NON bornés
//        (débordements, lignes illisibles) ; « acquittesHerites » : acquittements d'une ancienne file (schéma 1), gardés
//        tels quels et convertis en reçus dès que leur événement est revu
// Un événement est « traité » si et seulement si son reçu existe : rejouer() et enfiler() ne consultent plus une liste
// bornée (l'ancienne limite slice(-500) faisait réapparaître le 501e acquittement le plus ancien).
// Livraison (livrer) : le consommateur tient lui-même la relation persistante événement → ticket (trouver puis creer) ;
// le reçu est écrit APRÈS la confirmation du consommateur. Une panne entre les deux laisse l'événement dans la file ; la
// reprise retrouve le ticket existant (aucun second ticket) puis écrit le reçu.
// Aucun secret : identifiants, révisions, compteurs, chemins de preuve. Écritures sous verrou, atomiques (tmp + fsync +
// rename). Le texte affiché est « événement enregistré, notification en attente » tant qu'aucun reçu n'existe : jamais
// « Chef informé » sans preuve de livraison.
import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { writeAtomic } from "./identites-fraicheur.js";
import { withDirLock } from "./lock.js";
import { controlDir } from "./paths.js";

export const NOTIF_MAX = 100;
const PERTES_MAX = 500;

export interface Evenement {
  schema: 1;
  id: string;
  type: "restauration";
  at: string;
  root: string;
  operateur: string;
  resume: string;
  preuve: string; // bilan.json de l'opération (reste sur disque même si la notification est perdue)
  avant: { revision: number; compteurs: { e: number; i: number; a: number } } | null;
  apres: { revision: number; compteurs: { e: number; i: number; a: number } } | null;
}
export interface Perte { id: string; type: string; at: string; perduLe: string; motif: string; preuve: string | null }
export interface Ticket { consommateur: string; ref: string }
export interface Recu {
  schema: 1;
  id: string;
  type: string;
  source: "notifier" | "operateur" | "migration";
  bilan: string;
  bilanSha256: string | null; // null : bilan absent au moment du reçu (signalé, jamais inventé)
  ticket: Ticket | null;
  livreLe: string | null;
  recuLe: string;
}
interface EtatFile { schema: 2; pertes: Perte[]; debordements: number; illisibles: number; acquittesHerites: string[] }

/** Consommateur (futur notifier) : relation PERSISTANTE événement → ticket, de son côté. */
export interface Consommateur {
  nom: string;
  /** Ticket déjà créé pour cet événement (relation persistante), ou null. */
  trouver(id: string): Promise<Ticket | null>;
  /** Crée le ticket ET persiste la relation avant de rendre : le retour vaut confirmation de livraison. */
  creer(ev: Evenement): Promise<Ticket>;
}

export function notificationsDir(): string {
  return join(controlDir(), "notifications");
}
export function queueFile(): string {
  return join(notificationsDir(), "file.jsonl");
}
export function recusDir(): string {
  return join(notificationsDir(), "recus");
}
function etatFile(): string {
  return join(notificationsDir(), "etat.json");
}
const lock = () => join(notificationsDir(), "file.lock");
const lockLivraison = () => join(notificationsDir(), "livraison.lock");

/** Clé de fichier sûre pour un id : l'id lui-même s'il est simple, sinon son empreinte. */
export function cleId(id: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/.test(id) ? id : `h-${createHash("sha256").update(id).digest("hex")}`;
}
export function recuFile(id: string): string {
  return join(recusDir(), `${cleId(id)}.json`);
}

function isEvenement(x: unknown): x is Evenement {
  const e = x as Partial<Evenement>;
  return !!e && typeof e === "object" && e.schema === 1 && typeof e.id === "string" && e.id.length > 0 && typeof e.type === "string" && typeof e.at === "string" && typeof e.preuve === "string";
}

/** La preuve d'un événement doit être un bilan.json conservé sous <compte>/.config/hermes-control/restaurations/. */
export function preuveValide(preuve: string): boolean {
  const base = resolve(controlDir(), "restaurations") + sep;
  const p = resolve(preuve);
  return p === preuve && p.startsWith(base) && basename(p) === "bilan.json";
}

async function lireFile(): Promise<{ events: Evenement[]; illisibles: number }> {
  let txt = "";
  try {
    txt = await readFile(queueFile(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const events: Evenement[] = [];
  let illisibles = 0;
  for (const line of txt.split("\n")) {
    if (!line.trim()) continue;
    try {
      const x = JSON.parse(line);
      if (isEvenement(x)) events.push(x);
      else illisibles++;
    } catch {
      illisibles++;
    }
  }
  return { events, illisibles };
}

async function lireEtat(): Promise<EtatFile> {
  try {
    const x = JSON.parse(await readFile(etatFile(), "utf8")) as Record<string, unknown>;
    if (x && x["schema"] === 2 && Array.isArray(x["pertes"]) && typeof x["debordements"] === "number" && typeof x["illisibles"] === "number" && Array.isArray(x["acquittesHerites"])) return x as unknown as EtatFile;
    // ancienne file (schéma 1) : ses acquittements gardent leur effet (convertis en reçus quand l'événement est revu)
    if (x && x["schema"] === 1 && Array.isArray(x["acquittes"]) && Array.isArray(x["pertes"])) return { schema: 2, pertes: x["pertes"] as Perte[], debordements: 0, illisibles: 0, acquittesHerites: (x["acquittes"] as unknown[]).filter((a): a is string => typeof a === "string") };
    throw new Error(`${etatFile()} : schéma invalide`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { schema: 2, pertes: [], debordements: 0, illisibles: 0, acquittesHerites: [] };
    throw new Error(`file des notifications : ${etatFile()} illisible ou invalide (${(e as Error).message}) ; rien n'est réécrit`);
  }
}

async function ecrire(events: Evenement[], etat: EtatFile): Promise<void> {
  etat.pertes = etat.pertes.slice(-PERTES_MAX);
  await writeAtomic(queueFile(), events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""));
  await writeAtomic(etatFile(), JSON.stringify(etat, null, 2) + "\n");
}

/** Reçu de cet événement, ou null (absent ou illisible : l'événement reste à traiter ; la relation du consommateur évite tout second ticket). */
export async function lireRecu(id: string): Promise<Recu | null> {
  try {
    const r = JSON.parse(await readFile(recuFile(id), "utf8")) as Partial<Recu>;
    return r && r.schema === 1 && r.id === id ? (r as Recu) : null;
  } catch {
    return null;
  }
}

async function sha256Fichier(f: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(f)).digest("hex");
  } catch {
    return null;
  }
}

/** Écrit le reçu (sous le verrou de la file, appelé seulement après confirmation). Un reçu existant n'est jamais remplacé. */
async function ecrireRecu(ev: Pick<Evenement, "id" | "type" | "preuve">, source: Recu["source"], ticket: Ticket | null, livreLe: string | null): Promise<Recu> {
  const deja = await lireRecu(ev.id);
  if (deja) return deja;
  const r: Recu = { schema: 1, id: ev.id, type: ev.type, source, bilan: ev.preuve, bilanSha256: await sha256Fichier(ev.preuve), ticket, livreLe, recuLe: new Date().toISOString() };
  await writeAtomic(recuFile(ev.id), JSON.stringify(r, null, 2) + "\n");
  return r;
}

/** Vrai si l'événement est déjà traité (reçu, ou acquittement hérité converti ici en reçu « migration »). */
async function traite(ev: Evenement, etat: EtatFile): Promise<boolean> {
  if (await lireRecu(ev.id)) return true;
  const k = etat.acquittesHerites.indexOf(ev.id);
  if (k < 0) return false;
  await ecrireRecu(ev, "migration", null, null);
  etat.acquittesHerites.splice(k, 1);
  return true;
}

const sousVerrou = <T>(fn: () => Promise<T>) => withDirLock(lock(), { waitMs: 5_000, staleMs: 30_000, busy: `file des notifications : verrou tenu trop longtemps (${lock()})` }, fn);

/**
 * Enregistre un événement (sans doublon d'id, jamais un événement déjà reçu) ; au-delà de `max`, le plus ancien sort de la
 * file ACTIVE : sa perte est inscrite et comptée (débordement visible) ; il reste rejouable depuis son bilan tant qu'il
 * n'a pas de reçu.
 */
export async function enfiler(ev: Evenement, max = NOTIF_MAX): Promise<{ ajoute: boolean; perdus: Perte[] }> {
  if (!isEvenement(ev)) throw new Error("événement invalide ; rien n'est écrit");
  if (!preuveValide(ev.preuve)) throw new Error(`événement ${ev.id} : preuve hors du dossier des bilans (${ev.preuve}) ; rien n'est écrit`);
  return sousVerrou(async () => {
    const { events: lus, illisibles } = await lireFile();
    const etat = await lireEtat();
    const now = new Date().toISOString();
    const perdus: Perte[] = [];
    if (illisibles) {
      etat.illisibles += illisibles;
      perdus.push({ id: `illisible-${now}`, type: "inconnu", at: now, perduLe: now, motif: `${illisibles} ligne(s) illisible(s) retirée(s) de la file`, preuve: null });
    }
    const events: Evenement[] = [];
    for (const e of lus) if (!(await lireRecu(e.id))) events.push(e); // un reçu écrit avant une panne retire l'entrée
    const ajoute = !events.some((e) => e.id === ev.id) && !(await traite(ev, etat));
    if (ajoute) events.push(ev);
    while (events.length > max) {
      const old = events.shift()!;
      etat.debordements++;
      perdus.push({ id: old.id, type: old.type, at: old.at, perduLe: now, motif: `file pleine (${max} événements) : rejouable depuis son bilan`, preuve: old.preuve });
    }
    etat.pertes = [...etat.pertes.filter((p) => p.id !== ev.id), ...perdus];
    await ecrire(events, etat);
    return { ajoute, perdus };
  });
}

/** L'opérateur acquitte un événement de la file : reçu « operateur » écrit, puis l'événement sort de la file. */
export async function acquitter(id: string): Promise<boolean> {
  return sousVerrou(async () => {
    const { events } = await lireFile();
    const etat = await lireEtat();
    const ev = events.find((e) => e.id === id);
    if (!ev) return false;
    await ecrireRecu(ev, "operateur", null, null);
    await ecrire(events.filter((e) => e.id !== id), etat);
    return true;
  });
}

export interface ResultatLivraison {
  livres: { id: string; ticket: Ticket; repris: boolean }[];
  echecs: { id: string; erreur: string }[];
}

/**
 * Livre la file au consommateur : pour chaque événement sans reçu, ticket existant (trouver) sinon création (creer) ;
 * APRÈS la confirmation, reçu écrit puis sortie de la file. Un échec laisse l'événement en file (rejouable).
 * `avantRecu` : point d'injection de panne pour les essais (entre confirmation et reçu).
 */
export async function livrer(c: Consommateur, opts: { avantRecu?: (ev: Evenement, t: Ticket) => Promise<void> } = {}): Promise<ResultatLivraison> {
  await mkdir(notificationsDir(), { recursive: true, mode: 0o700 });
  return withDirLock(lockLivraison(), { waitMs: 5_000, staleMs: 120_000, busy: `livraison des notifications déjà en cours (${lockLivraison()})` }, async () => {
    const out: ResultatLivraison = { livres: [], echecs: [] };
    const { events } = await lireFile();
    for (const ev of events) {
      if (await lireRecu(ev.id)) continue;
      let ticket: Ticket;
      let repris = false;
      try {
        const t = await c.trouver(ev.id);
        repris = !!t;
        ticket = t ?? (await c.creer(ev));
      } catch (e) {
        out.echecs.push({ id: ev.id, erreur: (e as Error).message });
        continue;
      }
      if (opts.avantRecu) await opts.avantRecu(ev, ticket);
      const livreLe = new Date().toISOString();
      await sousVerrou(async () => {
        await ecrireRecu(ev, "notifier", ticket, livreLe);
        const cur = await lireFile();
        const etat = await lireEtat();
        await ecrire(cur.events.filter((e) => e.id !== ev.id), etat);
      });
      out.livres.push({ id: ev.id, ticket, repris });
    }
    return out;
  });
}

/** Consommateur de référence : un fichier par ticket (tickets/<clé>.json), créé de façon exclusive et atomique. */
export class ConsommateurFichier implements Consommateur {
  readonly nom: string;
  constructor(readonly dossier: string, nom = "fichier") {
    this.nom = nom;
  }
  private fichier(id: string): string {
    return join(this.dossier, `${cleId(id)}.json`);
  }
  async trouver(id: string): Promise<Ticket | null> {
    try {
      const x = JSON.parse(await readFile(this.fichier(id), "utf8")) as { id?: string; ref?: string };
      if (x.id !== id || typeof x.ref !== "string") throw new Error(`ticket ${this.fichier(id)} incohérent ; aucune création`);
      return { consommateur: this.nom, ref: x.ref };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async creer(ev: Evenement): Promise<Ticket> {
    await mkdir(this.dossier, { recursive: true, mode: 0o700 });
    const ref = `ticket-${randomBytes(6).toString("hex")}`;
    const f = this.fichier(ev.id);
    const tmp = `${f}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const fh = await open(tmp, "wx", 0o600);
    try {
      await fh.writeFile(JSON.stringify({ id: ev.id, ref, type: ev.type, resume: ev.resume, preuve: ev.preuve, creeLe: new Date().toISOString() }) + "\n");
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await link(tmp, f); // exclusif : si un ticket existe déjà pour cet id, on le garde
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const t = await this.trouver(ev.id);
      if (!t) throw e;
      return t;
    } finally {
      await rm(tmp, { force: true });
    }
    return { consommateur: this.nom, ref };
  }
}

async function compterRecus(): Promise<number> {
  return (await readdir(recusDir()).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).length;
}

export async function etatNotifications(): Promise<{ enAttente: Evenement[]; pertes: Perte[]; recus: number; acquittes: number; debordements: number; illisibles: number }> {
  const { events, illisibles } = await lireFile();
  const etat = await lireEtat();
  const enAttente: Evenement[] = [];
  for (const e of events) if (!(await lireRecu(e.id))) enAttente.push(e);
  const recus = await compterRecus();
  return { enAttente, pertes: etat.pertes, recus, acquittes: recus + etat.acquittesHerites.length, debordements: etat.debordements, illisibles: illisibles + etat.illisibles };
}

/**
 * Rejoue : chaque bilan de restauration terminé dont l'événement n'a ni reçu ni place dans la file y est remis (la
 * preuve, bilan.json, n'est jamais effacée). Les reçus ne sont jamais élagués : aucun événement traité ne réapparaît.
 */
export async function rejouer(): Promise<string[]> {
  const base = join(controlDir(), "restaurations");
  const bilans: Evenement[] = [];
  for (const env of await readdir(base).catch(() => [] as string[])) {
    for (const op of await readdir(join(base, env)).catch(() => [] as string[])) {
      const f = join(base, env, op, "bilan.json");
      const b = await readFile(f, "utf8").then((t) => JSON.parse(t) as { evenement?: unknown; resultat?: string }, () => null);
      if (b?.resultat === "termine" && isEvenement(b.evenement) && preuveValide(b.evenement.preuve)) bilans.push(b.evenement);
    }
  }
  const { events } = await lireFile();
  const out: string[] = [];
  for (const ev of bilans.sort((a, b) => a.at.localeCompare(b.at))) {
    if (events.some((e) => e.id === ev.id) || (await lireRecu(ev.id))) continue;
    const r = await enfiler(ev);
    if (r.ajoute) out.push(ev.id);
  }
  return out;
}
