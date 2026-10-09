// Connexion d'une INSTANCE Hermes au modèle par ABONNEMENT ChatGPT (fournisseur `openai-codex`, OAuth « device code ») —
// bouton « Connecter » de la page Hermes de Paperclip (décision de Cyril M du 09/10 au soir : pas de clé API).
//   - commande : `<binaire administré> auth add openai-codex --type oauth --label <instance>` sous HERMES_HOME = racine de
//     l'instance (Hermes v2026.9.24, hermes_cli/subcommands/auth.py ; flux par défaut = device code : aucune console, aucun
//     navigateur, aucune lecture de stdin — un simple processus enfant suffit, pas de pseudo-terminal) ;
//   - sortie attendue (auth_codex.py:1071-1076, ANSI bleu autour de l'URL et du code) :
//       1. Open this URL in your browser:  https://auth.openai.com/codex/device
//       2. Enter this code:  <CODE>
//       Waiting for sign-in... (press Ctrl+C to cancel)
//     puis `Added openai-codex OAuth credential #n: "<label>"` (code 0) ou, sur stderr, `Login failed: …` (code 1) ; délai
//     de 15 min côté Hermes (auth_codex.py:991), 16 min ici ;
//   - résultat : `<instance>/auth.json` (mode 600, credential_pool.openai-codex[…]) ; les profils de l'instance l'utilisent
//     par repli lecture seule (auth.py:494-503) : UNE connexion par instance, jamais copiée dans les profils ;
//   - rien de secret ne sort d'ici : l'URL et le code à saisir sont destinés à l'utilisateur (ce ne sont pas des jetons) ;
//     la sortie brute n'est jamais journalisée, seuls des états et des messages fixes le sont.
import { type ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type HermesExec, hermesCallEnv } from "./hermes.js";

export const PROVIDER_ABONNEMENT = "openai-codex";
export const URL_DEVICE = "https://auth.openai.com/codex/device";
/** 15 min côté Hermes (`Login timed out after 15 minutes.`) + marge. */
export const DELAI_CONNEXION_MS = 16 * 60_000;
const MAX_SORTIE = 64 * 1024;

export type EtatConnexion = "en_cours" | "reussi" | "echec" | "annule" | "expire";

export interface SessionConnexion {
  instanceHome: string; // racine canonique
  provider: string;
  etat: EtatConnexion;
  url: string | null;
  code: string | null;
  label: string | null;
  debut: string;
  fin: string | null;
  /** message fixe ou ligne d'échec de Hermes (jamais la sortie brute entière) */
  message: string | null;
  exitCode: number | null;
  /** auth.json de l'instance porte des identifiants du fournisseur après le succès (vérifié, jamais lu au-delà des noms de champs) */
  fichierOk: boolean | null;
}

