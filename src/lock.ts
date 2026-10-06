// Verrou par dossier (mkdir atomique) à BAIL, partagé par la préparation, la table d'affectations et set-telegram.
// Le dossier-verrou contient `owner.json` ({ pid, host, token, startedAt, renewedAt }) : le détenteur renouvelle son bail
// toutes les 5 s pendant l'opération. Reprise d'un verrou seulement si le bail est périmé (renewedAt > staleMs) ET que le
// propriétaire est mort (pid absent) ou hors de cette machine : un propriétaire vivant mais lent n'est jamais dépossédé.
// Libération seulement si le `token` est le nôtre : un ancien détenteur ne supprime jamais le verrou de son successeur.
// Revendication par rename(lock → lock.stale-<pid>) puis rm : deux revendicateurs ne suppriment pas le verrou d'un troisième.
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

export interface LockOptions {
  waitMs: number; // 0 = pas d'attente : erreur immédiate si le verrou est tenu
  staleMs: number; // au-delà de cet âge du bail (renewedAt), le verrou PEUT être repris (si le propriétaire est mort)
  busy: string; // message d'erreur quand le verrou reste tenu
  renewMs?: number; // période de renouvellement du bail (défaut 5 s)
}

export interface LockOwner {
  pid: number;
  host: string;
  token: string;
  startedAt: string;
  renewedAt: string;
}

const RETRY_MS = 25;
const MAX_FAST_RETRIES = 20; // verrou disparu entre mkdir et stat, ou revendication perdue : on réessaie un peu
export const RENEW_MS = 5_000;
const OWNER_FILE = "owner.json";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function ownerFile(lock: string): string {
  return join(lock, OWNER_FILE);
}

/** owner.json du verrou ; null s'il est absent ou illisible (verrou d'un ancien format, ou en cours d'écriture). */
export async function readOwner(lock: string): Promise<LockOwner | null> {
  try {
    const o = JSON.parse(await readFile(ownerFile(lock), "utf8")) as Partial<LockOwner>;
    if (typeof o.pid !== "number" || typeof o.token !== "string" || typeof o.renewedAt !== "string") return null;
    return { pid: o.pid, host: typeof o.host === "string" ? o.host : "", token: o.token, startedAt: typeof o.startedAt === "string" ? o.startedAt : o.renewedAt, renewedAt: o.renewedAt };
  } catch {
    return null;
  }
}

/** Le processus existe-t-il sur cette machine ? (signal 0 ; EPERM = il existe mais n'est pas à nous) */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Le verrou peut-il être repris ? Bail périmé ET (propriétaire mort OU hors machine). Sans owner.json : seulement si le
 * dossier lui-même est plus vieux que staleMs (un détenteur vivant écrit owner.json tout de suite après mkdir).
 */
export async function lockReclaimable(lock: string, staleMs: number, now = Date.now()): Promise<boolean> {
  const owner = await readOwner(lock);
  if (!owner) {
    const st = await stat(lock).catch(() => null);
    return !!st && now - st.mtimeMs > staleMs;
  }
  const renewed = Date.parse(owner.renewedAt);
  if (!Number.isFinite(renewed) || now - renewed <= staleMs) return false;
  if (owner.host && owner.host !== hostname()) return true; // hors machine : on ne peut pas sonder son pid, le bail fait foi
  return !pidAlive(owner.pid);
}

async function writeOwner(lock: string, owner: LockOwner): Promise<void> {
  const tmp = join(lock, `${OWNER_FILE}.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(owner) + "\n");
  await rename(tmp, ownerFile(lock));
}

export async function withDirLock<T>(lock: string, opts: LockOptions, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lock), { recursive: true });
  const deadline = Date.now() + opts.waitMs;
  let fast = 0;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const st = await stat(lock).catch(() => null);
    if (!st) {
      // verrou libéré juste après notre mkdir raté : on réessaie tout de suite (borné)
      if (++fast > MAX_FAST_RETRIES) throw new Error(opts.busy);
      continue;
    }
    if (await lockReclaimable(lock, opts.staleMs)) {
      const claimed = `${lock}.stale-${process.pid}-${randomBytes(3).toString("hex")}`;
      try {
        await rename(lock, claimed); // un seul revendicateur réussit
        await rm(claimed, { recursive: true, force: true });
      } catch {
        /* un autre l'a repris : on reboucle */
      }
      if (++fast > MAX_FAST_RETRIES) throw new Error(opts.busy);
      continue;
    }
    if (Date.now() >= deadline) throw new Error(opts.busy);
    await sleep(RETRY_MS);
  }
  // le verrou est à nous : on écrit le propriétaire, puis on renouvelle le bail pendant l'opération
  const owner: LockOwner = { pid: process.pid, host: hostname(), token: randomBytes(16).toString("hex"), startedAt: new Date().toISOString(), renewedAt: new Date().toISOString() };
  await writeOwner(lock, owner);
  const renew = setInterval(() => {
    owner.renewedAt = new Date().toISOString();
    writeOwner(lock, owner).catch(() => {
      /* verrou repris ou supprimé : la libération vérifiera le jeton */
    });
  }, opts.renewMs ?? RENEW_MS);
  renew.unref();
  try {
    return await fn();
  } finally {
    clearInterval(renew);
    await releaseLock(lock, owner.token);
  }
}

/** Supprime le verrou SEULEMENT s'il porte encore notre jeton (sinon il appartient à un successeur : on n'y touche pas). */
export async function releaseLock(lock: string, token: string): Promise<boolean> {
  const current = await readOwner(lock);
  if (!current || current.token !== token) return false;
  // rename puis rm : si un revendicateur a pris le dossier entre-temps, le rename échoue et on ne supprime rien
  const gone = `${lock}.released-${process.pid}-${randomBytes(3).toString("hex")}`;
  try {
    await rename(lock, gone);
  } catch {
    return false;
  }
  const moved = await readOwner(gone);
  if (!moved || moved.token !== token) {
    // un successeur s'était installé entre la lecture et le rename : on lui rend son verrou
    await rename(gone, lock).catch(() => {});
    return false;
  }
  await rm(gone, { recursive: true, force: true });
  return true;
}
