// Où sont les instances Hermes : ~/.hermes, les dossiers listés dans ~/.config/hermes-control/roots (un par
// ligne : soit une instance, soit un dossier qui en contient), et la variable HERMES_CONTROL_ROOTS (séparateur « : »).
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join, resolve } from "node:path";
import { type HermesInstance, instanceNameFromHome, listInstancesInRoot, readInstance } from "./hermes.js";
import { controlDir, userHome } from "./paths.js";

/** Calculé à l'appel (pas à l'import) : HOME peut changer, notamment dans les tests. */
export function rootsFile(): string {
  return join(controlDir(), "roots");
}

async function isInstance(dir: string): Promise<boolean> {
  try {
    await access(join(dir, "config.yaml"), fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function configuredRoots(): Promise<string[]> {
  const roots = [join(userHome(), ".hermes")];
  try {
    for (const line of (await readFile(rootsFile(), "utf8")).split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("#")) roots.push(resolve(t.replace(/^~(?=\/|$)/, userHome())));
    }
  } catch {
    /* pas de fichier : seulement ~/.hermes */
  }
  for (const r of (process.env["HERMES_CONTROL_ROOTS"] ?? "").split(":")) if (r.trim()) roots.push(resolve(r.trim()));
  return [...new Set(roots)];
}

/** Dossiers d'instances (HERMES_HOME racine) trouvés depuis les racines configurées + ceux passés en plus (lanceurs), s'ils ont un config.yaml. */
export async function instanceHomes(extra: string[] = []): Promise<string[]> {
  const homes = new Set<string>();
  for (const h of extra) if (await isInstance(resolve(h))) homes.add(resolve(h));
  for (const root of await configuredRoots()) {
    if (await isInstance(root)) homes.add(root);
    else for (const h of await listInstancesInRoot(root)) homes.add(h);
  }
  return [...homes].sort();
}

/** Lecture rapide (sans `hermes auth status` ni journaux) : pour choisir un profil ou lister les modèles. */
export async function discoverLight(extra: string[] = [], binary = "hermes"): Promise<HermesInstance[]> {
  const out: HermesInstance[] = [];
  for (const home of await instanceHomes(extra)) {
    try {
      out.push(await readInstance(instanceNameFromHome(home), home, null, binary, null, { light: true }));
    } catch {
      /* instance illisible : ignorée */
    }
  }
  return out;
}
