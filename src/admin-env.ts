// ENVIRONNEMENT DES SOUS-PROCESSUS DU PLUGIN (0.6.3) — appels Hermes (`hermesCallEnv`) et systemctl (`restartDashboard`).
//   - rien n'est hérité du serveur au-delà de la langue et du fuseau (valeurs au format contrôlé) ;
//   - PATH FIXÉ : dossier de l'interpréteur Hermes administré, puis /usr/local/bin:/usr/bin:/bin (plus le PATH du serveur) ;
//   - HOME, USER, LOGNAME : dérivés du COMPTE (getpwuid), jamais de $HOME / $USER / $LOGNAME ;
//   - XDG_RUNTIME_DIR et DBUS_SESSION_BUS_ADDRESS : seulement pour une opération d'ADMINISTRATION qui a besoin du
//     gestionnaire de services utilisateur. L'opération est une constante choisie par le code appelant (liste fermée
//     ci-dessous), jamais un paramètre fourni par un agent ou une action ; les deux valeurs sont dérivées de l'uid du
//     compte (/run/user/<uid>, propriétaire vérifié), jamais reprises de l'environnement du serveur.
// LIMITE (à ne pas confondre avec une isolation) : retirer ces variables ne ferme pas l'accès au bus. Hermes 0.21
// reconstitue lui-même XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS depuis /run/user/<uid> (hermes_cli/gateway.py,
// _ensure_user_systemd_env) ; tout processus du même uid qui voit ce dossier peut joindre le bus. Seule une séparation
// de comptes ou un espace de noms sans /run/user/<uid> ferme cet accès.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { accountHome, accountName } from "./paths.js";

export const SYSTEM_PATH = ["/usr/local/bin", "/usr/bin", "/bin"] as const;

/** Opérations d'un appel Hermes du plugin. Seule `gateway_service` reçoit l'accès au gestionnaire de services. */
export type HermesCallOperation = "query" | "gateway_service";
const SERVICE_MANAGER_OPERATIONS: ReadonlySet<HermesCallOperation> = new Set<HermesCallOperation>(["gateway_service"]);

export function needsServiceManager(op: HermesCallOperation): boolean {
  return SERVICE_MANAGER_OPERATIONS.has(op);
}

function currentUid(): number {
  if (typeof process.getuid !== "function") throw new Error("Hermes Control : uid du compte indisponible sur cette plateforme ; refus");
  return process.getuid();
}

/** Identité du compte d'exécution (getpwuid) : refus si elle ne se résout pas. */
export function accountEnv(): { HOME: string; USER: string; LOGNAME: string } {
  const name = accountName();
  return { HOME: accountHome(), USER: name, LOGNAME: name };
}

const LOCALE_VALUE = /^[A-Za-z0-9_.@:+/-]{1,64}$/;
/** LANG / LC_ALL / TZ du serveur, seulement s'ils ont un format de locale ou de fuseau (pas de chemin : ni « / » ou « : » initial, ni « .. »). */
export function localeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["LANG", "LC_ALL", "TZ"]) {
    const v = env[k];
    if (typeof v === "string" && LOCALE_VALUE.test(v) && !v.includes("..") && !v.startsWith("/") && !v.startsWith(":")) out[k] = v;
  }
  return out;
}

/**
 * Accès au gestionnaire de services UTILISATEUR, dérivé de l'uid du compte : /run/user/<uid> s'il existe et appartient
 * au compte, et son socket `bus` s'il existe. Sinon rien (systemctl --user échouera, visiblement).
 */
export function userServiceManagerEnv(uid: number = currentUid(), runtimeRoot = "/run/user"): Record<string, string> {
  const dir = `${runtimeRoot}/${uid}`;
  const out: Record<string, string> = {};
  try {
    const st = statSync(dir);
    if (!st.isDirectory() || st.uid !== uid) return out;
  } catch {
    return out;
  }
  out["XDG_RUNTIME_DIR"] = dir;
  try {
    const b = statSync(`${dir}/bus`);
    if (b.isSocket() && b.uid === uid) out["DBUS_SESSION_BUS_ADDRESS"] = `unix:path=${dir}/bus`;
  } catch {
    /* pas de bus : seul XDG_RUNTIME_DIR (socket privé de systemd) */
  }
  return out;
}

/** PATH fixé : dossiers administrés en tête (absolus, sans doublon), puis le chemin système. */
export function fixedPath(prefix: readonly string[] = []): string {
  const out: string[] = [];
  for (const d of [...prefix, ...SYSTEM_PATH]) if (d && d.startsWith("/") && !out.includes(d)) out.push(d);
  return out.join(":");
}

let rootLikeUids: Set<number> | null = null;
function rootLike(uid: number): boolean {
  if (!rootLikeUids) {
    rootLikeUids = new Set([0]);
    try {
      // dans un espace de noms utilisateur (bwrap, conteneur), les fichiers de root apparaissent sous l'overflowuid
      const map = readFileSync("/proc/self/uid_map", "utf8").trim().split(/\s+/);
      if (!(map[0] === "0" && map[1] === "0" && map[2] === "4294967295")) rootLikeUids.add(Number(readFileSync("/proc/sys/kernel/overflowuid", "utf8").trim()));
    } catch {
      /* hôte : root seulement */
    }
  }
  return rootLikeUids.has(uid);
}

/** `systemctl` de CONFIANCE : chemin système fixe, fichier régulier de root, ni lui ni son dossier modifiables par d'autres. */
export function trustedSystemctl(candidates: readonly string[] = ["/usr/bin/systemctl", "/bin/systemctl"]): string {
  const problems: string[] = [];
  for (const c of candidates) {
    try {
      const real = realpathSync(c);
      const st = statSync(real);
      const dst = statSync(dirname(real));
      if (!st.isFile()) problems.push(`${c} : pas un fichier régulier`);
      else if (!rootLike(st.uid) || !rootLike(dst.uid)) problems.push(`${c} : propriétaire non root`);
      else if (st.mode & 0o022 || dst.mode & 0o022) problems.push(`${c} : modifiable par le groupe ou les autres`);
      else if (!(st.mode & 0o111)) problems.push(`${c} : non exécutable`);
      else return real;
    } catch (e) {
      problems.push(`${c} : ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
  }
  throw new Error(`Hermes Control : aucun systemctl de confiance (${problems.join(" ; ")}) ; refus`);
}

/** Environnement minimal d'un appel `systemctl --user` du plugin (administration du service utilisateur). */
export function systemctlUserEnv(): Record<string, string> {
  return { PATH: "/usr/bin:/bin", ...accountEnv(), LANG: "C.UTF-8", ...userServiceManagerEnv() };
}
