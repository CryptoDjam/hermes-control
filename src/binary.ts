// Exécutable Hermes ADMINISTRÉ (0.6.1) : Paperclip ne lance plus de lanceur shell ni de nom trouvé dans le PATH. La table
// (assignments.json) désigne par un CHEMIN ABSOLU le point d'entrée Hermes, globalement (`hermes`) ou par instance
// (`instances[<instance>].hermes`) ; il est vérifié AVANT tout appel (y compris avant un éventuel `--version`) :
//   - chemin absolu, normalisé, sans segment « . » / « .. » ;
//   - fichier régulier ; un LIEN n'est accepté que si sa cible réelle est celle notée dans la table (`linkTarget`) ;
//   - propriétaire = l'utilisateur courant ; aucune écriture pour le groupe ni les autres (fichier et dossier qui le contient) ;
//   - exécutable par son propriétaire ;
//   - empreinte sha256 calculée (et IMPOSÉE si la table la donne : `sha256`) ;
//   - format : binaire ELF, ou script Python à shebang ABSOLU (le point d'entrée officiel `<install>/.venv/bin/hermes`) ;
//     l'interpréteur est vérifié (existe, fichier régulier, propriétaire courant ou root, pas d'écriture groupe/autres) et
//     consigné avec son installation (dossier du venv, `pyvenv.cfg`). Un script SHELL (bash, sh, …), un shebang via `env`
//     ou relatif, ou tout autre format est REFUSÉ : ce n'est pas un point d'entrée Hermes.
// La vérification ne lance rien. Elle ne couvre pas les modules Python importés : l'installation est consignée pour la recette.
import { createHash } from "node:crypto";
import { lstat, open, readFile, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";

export interface HermesBinarySpec {
  binary: string; // chemin absolu du point d'entrée Hermes
  linkTarget?: string; // si `binary` est un lien : sa cible réelle attendue (chemin absolu)
  sha256?: string; // empreinte imposée (facultative)
}

export interface VerifiedHermesBinary {
  path: string; // chemin administré, tel que passé à execFile / à l'adaptateur de base
  realPath: string;
  link: { target: string } | null;
  sha256: string;
  size: number;
  kind: "elf" | "python";
  interpreter: { path: string; realPath: string; installation: string | null; pyvenv: Record<string, string> | null } | null;
  pathPrefix: string[]; // dossier(s) à placer en tête de PATH (celui de l'interpréteur, ou du binaire)
}

export type BinaryCheck = { ok: VerifiedHermesBinary; error: null } | { ok: null; error: string };

const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "mksh", "fish", "csh", "tcsh", "busybox", "env"]);
const HEAD_BYTES = 512;

const refuse = (error: string): BinaryCheck => ({ ok: null, error });

/** Chemin absolu, normalisé, sans « . » ni « .. » ni « // » : sinon null avec la raison. */
export function strictAbsolute(p: string, what: string): string | null {
  if (typeof p !== "string" || !p) return `${what} vide`;
  if (!isAbsolute(p)) return `${what} « ${p} » : chemin non absolu`;
  if (p.split("/").some((seg) => seg === "." || seg === "..")) return `${what} « ${p} » : segment « . » ou « .. » interdit`;
  if (normalize(p) !== p && normalize(p) + "/" !== p) return `${what} « ${p} » : chemin non normalisé`;
  return null;
}

function uid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

let unmappedUid: number | null | undefined;
/**
 * Dans un espace de noms utilisateur (bwrap, conteneur sans root), les fichiers de root apparaissent sous l'uid de
 * débordement (overflowuid, 65534) : on le traite comme root, et SEULEMENT dans ce cas (sur l'hôte, 65534 = nobody : refusé).
 */
export async function overflowUidIfNamespaced(): Promise<number | null> {
  if (unmappedUid !== undefined) return unmappedUid;
  try {
    const map = (await readFile("/proc/self/uid_map", "utf8")).trim().split(/\s+/);
    const full = map[0] === "0" && map[1] === "0" && map[2] === "4294967295";
    unmappedUid = full ? null : Number((await readFile("/proc/sys/kernel/overflowuid", "utf8")).trim());
  } catch {
    unmappedUid = null;
  }
  return unmappedUid;
}

async function safeOwnerAndMode(p: string, what: string, allowRoot: boolean): Promise<string | null> {
  const st = await stat(p);
  const me = uid();
  const rootLike = st.uid === 0 || (allowRoot && st.uid === (await overflowUidIfNamespaced()));
  if (st.uid !== me && !(allowRoot && rootLike)) return `${what} ${p} : propriétaire uid ${st.uid} ≠ utilisateur courant (${me})${allowRoot ? " ni root" : ""}`;
  if (st.mode & 0o022) return `${what} ${p} : modifiable par le groupe ou les autres (mode ${(st.mode & 0o777).toString(8)})`;
  return null;
}

async function sha256File(p: string): Promise<string> {
  return createHash("sha256").update(await readFile(p)).digest("hex");
}

async function head(p: string): Promise<Buffer> {
  const fh = await open(p, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function readPyvenv(dir: string): Promise<Record<string, string> | null> {
  try {
    const out: Record<string, string> = {};
    for (const line of (await readFile(join(dir, "pyvenv.cfg"), "utf8")).split("\n")) {
      const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]!] = m[2]!;
    }
    return out;
  } catch {
    return null;
  }
}

