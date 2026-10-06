// LA RÉFÉRENCE de Hermes Control (0.6.1) : un seul dossier, commun au plugin (worker) et à l'adaptateur (serveur Paperclip),
//   <dossier du compte Unix>/.config/hermes-control/
// où « dossier du compte » = celui que donne la base des comptes du système (getpwuid : os.userInfo().homedir) pour l'uid
// qui exécute Paperclip — JAMAIS $HOME ni une variable HERMES_CONTROL_* : Paperclip filtre l'environnement du worker
// (ni HOME ni variables du service), alors que l'adaptateur tourne dans le serveur avec tout l'environnement du service ;
// lire des variables ferait lire deux fichiers différents aux deux composants. Le worker et le serveur tournent sous le même
// uid : ils calculent le même dossier par construction.
// Les anciennes variables (HERMES_CONTROL_ASSIGNMENTS, _AGENTS_MAP, _ROOTS, _WORKSPACE, _HERMES_BIN) ne sont plus lues ; si
// l'une d'elles est encore posée, c'est qu'un administrateur attend une autre référence : on REFUSE (legacyEnvRefusal),
// on ne retombe pas en silence sur le dossier du compte.
import { userInfo } from "node:os";
import { join } from "node:path";

export const LEGACY_ENV = ["HERMES_CONTROL_ASSIGNMENTS", "HERMES_CONTROL_AGENTS_MAP", "HERMES_CONTROL_ROOTS", "HERMES_CONTROL_WORKSPACE", "HERMES_CONTROL_HERMES_BIN"] as const;

type Resolver = () => string;
let testResolver: Resolver | null = null;

/**
 * Réservé aux tests (vitest.setup.ts) : remplace la lecture de la base des comptes par un dossier temporaire.
 * Le résolveur de test refuse lui-même de rendre le vrai dossier du compte.
 */
export function setAccountHomeResolverForTests(r: Resolver | null): void {
  testResolver = r;
}

/** Dossier du compte Unix courant selon la base des comptes (getpwuid) ; jamais $HOME. */
export function accountHome(): string {
  if (testResolver) return testResolver();
  const h = userInfo().homedir;
  if (!h) throw new Error("Hermes Control : le compte Unix courant n'a pas de dossier personnel (getpwuid) ; référence introuvable");
  return h;
}

/** Ancien nom, même sens : le dossier du compte (plus jamais $HOME). */
export const userHome = accountHome;

/** Le dossier de référence : assignments.json (la table), roots, workspace, agents.json (projection). */
export function controlDir(): string {
  return join(accountHome(), ".config", "hermes-control");
}

/** Variables héritées encore posées dans l'environnement de ce processus (noms seulement). */
export function legacyEnvPresent(env: NodeJS.ProcessEnv = process.env): string[] {
  return LEGACY_ENV.filter((k) => typeof env[k] === "string" && env[k]!.trim() !== "");
}

/** Refus explicite si une ancienne variable désigne une autre référence ; null sinon. */
export function legacyEnvRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  const present = legacyEnvPresent(env);
  if (!present.length) return null;
  return `${present.join(", ")} posée(s) dans l'environnement du service : ces variables ne sont plus lues depuis Hermes Control 0.6.1 (le worker du plugin ne les reçoit pas, plugin et adaptateur liraient deux références différentes). La référence unique est ${controlDir()} ; retire ces variables du service`;
}
