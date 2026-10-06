// ANNULATION (0.6.2, constat de recette) : Paperclip 2026.1001.0 arrête un passage « legacy » en cherchant le processus
// dans SON registre `runningProcesses` (module @paperclipai/adapter-utils du serveur). Or cet adaptateur, installé hors
// du serveur (dossier ou paquet npm avec ses propres node_modules), lance Hermes par SA copie d'adapter-utils : le serveur
// ne trouve rien, marque le passage « cancelled »… et Hermes continue (constaté en recette : processus et descendants
// toujours vivants). Le serveur offre une voie prévue pour cela (types d'adapter-utils : `signal` + `onCancellationReady`,
// « opt in to signal-based cancellation ») : on s'y inscrit, et sur abandon on arrête le GROUPE de processus que
// runChildProcess a créé (detached → pgid = pid de Hermes), SIGTERM puis SIGKILL après le délai de grâce.

export interface CancellationContext {
  signal?: AbortSignal;
  onCancellationReady?: () => Promise<void>;
  onSpawn?: (meta: { pid: number; processGroupId?: number | null; startedAt?: string }) => Promise<void> | void;
}

export interface CancellationHandle {
  /** onSpawn à transmettre à l'adaptateur de base (retient le processus, puis appelle celui du serveur). */
  onSpawn: (meta: { pid: number; processGroupId?: number | null; startedAt?: string }) => Promise<void>;
  /** Abandon demandé avant le lancement : ne pas lancer Hermes. */
  abortedBeforeStart: () => boolean;
  /** Abandon reçu pendant le passage. */
  aborted: () => boolean;
  dispose: () => void;
}

function killGroup(target: { pid: number; processGroupId: number | null }, signal: NodeJS.Signals): void {
  const id = target.processGroupId && target.processGroupId > 0 ? -target.processGroupId : target.pid;
  try {
    process.kill(id, signal);
  } catch {
    /* déjà terminé */
  }
}

/**
 * Inscription à l'annulation par signal. Sans `signal` ni `onCancellationReady` (ancien serveur, tests), rien ne change :
 * onSpawn est simplement relayé.
 */
export async function armCancellation(ctx: CancellationContext, graceMs: number): Promise<CancellationHandle> {
  let spawned: { pid: number; processGroupId: number | null } | null = null;
  let requested = false;
  let started = false;
  let timer: NodeJS.Timeout | null = null;
  const stop = () => {
    if (!spawned) return;
    killGroup(spawned, "SIGTERM");
    const s = spawned;
    timer = setTimeout(() => killGroup(s, "SIGKILL"), graceMs);
    timer.unref();
  };
  const onAbort = () => {
    requested = true;
    stop();
  };
  const optedIn = !!ctx.signal && typeof ctx.onCancellationReady === "function";
  if (optedIn) {
    if (ctx.signal!.aborted) requested = true;
    else ctx.signal!.addEventListener("abort", onAbort, { once: true });
    await ctx.onCancellationReady!();
    if (ctx.signal!.aborted) requested = true;
  }
  return {
    onSpawn: async (meta) => {
      started = true;
      spawned = { pid: meta.pid, processGroupId: typeof meta.processGroupId === "number" ? meta.processGroupId : null };
      if (requested) stop();
      await ctx.onSpawn?.(meta);
    },
    abortedBeforeStart: () => requested && !started,
    aborted: () => requested,
    dispose: () => {
      ctx.signal?.removeEventListener("abort", onAbort);
      // SIGKILL de secours seulement si le groupe a encore des membres (sinon on ne vise pas un pgid réutilisé plus tard)
      if (timer && spawned) {
        try {
          process.kill(spawned.processGroupId && spawned.processGroupId > 0 ? -spawned.processGroupId : spawned.pid, 0);
        } catch {
          clearTimeout(timer);
        }
      }
    },
  };
}