/** Vérifie le point d'entrée administré, sans rien exécuter. */
export async function verifyHermesBinary(spec: HermesBinarySpec | null | undefined): Promise<BinaryCheck> {
  if (!spec || !spec.binary) return refuse("aucun binaire Hermes administré dans la table (champ `hermes.binary`, global ou par instance)");
  const bad = strictAbsolute(spec.binary, "binaire Hermes");
  if (bad) return refuse(bad);
  const path = spec.binary;
  try {
    const l = await lstat(path);
    let link: { target: string } | null = null;
    let real = path;
    if (l.isSymbolicLink()) {
      const target = await realpath(path);
      if (!spec.linkTarget) return refuse(`binaire Hermes ${path} : lien symbolique vers ${target} (lien « ${await readlink(path)} ») ; refusé tant que sa cible n'est pas notée dans la table (\`linkTarget\`)`);
      const badT = strictAbsolute(spec.linkTarget, "cible du binaire Hermes");
      if (badT) return refuse(badT);
      if (target !== spec.linkTarget) return refuse(`binaire Hermes ${path} : lien vers ${target}, différent de la cible notée ${spec.linkTarget}`);
      // le dossier du lien ne doit pas être modifiable par d'autres (sinon le lien peut être remplacé)
      const dirIssue = await safeOwnerAndMode(dirname(path), "dossier du binaire Hermes", true);
      if (dirIssue) return refuse(dirIssue);
      link = { target };
      real = target;
    } else if (spec.linkTarget) {
      return refuse(`binaire Hermes ${path} : \`linkTarget\` noté (${spec.linkTarget}) mais ce n'est pas un lien`);
    }
    const st = await stat(real);
    if (!st.isFile()) return refuse(`binaire Hermes ${real} : pas un fichier régulier`);
    const own = await safeOwnerAndMode(real, "binaire Hermes", false);
    if (own) return refuse(own);
    if (!(st.mode & 0o100)) return refuse(`binaire Hermes ${real} : non exécutable par son propriétaire`);
    const dirIssue = await safeOwnerAndMode(dirname(real), "dossier du binaire Hermes", true);
    if (dirIssue) return refuse(dirIssue);
    const sha = await sha256File(real);
    if (spec.sha256 && spec.sha256.toLowerCase() !== sha) return refuse(`binaire Hermes ${real} : empreinte ${sha} ≠ empreinte notée ${spec.sha256}`);
    const h = await head(real);
    if (h.length >= 4 && h[0] === 0x7f && h[1] === 0x45 && h[2] === 0x4c && h[3] === 0x46) {
      return { ok: { path, realPath: real, link, sha256: sha, size: st.size, kind: "elf", interpreter: null, pathPrefix: [dirname(path)] }, error: null };
    }
    if (h[0] === 0x23 && h[1] === 0x21) {
      const line = h.toString("utf8").split("\n")[0]!.slice(2).trim();
      const interp = line.split(/\s+/)[0] ?? "";
      if (!interp || !isAbsolute(interp)) return refuse(`binaire Hermes ${real} : shebang « #!${line} » sans interpréteur absolu`);
      const name = basename(interp);
      if (SHELLS.has(name)) return refuse(`binaire Hermes ${real} : script ${name === "env" ? "lancé via env" : `shell (${name})`}, pas un point d'entrée Hermes`);
      if (!/^python(\d+(\.\d+)*)?$/.test(name)) return refuse(`binaire Hermes ${real} : interpréteur ${interp} non pris en charge (seul un point d'entrée Python est accepté)`);
      const ireal = await realpath(interp).catch(() => null);
      if (!ireal) return refuse(`binaire Hermes ${real} : interpréteur ${interp} introuvable`);
      const ist = await stat(ireal);
      if (!ist.isFile()) return refuse(`binaire Hermes ${real} : interpréteur ${ireal} n'est pas un fichier régulier`);
      const iown = await safeOwnerAndMode(ireal, "interpréteur Hermes", true);
      if (iown) return refuse(iown);
      const binDir = dirname(interp);
      const venv = dirname(binDir);
      const pyvenv = await readPyvenv(venv);
      return {
        ok: { path, realPath: real, link, sha256: sha, size: st.size, kind: "python", interpreter: { path: interp, realPath: ireal, installation: pyvenv ? venv : null, pyvenv }, pathPrefix: [binDir] },
        error: null,
      };
    }
    return refuse(`binaire Hermes ${real} : format inconnu (ni ELF ni script Python à shebang absolu)`);
  } catch (e) {
    return refuse(`binaire Hermes ${path} illisible : ${(e as Error).message}`);
  }
}

/** Résumé consigné (journal, diagnostic) : chemin, cible, empreinte, interpréteur et installation ; jamais de secret. */
export function describeBinary(b: VerifiedHermesBinary): string {
  const parts = [`${b.path}${b.link ? ` → ${b.link.target}` : ""}`, `sha256 ${b.sha256.slice(0, 16)}…`, b.kind === "elf" ? "ELF" : "Python"];
  if (b.interpreter) parts.push(`interpréteur ${b.interpreter.path}${b.interpreter.realPath !== b.interpreter.path ? ` → ${b.interpreter.realPath}` : ""}`, `installation ${b.interpreter.installation ?? "?"}${b.interpreter.pyvenv?.["version_info"] ? ` (Python ${b.interpreter.pyvenv["version_info"]})` : ""}`);
  return parts.join(" · ");
}
