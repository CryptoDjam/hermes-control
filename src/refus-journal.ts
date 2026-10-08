// Journal local des refus de configuration : <compte>/.config/hermes-control/refus.jsonl (une ligne JSON par refus, sans
// secret). BORNÉ : au-delà de REFUS_MAX_OCTETS, le fichier courant devient refus.jsonl.1 (une seule génération gardée).
// Lecteurs concurrents : ajout en O_APPEND d'une ligne entière (un seul write) ; la rotation est un rename (un lecteur
// qui tient l'ancien fichier ouvert le lit jusqu'au bout). Le journal ne BLOQUE JAMAIS le refus : toute erreur (disque
// plein, permission) ou une écriture plus longue que REFUS_DELAI_MS rend { ok: false } et le refus est rendu quand même.
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { controlDir } from "./paths.js";

export const REFUS_MAX_OCTETS = 256 * 1024;
export const REFUS_LIGNE_MAX = 8 * 1024;
export const REFUS_DELAI_MS = 500;

export function refusJournalFile(): string {
  return join(controlDir(), "refus.jsonl");
}

async function ecrire(entry: Record<string, unknown>): Promise<void> {
  const f = refusJournalFile();
  await mkdir(controlDir(), { recursive: true, mode: 0o700 });
  let line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n";
  if (Buffer.byteLength(line) > REFUS_LIGNE_MAX) line = JSON.stringify({ at: new Date().toISOString(), ...entry, message: "(message tronqué : ligne trop longue)" }).slice(0, REFUS_LIGNE_MAX - 1) + "\n";
  const st = await stat(f).catch(() => null);
  if (st && st.size + Buffer.byteLength(line) > REFUS_MAX_OCTETS) await rename(f, `${f}.1`).catch(() => undefined);
  await appendFile(f, line, { mode: 0o600 });
}

export async function journaliserRefus(entry: Record<string, unknown>, ecrireFn: (e: Record<string, unknown>) => Promise<void> = ecrire): Promise<{ ok: true } | { ok: false; erreur: string }> {
  let timer: NodeJS.Timeout | undefined;
  const delai = new Promise<{ ok: false; erreur: string }>((res) => {
    timer = setTimeout(() => res({ ok: false, erreur: `délai ${REFUS_DELAI_MS} ms dépassé` }), REFUS_DELAI_MS);
    timer.unref();
  });
  const ecrit = ecrireFn(entry).then(
    () => ({ ok: true }) as const,
    (e: unknown) => ({ ok: false, erreur: (e as NodeJS.ErrnoException).code ?? String((e as Error).message ?? e) }) as const,
  );
  try {
    return await Promise.race([ecrit, delai]);
  } finally {
    clearTimeout(timer);
  }
}
