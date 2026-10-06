// Diagnostic de la RÉFÉRENCE commune (plugin et adaptateur) : chemin du dossier, compte Unix d'où il vient, et empreinte
// de chaque fichier lu (assignments.json, roots, workspace, agents.json). Aucune donnée sensible : chemins et empreintes.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { accountHome, controlDir, legacyEnvPresent } from "./paths.js";

export interface ReferenceFile {
  name: string;
  path: string;
  exists: boolean;
  sha256: string | null;
  error: string | null;
}

export interface ReferenceInfo {
  dir: string;
  account: string; // dossier du compte (getpwuid) d'où la référence est calculée
  files: ReferenceFile[];
  legacyEnv: string[]; // anciennes variables encore posées (refus)
}

export const REFERENCE_FILES = ["assignments.json", "roots", "workspace", "agents.json"] as const;

export async function referenceInfo(): Promise<ReferenceInfo> {
  const dir = controlDir();
  const files: ReferenceFile[] = [];
  for (const name of REFERENCE_FILES) {
    const path = join(dir, name);
    try {
      const raw = await readFile(path);
      files.push({ name, path, exists: true, sha256: createHash("sha256").update(raw).digest("hex"), error: null });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      files.push({ name, path, exists: code !== "ENOENT", sha256: null, error: code === "ENOENT" ? null : (e as Error).message });
    }
  }
  return { dir, account: accountHome(), files, legacyEnv: legacyEnvPresent() };
}

/** Une ligne lisible : « référence <dir> (compte <home>) · assignments.json sha256 abcd… · roots absent · … ». */
export function describeReference(r: ReferenceInfo): string {
  const parts = r.files.map((f) => `${f.name} ${f.sha256 ? `sha256 ${f.sha256.slice(0, 16)}…` : f.error ? `illisible (${f.error})` : "absent"}`);
  return `référence ${r.dir} (compte ${r.account}) · ${parts.join(" · ")}${r.legacyEnv.length ? ` · variables héritées posées : ${r.legacyEnv.join(", ")}` : ""}`;
}
