// Licences des paquets tiers INTÉGRÉS dans un bundle esbuild, depuis ses métafichiers (chaque node_modules/<paquet> qui a
// fourni du code). Utilisé par esbuild.config.mjs (plugin) et adapter/esbuild.config.mjs (adaptateur).
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** @param {string} base dossier de travail du build ; @param {object[]} metafiles ; @param {string[]} entete lignes d'introduction */
export async function licencesTiers(base, metafiles, entete) {
  const racines = new Set();
  for (const mf of metafiles) {
    for (const entree of Object.keys(mf.inputs)) {
      const m = entree.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//g);
      if (!m) continue;
      const dernier = m[m.length - 1].replace(/^\//, "");
      racines.add(join(base, entree.slice(0, entree.lastIndexOf(dernier) + dernier.length)));
    }
  }
  const lignes = [...entete, ""];
  const noms = [];
  for (const racine of [...racines].sort()) {
    const j = JSON.parse(await readFile(join(racine, "package.json"), "utf8"));
    noms.push(`${j.name}@${j.version}`);
    const lic = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "LICENCE"].map((f) => join(racine, f)).find((f) => existsSync(f));
    lignes.push(`## ${j.name}@${j.version} — ${j.license ?? "licence non déclarée"}`, "");
    if (j.hermesControlPatch) lignes.push(`Copie corrigée (voie 1) de ${j.hermesControlPatch.base}.`, "");
    lignes.push(lic ? "```\n" + (await readFile(lic, "utf8")).trim() + "\n```"
      : `Pas de fichier de licence dans le paquet publié ; licence déclarée dans son package.json : ${j.license ?? "aucune"}.${j.repository ? ` Source : ${typeof j.repository === "string" ? j.repository : j.repository.url}.` : ""}`, "");
  }
  return { texte: lignes.join("\n"), noms };
}
