// EXÉCUTION MAÎTRISÉE (0.6.1) : l'adaptateur construit lui-même la commande Hermes, depuis la table et rien d'autre.
//   - binaire : le point d'entrée ADMINISTRÉ (table : instances[<instance>].hermes, sinon hermes), vérifié avant tout appel
//     (binary.ts). Le `hermesCommand` / `command` de l'agent, un nom nu ou le PATH ne servent JAMAIS à lancer ;
//   - HERMES_HOME : racine d'exécution LITTÉRALE administrée (instances[<instance>].executionRoot, sinon la racine canonique)
//     + profiles/<profil>, ou la racine elle-même pour le profil `default` ; on vérifie que son realpath est exactement le
//     profil canonique affecté (un alias vers une autre instance, ou un profiles/<p> qui serait un lien ailleurs, est refusé),
//     puis on mesure les chemins de sockets SUR CETTE CHAÎNE (celle que Hermes reçoit) ;
//   - environnement : construit ici. `config.env` de l'agent ne peut écraser ni HERMES_HOME, ni PATH, ni les variables qui
//     détourneraient l'interpréteur (PYTHON*, LD_*, …) : elles sont retirées (et neutralisées si le serveur les porte) ;
//     PATH = dossier de l'interpréteur Hermes en tête, puis le PATH du serveur ;
//   - arguments : `-p` / `--profile` dans extraArgs est refusé (Hermes changerait de profil après coup) ; pour le profil
//     `default`, un `active_profile` qui redirigerait Hermes vers un autre profil est refusé.
// Tout refus de CONFIGURATION lève HermesControlRefusal (non réessayable côté Paperclip, voir l'adaptateur) ; une erreur
// inattendue (lecture du disque en échec…) remonte telle quelle et reste réessayable.
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type ResolvedAssignment, resolveAssignment } from "./assignments.js";
import { type VerifiedHermesBinary, verifyHermesBinary } from "./binary.js";
import { type SocketPathCheck, checkSocketPaths, socketPathAlert } from "./health.js";
import { readConfigStrict } from "./hermes.js";
import { legacyEnvRefusal } from "./paths.js";
import { profileUsability } from "./prepare.js";
import { exists } from "./workspace.js";

export type RefusalKind = "reference" | "not_assigned" | "assignment" | "table" | "profile" | "binary" | "execution_root" | "socket" | "arguments";

/** Refus de configuration : Paperclip ne doit pas le réessayer (rien ne changera sans un geste d'administration). */
export class HermesControlRefusal extends Error {
  readonly kind: RefusalKind;
  constructor(kind: RefusalKind, message: string) {
    super(message);
    this.name = "HermesControlRefusal";
    this.kind = kind;
  }
}

export interface ExecutionPlan {
  assignment: ResolvedAssignment;
  hermesHome: string; // chaîne transmise telle quelle à Hermes (HERMES_HOME)
  binary: VerifiedHermesBinary;
  socket: SocketPathCheck;
}

/** Variables que `config.env` ne peut pas fixer : posées ou neutralisées par l'adaptateur. */
export const ADMINISTERED_ENV = ["HERMES_HOME", "PATH"] as const;
export const NEUTRALIZED_ENV = [
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONUSERBASE",
  "PYTHONINSPECT",
  "PYTHONEXECUTABLE",
  "VIRTUAL_ENV",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "BASH_ENV",
  "ENV",
  "HERMES_UPDATE_POST_SWAP",
  "HERMES_SUPERVISED_CHILD",
  "HERMES_S6_SUPERVISED_CHILD",
  "HERMES_GATEWAY_EXTERNAL_SUPERVISOR",
] as const;
const RESERVED = new Set<string>([...ADMINISTERED_ENV, ...NEUTRALIZED_ENV]);

const PROFILE_FLAG = /^(-p|--profile)(=.*)?$/;

/** Arguments supplémentaires de l'agent : refus de tout `-p` / `--profile` (changement de profil par Hermes lui-même). */
export function checkExtraArgs(extraArgs: unknown): string | null {
  if (!Array.isArray(extraArgs)) return null;
  const bad = extraArgs.map(String).filter((a) => PROFILE_FLAG.test(a.trim()));
  return bad.length ? `extraArgs contient ${bad.join(", ")} : Hermes changerait de profil après le contrôle ; refus` : null;
}

/**
 * Contrôle complet AVANT tout appel à Hermes : affectation valide pour l'entreprise de l'agent, profil présent, lisible et
 * utilisable, binaire administré vérifié, HERMES_HOME littéral = même profil que l'affectation, sockets sous la limite.
 */
