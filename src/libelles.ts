// Libellés de la page Hermes (10/10, défaut n° 6 de l'installation réelle) : la ligne racine d'une instance s'affichait « default »
// (Cyril l'a prise pour un second Chef) et l'instance « i00001 ». Avec la projection du pack (identites.json, lue seulement) :
//   - instance : « <section> (<alias>) » ;
//   - profil racine « default » : « <section> — connexion de la section » (la connexion au modèle de l'instance, partagée) ;
//   - profil d'agent « aNNNNN » : « <nom de l'agent> (aNNNNN) » ;
//   - ordre : le Chef (rôle ceo) en premier, puis les autres agents par alias, puis la ligne de la section en dernier.
// Rien n'est écrit ; sans projection (hors mode projection), les noms restent ceux du disque.
import type { HermesInstance, HermesProfile } from "./hermes.js";
import type { Projection } from "./identites.js";

export const LIBELLE_CONNEXION_SECTION = "connexion de la section";

export interface ProfilLibelle extends HermesProfile { label?: string; agentId?: string | null; role?: string | null }
export interface InstanceLibelle extends Omit<HermesInstance, "profiles"> { label?: string; section?: string | null; profiles: ProfilLibelle[] }

const alias = (home: string): string => home.replace(/\/+$/, "").split("/").pop() ?? home;

export function decorerInstances(list: HermesInstance[], projection: Projection | null, roles: Map<string, string | null | undefined> = new Map()): InstanceLibelle[] {
  return list.map((inst) => {
    const i = projection?.instances.find((x) => x.alias === alias(inst.home)) ?? null;
    const agentsDe = (p: HermesProfile) => projection?.agents.find((a) => a.instanceAlias === i?.alias && a.profileAlias === p.name) ?? null;
    const profils: ProfilLibelle[] = inst.profiles.map((p) => {
      if (p.name === "default") return { ...p, label: i ? `${i.section} — ${LIBELLE_CONNEXION_SECTION}` : p.name, agentId: null, role: null };
      const a = agentsDe(p);
      const role = a ? roles.get(a.agentId) ?? null : null;
      return { ...p, label: a ? `${a.name} (${p.name})` : p.name, agentId: a?.agentId ?? null, role };
    });
    const rang = (p: ProfilLibelle): number => (p.name === "default" ? 2 : p.role === "ceo" ? 0 : 1);
    profils.sort((a, b) => rang(a) - rang(b) || a.name.localeCompare(b.name));
    return { ...inst, profiles: profils, section: i?.section ?? null, label: i ? `${i.section} (${i.alias})` : inst.name };
  });
}
