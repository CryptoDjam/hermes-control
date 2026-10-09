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

interface Vivante { session: SessionConnexion; child: ChildProcess; sortie: string; minuteur: NodeJS.Timeout; onFin: Array<() => void> }
const sessions = new Map<string, Vivante | { session: SessionConnexion }>();

export function sessionConnexion(instanceHome: string): SessionConnexion | null {
  return sessions.get(instanceHome)?.session ?? null;
}

export function arreterConnexion(instanceHome: string): boolean {
  const v = sessions.get(instanceHome);
  if (!v || !("child" in v) || v.session.etat !== "en_cours") return false;
  v.session.etat = "annule";
  v.session.message = "arrêt demandé depuis Paperclip";
  v.child.kill("SIGTERM");
  return true;
}

/** Attente de la fin d'une session (tests, et `connect-instance` en mode synchrone court). */
export function attendreFin(instanceHome: string, timeoutMs = DELAI_CONNEXION_MS): Promise<SessionConnexion | null> {
  const v = sessions.get(instanceHome);
  if (!v) return Promise.resolve(null);
  if (!("child" in v) || v.session.etat !== "en_cours") return Promise.resolve(v.session);
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
  const vivante: Vivante = { session, child, sortie: "", minuteur: setTimeout(() => {
    if (session.etat === "en_cours") {
      session.etat = "expire";
      session.message = `aucune connexion après ${Math.round((o.timeoutMs ?? DELAI_CONNEXION_MS) / 60_000)} min : processus arrêté`;
      child.kill("SIGTERM");
    }
  }, o.timeoutMs ?? DELAI_CONNEXION_MS), onFin: [] };
  sessions.set(o.instanceHome, vivante);
  log("connexion de l'instance : démarrée", { instance: o.instanceHome, provider, binary: o.exec.path });
  const lire = (d: Buffer) => {
    vivante.sortie = (vivante.sortie + d.toString()).slice(-MAX_SORTIE);
    if (!session.url || !session.code) {
      const inv = lireInvitation(vivante.sortie);
      if (inv) {
        session.url = inv.url;
        session.code = inv.code;
        log("connexion de l'instance : invitation prête (URL et code à ouvrir par l'utilisateur)", { instance: o.instanceHome, url: inv.url });
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
  const terminer = async (code: number | null) => {
    clearTimeout(vivante.minuteur);
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
    log(`connexion de l'instance : ${session.etat}`, { instance: o.instanceHome, provider, exitCode: code, fichierOk: session.fichierOk, message: session.message });
    sessions.set(o.instanceHome, { session });
    for (const f of vivante.onFin) f();
  };
  child.on("error", (e) => {
    session.etat = "echec";
    session.message = `lancement impossible : ${e.message}`;
    void terminer(null);
  });
  child.on("close", (code) => void terminer(code));
  return session;
}

/** Tests : oublie les sessions terminées (jamais une session en cours). */
export function oublierSessions(): void {
  for (const [k, v] of sessions) if (v.session.etat !== "en_cours") sessions.delete(k);
}
