// Verrou par dossier (mkdir atomique), partagé par la préparation, agents.json et set-telegram.
// Un verrou périmé (processus mort) est revendiqué par rename(lock → lock.stale-<pid>) puis rm : jamais de rm direct,
// pour que deux revendicateurs ne suppriment pas le verrou qu'un troisième vient de reprendre.
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

export interface LockOptions {
  waitMs: number; // 0 = pas d'attente : erreur immédiate si le verrou est tenu
  staleMs: number; // au-delà de cet âge, le verrou est revendiqué
  busy: string; // message d'erreur quand le verrou reste tenu
}

const RETRY_MS = 25;
const MAX_FAST_RETRIES = 20; // verrou disparu entre mkdir et stat, ou revendication perdue : on réessaie un peu
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    if (Date.now() - st.mtimeMs > opts.staleMs) {
      const claimed = `${lock}.stale-${process.pid}`;
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
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
