// CLASSE D'ÉCHEC d'un passage Hermes terminé en erreur (0.6.2).
// Paperclip 2026.1001.0 relance en boucle un échec « adapter_failed » (recovery/service.js : transient_infra) et ne bloque
// pour un humain que `configuration_incomplete`. Or une authentification du MODÈLE manquante ou expirée ne se répare pas
// en relançant : il faut se reconnecter. On sépare donc trois classes, d'après la sortie de Hermes v2026.9.24
// (mode `chat -q … -Q`, lu dans le code de Hermes, sans l'exécuter) :
//   - "model_auth"  : aucune connexion stockée, rafraîchissement refusé, fournisseur qui rejette la connexion ou la clé
//                     (auth_codex.py, cli_agent_setup_mixin.py, turn_failure_copy.py _AUTH_COPY) → rendu comme
//                     `configuration_incomplete` (ticket bloqué pour un humain, pas de relance) ;
//   - "transient"   : quota/limite de débit, surcharge, erreur serveur, délai dépassé (turn_failure_copy.py exhausted_copy,
//                     « Codex provider quota exhausted … Credentials are still valid ») → laissé tel quel (réessayable) ;
//   - "unknown"     : le reste → laissé tel quel.
// Le classement transitoire est testé AVANT l'authentification : un message de quota qui dit « credentials are still
// valid » n'est jamais pris pour un défaut de connexion.

export type FailureClass = "model_auth" | "transient" | "unknown";

const TRANSIENT: RegExp[] = [
  /rate-limited every one of \d+ attempts/i,
  /reported it was overloaded on all \d+ attempts/i,
  /returned a server error on all \d+ attempts/i,
  /didn't respond in time on any of \d+ attempts/i,
  /didn't answer after \d+ attempts/i,
  /looks temporarily unavailable/i,
  /provider quota exhausted \(429\)/i,
  /credentials are still valid/i,
];

const MODEL_AUTH: RegExp[] = [
  /No Codex credentials stored/i,
  /Codex auth is missing (access_token|refresh_token)/i,
  /Codex token refresh failed/i,
  /No API key found for provider/i,
  /No inference provider is configured/i,
  /rejected your sign-in, so the model can't be reached/i,
  /rejected your API key, so the model can't be reached/i,
  /to re-authenticate\./i,
];

/** Classe d'un passage terminé (code de sortie non nul, sans dépassement de délai), d'après stdout + stderr de Hermes. */
export function classifyFailure(output: string, run: { exitCode: number | null; timedOut: boolean }): { cls: FailureClass; evidence: string | null } {
  if (run.timedOut) return { cls: "transient", evidence: "délai dépassé" };
  if (run.exitCode === 0) return { cls: "unknown", evidence: null };
  for (const re of TRANSIENT) {
    const m = output.match(re);
    if (m) return { cls: "transient", evidence: m[0] };
  }
  for (const re of MODEL_AUTH) {
    const m = output.match(re);
    if (m) return { cls: "model_auth", evidence: m[0] };
  }
  return { cls: "unknown", evidence: null };
}

/** Garde la fin d'un flux (pour le classement) sans conserver toute la sortie en mémoire. */
export class Tail {
  private buf = "";
  constructor(private readonly max = 16_384) {}
  push(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > this.max) this.buf = this.buf.slice(-this.max);
  }
  text(): string {
    return this.buf;
  }
}