export interface Spawner {
  (path: string, args: string[], opts: { env: Record<string, string>; cwd: string }): ChildProcess;
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
export function sansAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** URL et code à saisir, dès qu'ils sont dans la sortie (après ANSI) ; null tant que l'invitation n'est pas complète. */
export function lireInvitation(sortie: string): { url: string; code: string } | null {
  const t = sansAnsi(sortie);
  const url = /(https:\/\/auth\.openai\.com\/\S+)/.exec(t)?.[1] ?? null;
  const m = /Enter this code:\s*\n?\s*([A-Z0-9][A-Z0-9-]{3,})/i.exec(t);
  const code = m?.[1]?.trim() ?? null;
  return url && code ? { url, code } : null;
}

/** Fin lue dans la sortie : succès (ligne « Added … credential ») ou échec (« Login failed: … », « Login cancelled. »). */
export function lireFin(sortie: string): { etat: "reussi"; label: string | null } | { etat: "echec" | "annule"; message: string } | null {
  const t = sansAnsi(sortie);
  const ok = /Added \S+ OAuth credential #\d+(?::\s*"([^"\n]*)")?/.exec(t);
  if (ok) return { etat: "reussi", label: ok[1] ?? null };
  const ko = /Login failed:\s*([^\n]*)/.exec(t);
  if (ko) return { etat: "echec", message: `Login failed: ${ko[1]!.trim()}` };
  if (/Login cancelled\./.test(t)) return { etat: "annule", message: "Login cancelled." };
  return null;
}

/** `<instance>/auth.json` porte au moins un identifiant du fournisseur (noms de champs seulement, aucune valeur retenue). */
export async function fichierAuthPorte(instanceHome: string, provider = PROVIDER_ABONNEMENT): Promise<boolean> {
  try {
    const j = JSON.parse(await readFile(join(instanceHome, "auth.json"), "utf8")) as { credential_pool?: Record<string, unknown[]>; providers?: Record<string, { tokens?: unknown }> };
    const pool = j.credential_pool?.[provider];
    if (Array.isArray(pool) && pool.length) return true;
    return !!j.providers?.[provider]?.tokens;
  } catch {
    return false;
  }
}

/** Délai borné entre SIGTERM et SIGKILL quand l'enfant ne se termine pas de lui-même (annulation, délai, arrêt du worker). */
export const DELAI_ARRET_FORCE_MS = 5_000;

/**
 * Une TENTATIVE : identité propre (`id`, jamais réutilisée) ; la map `sessions` pointe vers la tentative COURANTE de l'instance.
 * Correction Codex 09/10 (course annulation/reconnexion) : l'état n'est écrit dans la map que si la tentative est encore la
 * courante ; la fin est idempotente (`error` puis `close` peuvent arriver tous les deux) ; un arrêt demandé est forcé (SIGKILL)
 * après DELAI_ARRET_FORCE_MS ; la place d'une tentative arrêtée n'est libérée (retirée de `enArret`) qu'à la fermeture effective.
 */
interface Vivante { id: number; session: SessionConnexion; child: ChildProcess; sortie: string; minuteur: NodeJS.Timeout; arretForce: NodeJS.Timeout | null; finie: boolean; onFin: Array<() => void> }
const sessions = new Map<string, Vivante | { id: number; session: SessionConnexion }>();
/** Tentatives dont l'arrêt est demandé et dont l'enfant n'est pas encore fermé (place libérée à la fermeture effective). */
const enArret = new Set<Vivante>();
let prochaineTentative = 0;

export function sessionConnexion(instanceHome: string): SessionConnexion | null {
  return sessions.get(instanceHome)?.session ?? null;
}

/** Tentatives arrêtées dont l'enfant tourne encore (tests, diagnostic). */
export function arretsEnCours(): number {
  return enArret.size;
}

function forcerArret(v: Vivante): void {
  if (v.finie) return;
  enArret.add(v);
  v.child.kill("SIGTERM");
  if (!v.arretForce) {
    v.arretForce = setTimeout(() => {
      if (!v.finie) v.child.kill("SIGKILL");
    }, DELAI_ARRET_FORCE_MS);
    v.arretForce.unref?.();
  }
}

export function arreterConnexion(instanceHome: string): boolean {
  const v = sessions.get(instanceHome);
  if (!v || !("child" in v) || v.session.etat !== "en_cours") return false;
  v.session.etat = "annule";
  v.session.message = "arrêt demandé depuis Paperclip";
  forcerArret(v);
  return true;
}

/** Arrêt du worker : toute tentative encore en cours est annulée (SIGTERM puis SIGKILL borné) ; attend les fermetures effectives (bornées). */
export async function arreterToutesConnexions(timeoutMs = DELAI_ARRET_FORCE_MS + 1_000): Promise<void> {
  const attentes: Promise<unknown>[] = [];
  for (const [home, v] of sessions) {
    if (!("child" in v)) continue;
    if (v.session.etat === "en_cours") {
      v.session.etat = "annule";
      v.session.message = "arrêt du worker Hermes Control";
    }
    forcerArret(v);
    attentes.push(attendreFin(home, timeoutMs));
  }
  for (const v of enArret) if (!v.finie) attentes.push(new Promise<void>((res) => { const t = setTimeout(res, timeoutMs); v.onFin.push(() => { clearTimeout(t); res(); }); }));
  await Promise.all(attentes);
}

/** Attente de la fin de la tentative courante d'une instance (tests, et `connect-instance` en mode synchrone court). */
export function attendreFin(instanceHome: string, timeoutMs = DELAI_CONNEXION_MS): Promise<SessionConnexion | null> {
  const v = sessions.get(instanceHome);
  if (!v) return Promise.resolve(null);
  if (!("child" in v)) return Promise.resolve(v.session); // terminée (map réécrite à la fin effective)
  // tentative vivante (en cours, arrêt demandé ou fin en train de s'écrire) : attendre sa fin effective
  return new Promise((res) => {
    const t = setTimeout(() => res(v.session), timeoutMs);
    v.onFin.push(() => {
      clearTimeout(t);
      res(v.session);
    });
  });
}

/** Attente de l'invitation (URL + code) ou de la fin, bornée (l'action « Connecter » rend l'invitation à l'interface). */
export async function attendreInvitation(instanceHome: string, timeoutMs = 30_000): Promise<SessionConnexion | null> {
  const debut = Date.now();
  for (;;) {
    const s = sessionConnexion(instanceHome);
    if (!s || s.etat !== "en_cours" || (s.url && s.code)) return s;
    if (Date.now() - debut > timeoutMs) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
}

export interface DemarrerOptions {
  instanceHome: string; // racine canonique (realpath), vérifiée par l'appelant
  exec: HermesExec; // binaire administré vérifié
  label?: string;
  provider?: string;
  timeoutMs?: number;
  spawnFn?: Spawner;
  /** journal (états et messages fixes seulement : jamais la sortie brute, jamais le code) */
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * Démarre la connexion de l'instance (une seule à la fois par instance : une session en cours est rendue telle quelle).
 * Le processus tourne jusqu'à la connexion de l'utilisateur dans son navigateur, l'échec, l'arrêt ou le délai.
 * Une tentative annulée dont l'enfant n'est pas encore fermé n'empêche pas la suivante : elle est suivie dans `enArret`
 * et sa fermeture n'écrit plus rien dans la map (sa tentative n'est plus la courante).
 */
export function demarrerConnexion(o: DemarrerOptions): SessionConnexion {
  const existante = sessions.get(o.instanceHome);
  if (existante && existante.session.etat === "en_cours") return existante.session;
  const provider = o.provider ?? PROVIDER_ABONNEMENT;
  if (!/^[a-z0-9-]{1,40}$/.test(provider)) throw new Error(`fournisseur invalide : ${provider}`);
  const label = o.label ?? o.instanceHome.split("/").filter(Boolean).pop() ?? "instance";
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(label)) throw new Error(`libellé invalide : ${label}`);
  const session: SessionConnexion = { instanceHome: o.instanceHome, provider, etat: "en_cours", url: null, code: null, label: null, debut: new Date().toISOString(), fin: null, message: null, exitCode: null, fichierOk: null };
  const spawnFn: Spawner = o.spawnFn ?? ((p, a, opts) => spawn(p, a, { ...opts, stdio: ["ignore", "pipe", "pipe"] }));
  const log = o.log ?? (() => undefined);
  const args = ["auth", "add", provider, "--type", "oauth", "--label", label];
  const child = spawnFn(o.exec.path, args, { env: hermesCallEnv(o.instanceHome, o.exec), cwd: o.instanceHome });
  const id = ++prochaineTentative;
  const vivante: Vivante = { id, session, child, sortie: "", arretForce: null, finie: false, onFin: [], minuteur: setTimeout(() => {
    if (session.etat === "en_cours") {
      session.etat = "expire";
      session.message = `aucune connexion après ${Math.round((o.timeoutMs ?? DELAI_CONNEXION_MS) / 60_000)} min : processus arrêté`;
      forcerArret(vivante);
    }
  }, o.timeoutMs ?? DELAI_CONNEXION_MS) };
  sessions.set(o.instanceHome, vivante);
  log("connexion de l'instance : démarrée", { instance: o.instanceHome, provider, binary: o.exec.path, tentative: id });
  const courante = () => sessions.get(o.instanceHome)?.id === id;
  const lire = (d: Buffer) => {
    if (vivante.finie) return;
    vivante.sortie = (vivante.sortie + d.toString()).slice(-MAX_SORTIE);
    if (!session.url || !session.code) {
      const inv = lireInvitation(vivante.sortie);
      if (inv) {
        session.url = inv.url;
        session.code = inv.code;
        log("connexion de l'instance : invitation prête (URL et code à ouvrir par l'utilisateur)", { instance: o.instanceHome, url: inv.url, tentative: id });
      }
    }
    const fin = lireFin(vivante.sortie);
    if (fin && session.etat === "en_cours") {
      if (fin.etat === "reussi") session.label = fin.label;
      else session.message = fin.message;
    }
  };
  child.stdout?.on("data", lire);
  child.stderr?.on("data", lire);
  // Fin IDEMPOTENTE : `error` et `close` peuvent arriver tous les deux ; la première passe décide, les suivantes ne font rien.
  const terminer = async (code: number | null) => {
    if (vivante.finie) return;
    vivante.finie = true;
    enArret.delete(vivante); // place libérée à l'arrêt EFFECTIF seulement (l'enfant est fermé)
    clearTimeout(vivante.minuteur);
    if (vivante.arretForce) clearTimeout(vivante.arretForce);
    session.exitCode = code;
    session.fin = new Date().toISOString();
    const fin = lireFin(vivante.sortie);
    if (session.etat === "en_cours") {
      if (code === 0 && fin?.etat === "reussi") session.etat = "reussi";
      else if (fin && fin.etat !== "reussi") {
        session.etat = fin.etat;
        session.message = fin.message;
      } else {
        session.etat = "echec";
        session.message = code === 0 ? "le processus s'est terminé sans la ligne « Added … credential »" : `code de sortie ${code ?? "inconnu"}`;
      }
    }
    // la preuve durable : auth.json de l'instance (un « Added » sans fichier serait un faux succès — auth.py / credential_pool)
    session.fichierOk = await fichierAuthPorte(o.instanceHome, provider);
    if (session.etat === "reussi" && !session.fichierOk) {
      session.etat = "echec";
      session.message = `Hermes a annoncé la connexion mais ${join(o.instanceHome, "auth.json")} ne porte aucun identifiant ${provider} : non connecté`;
    }
    vivante.sortie = ""; // rien de la sortie brute n'est conservé
    const remplacee = !courante();
    log(`connexion de l'instance : ${session.etat}`, { instance: o.instanceHome, provider, exitCode: code, fichierOk: session.fichierOk, message: session.message, tentative: id, remplacee });
    // l'état n'est écrit dans la map que si cette tentative est toujours la courante : une tentative plus récente n'est jamais écrasée
    if (!remplacee) sessions.set(o.instanceHome, { id, session });
    for (const f of vivante.onFin) f();
  };
  child.on("error", (e) => {
    if (vivante.finie) return;
    session.etat = "echec";
    session.message = `lancement impossible : ${e.message}`;
    void terminer(null);
  });
  child.on("close", (code) => void terminer(code));
  return session;
}

/** Tests : oublie les sessions terminées (jamais une session en cours ni un arrêt non effectif). */
export function oublierSessions(): void {
  for (const [k, v] of sessions) if (v.session.etat !== "en_cours" && !("child" in v && !v.finie)) sessions.delete(k);
}
