// Dossier de travail commun (« workspace ») installé par hermes-paperclip-pack :
//   <ws>/hermes/profils/<entreprise>/            instance Hermes (profiles/<agent> par agent)
//   <ws>/hermes/skills/<skill>                   skills communs, liés dans chaque profil
//   <ws>/modeles/{SOUL.md,MEMORY.md,USER.md,fiche.md,config.yaml,instructions.md}   gabarits
//   <ws>/agents/<agent>/{fiche.md,rapports,memoire,medias/{brouillons,valides,publies},journal}
// Le chemin est noté dans <référence>/workspace (une ligne ; aucune variable d'environnement). Sans ce fichier : rien d'automatique.
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { controlDir, userHome } from "./paths.js";

export interface Workspace {
  root: string;
  profils: string; // <ws>/hermes/profils
  skills: string; // <ws>/hermes/skills
  modeles: string; // <ws>/modeles
  agents: string; // <ws>/agents
}

export function workspaceFile(): string {
  return join(controlDir(), "workspace");
}

export function layout(root: string): Workspace {
  const r = resolve(root);
  return { root: r, profils: join(r, "hermes", "profils"), skills: join(r, "hermes", "skills"), modeles: join(r, "modeles"), agents: join(r, "agents") };
}

export async function readWorkspace(): Promise<Workspace | null> {
  try {
    const line = (await readFile(workspaceFile(), "utf8")).split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    return line ? layout(line.replace(/^~(?=\/|$)/, userHome())) : null;
  } catch {
    return null;
  }
}

export async function writeWorkspace(root: string): Promise<void> {
  const file = workspaceFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `# Dossier de travail commun Hermes + Paperclip (écrit par hermes-paperclip-pack)\n${resolve(root)}\n`);
}

export async function exists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
