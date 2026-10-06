// Instance Hermes de l'entreprise : STRICTEMENT celle dont le nom = slug(nom de l'entreprise) dans le dossier de travail.
// Aucun repli (ni « la première », ni « la seule ») : une instance appartient à une entreprise, jamais choisie par défaut.
import type { HermesInstance } from "./hermes.js";
import { slug } from "./match.js";
import type { Workspace } from "./workspace.js";

export function companyInstance(ws: Workspace, list: HermesInstance[], companyName: string | null): HermesInstance {
  const inWs = list.filter((i) => i.home.startsWith(ws.profils + "/"));
  const present = inWs.length ? inWs.map((i) => i.name).sort().join(", ") : "aucune";
  const want = companyName ? slug(companyName) : "";
  if (!want) throw new Error(`nom d'entreprise inconnu : impossible de choisir l'instance Hermes (instances dans ${ws.profils} : ${present})`);
  const found = inWs.find((i) => i.name === want);
  if (!found) throw new Error(`aucune instance Hermes nommée « ${want} » (entreprise « ${companyName} ») dans ${ws.profils} ; instances présentes : ${present}`);
  return found;
}
