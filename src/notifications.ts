// File locale BORNÉE des événements pour Chef (lue plus tard par le notifier ; aujourd'hui affichée à l'opérateur) :
//   <compte>/.config/hermes-control/notifications/file.jsonl  — événements non acquittés, au plus NOTIF_MAX
//   <compte>/.config/hermes-control/notifications/etat.json   — acquittements et PERTES (bornés)
// Aucun secret : identifiants, révisions, compteurs, chemins de preuve. Écriture sous verrou, atomique (tmp + fsync +
// rename). Un événement qui sort de la file sans acquittement (file pleine, ligne illisible) est inscrit dans les pertes :
// la perte est VISIBLE (etat) et REJOUABLE (rejouer : relit les bilans de restauration, qui restent la preuve).
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "./identites-fraicheur.js";
import { withDirLock } from "./lock.js";
import { controlDir } from "./paths.js";

export const NOTIF_MAX = 100;
const ETAT_MAX = 500;

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
interface EtatFile { schema: 1; acquittes: string[]; pertes: Perte[] }

export function notificationsDir(): string {
  return join(controlDir(), "notifications");
}
export function queueFile(): string {
  return join(notificationsDir(), "file.jsonl");
}
function etatFile(): string {
  return join(notificationsDir(), "etat.json");
}
const lock = () => join(notificationsDir(), "file.lock");

function isEvenement(x: unknown): x is Evenement {
  const e = x as Partial<Evenement>;
  return !!e && typeof e === "object" && e.schema === 1 && typeof e.id === "string" && typeof e.type === "string" && typeof e.at === "string" && typeof e.preuve === "string";
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
    const x = JSON.parse(await readFile(etatFile(), "utf8")) as Partial<EtatFile>;
    if (x && x.schema === 1 && Array.isArray(x.acquittes) && Array.isArray(x.pertes)) return x as EtatFile;
    throw new Error(`${etatFile()} : schéma invalide`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { schema: 1, acquittes: [], pertes: [] };
    throw new Error(`file des notifications : ${etatFile()} illisible ou invalide (${(e as Error).message}) ; rien n'est réécrit`);
  }
}

async function ecrire(events: Evenement[], etat: EtatFile): Promise<void> {
  etat.acquittes = etat.acquittes.slice(-ETAT_MAX);
  etat.pertes = etat.pertes.slice(-ETAT_MAX);
  await writeAtomic(queueFile(), events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""));
  await writeAtomic(etatFile(), JSON.stringify(etat, null, 2) + "\n");
}

const sousVerrou = <T>(fn: () => Promise<T>) => withDirLock(lock(), { waitMs: 5_000, staleMs: 30_000, busy: `file des notifications : verrou tenu trop longtemps (${lock()})` }, fn);

/** Ajoute un événement (sans doublon d'id) ; au-delà de NOTIF_MAX, le plus ancien sort et sa perte est inscrite. */
export async function enfiler(ev: Evenement, max = NOTIF_MAX): Promise<{ ajoute: boolean; perdus: Perte[] }> {
  return sousVerrou(async () => {
    const { events, illisibles } = await lireFile();
    const etat = await lireEtat();
    const now = new Date().toISOString();
    const perdus: Perte[] = [];
    if (illisibles) perdus.push({ id: `illisible-${now}`, type: "inconnu", at: now, perduLe: now, motif: `${illisibles} ligne(s) illisible(s) retirée(s) de la file`, preuve: null });
    const ajoute = !events.some((e) => e.id === ev.id) && !etat.acquittes.includes(ev.id);
    if (ajoute) events.push(ev);
    while (events.length > max) {
      const old = events.shift()!;
      perdus.push({ id: old.id, type: old.type, at: old.at, perduLe: now, motif: `file pleine (${max} événements)`, preuve: old.preuve });
    }
    etat.pertes = [...etat.pertes.filter((p) => p.id !== ev.id), ...perdus];
    await ecrire(events, etat);
    return { ajoute, perdus };
  });
}

/** Le notifier (ou l'opérateur) acquitte un événement livré : il sort de la file. */
export async function acquitter(id: string): Promise<boolean> {
  return sousVerrou(async () => {
    const { events } = await lireFile();
    const etat = await lireEtat();
    const found = events.some((e) => e.id === id);
    if (!found) return false;
    etat.acquittes.push(id);
    await ecrire(events.filter((e) => e.id !== id), etat);
    return true;
  });
}

export async function etatNotifications(): Promise<{ enAttente: Evenement[]; pertes: Perte[]; acquittes: number; illisibles: number }> {
  const { events, illisibles } = await lireFile();
  const etat = await lireEtat();
  return { enAttente: events, pertes: etat.pertes, acquittes: etat.acquittes.length, illisibles };
}

/**
 * Rejoue les notifications perdues ou jamais écrites : chaque bilan de restauration terminé dont l'événement n'est ni
 * dans la file ni acquitté y est remis (la preuve, bilan.json, n'est jamais effacée).
 */
export async function rejouer(): Promise<string[]> {
  const base = join(controlDir(), "restaurations");
  const bilans: Evenement[] = [];
  for (const env of await readdir(base).catch(() => [] as string[])) {
    for (const op of await readdir(join(base, env)).catch(() => [] as string[])) {
      const f = join(base, env, op, "bilan.json");
      const b = await readFile(f, "utf8").then((t) => JSON.parse(t) as { evenement?: unknown; resultat?: string }, () => null);
      if (b?.resultat === "termine" && isEvenement(b.evenement)) bilans.push(b.evenement);
    }
  }
  const { enAttente } = await etatNotifications();
  const etat = await lireEtat();
  const out: string[] = [];
  for (const ev of bilans.sort((a, b) => a.at.localeCompare(b.at))) {
    if (enAttente.some((e) => e.id === ev.id) || etat.acquittes.includes(ev.id)) continue;
    const r = await enfiler(ev);
    if (r.ajoute) out.push(ev.id);
  }
  return out;
}