export async function planExecution(agent: { id?: string; name: string; companyId?: string | null }): Promise<ExecutionPlan> {
  const legacy = legacyEnvRefusal();
  if (legacy) throw new HermesControlRefusal("reference", legacy);
  const r = await resolveAssignment(agent.id ?? "", { companyId: agent.companyId ?? null });
  if (!r.ok) {
    const kind: RefusalKind = /^non affecté/.test(r.reason) ? "not_assigned" : /assignments\.json (invalide|corrompu|illisible)/.test(r.reason) ? "table" : "assignment";
    throw new HermesControlRefusal(kind, r.reason);
  }
  const rec = r.ok;
  const label = `${rec.instanceHome}${rec.profile === "default" ? " (profil default)" : `/profiles/${rec.profile}`}`;
  if (!(await exists(join(rec.home, "config.yaml")))) throw new HermesControlRefusal("profile", `affecté à ${label} mais ${rec.home}/config.yaml n'existe pas (profil à préparer : page Hermes → « Préparer l'agent »)`);
  const { error } = await readConfigStrict(rec.home);
  if (error) throw new HermesControlRefusal("profile", `${rec.home}/${error} ; aucun passage tant que le fichier n'est pas réparé`);
  const unusable = await profileUsability(rec.instanceHome, rec.profile);
  if (unusable) throw new HermesControlRefusal("profile", unusable);

  // HERMES_HOME transmis : chaîne littérale administrée ; elle doit désigner EXACTEMENT le profil canonique affecté
  const hermesHome = rec.execution.home;
  if (!isAbsolute(hermesHome)) throw new HermesControlRefusal("execution_root", `HERMES_HOME ${hermesHome} non absolu`);
  // rec.home est lexical sur la racine canonique (realpath) : un profiles/<p> qui serait un lien vers ailleurs ne lui est pas égal
  const viaExec = await realpath(hermesHome).catch(() => null);
  if (!viaExec || viaExec !== rec.home) throw new HermesControlRefusal("execution_root", `HERMES_HOME ${hermesHome} désigne ${viaExec ?? "un chemin introuvable"}, pas le profil affecté ${rec.home}`);
  if (rec.profile === "default") {
    // Hermes 0.21 : avec HERMES_HOME = racine, `<racine>/active_profile` le redirige vers un autre profil
    const active = (await readFile(join(hermesHome, "active_profile"), "utf8").catch(() => "")).trim();
    if (active && active !== "default") throw new HermesControlRefusal("profile", `profil default : ${hermesHome}/active_profile vaut « ${active} », Hermes tournerait dans un autre profil ; refus`);
  }

  const bin = await verifyHermesBinary(rec.hermes);
  if (bin.ok === null) throw new HermesControlRefusal("binary", bin.error);

  const socket = await checkSocketPaths(hermesHome);
  if (!socket.socketPathOk) throw new HermesControlRefusal("socket", `${socketPathAlert(socket)} (mesuré sur HERMES_HOME transmis ${hermesHome}) ; le watchdog de Hermes ne pourrait pas ouvrir son socket`);
  return { assignment: rec, hermesHome, binary: bin.ok, socket };
}

/**
 * Environnement à transmettre (fusionné par l'adaptateur de base APRÈS celui du serveur) : `config.env` sans les clés
 * réservées, puis HERMES_HOME et PATH administrés, puis les variables neutralisées à vide (CPython et ld.so ignorent une
 * valeur vide). `dropped` : clés de `config.env` écartées (noms seulement, pour le journal).
 */
export function buildAgentEnv(configEnv: unknown, plan: Pick<ExecutionPlan, "hermesHome" | "binary">, serverPath: string | undefined = process.env["PATH"]): { env: Record<string, unknown>; dropped: string[] } {
  const env: Record<string, unknown> = {};
  const dropped: string[] = [];
  if (configEnv && typeof configEnv === "object" && !Array.isArray(configEnv)) {
    for (const [k, v] of Object.entries(configEnv as Record<string, unknown>)) {
      if (RESERVED.has(k)) dropped.push(k);
      else env[k] = v;
    }
  }
  const path: string[] = [];
  for (const d of [...plan.binary.pathPrefix, ...(serverPath ?? "/usr/local/bin:/usr/bin:/bin").split(":")]) if (d && isAbsolute(d) && !path.includes(d)) path.push(d);
  for (const k of NEUTRALIZED_ENV) env[k] = "";
  env["PATH"] = path.join(":");
  env["HERMES_HOME"] = plan.hermesHome;
  return { env, dropped };
}
