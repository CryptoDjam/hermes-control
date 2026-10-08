// Lot B (prototype, 08/10) — Hermes Control CONSOMME la projection d'identités du pack, il ne l'écrit jamais.
// Chaîne décidée par Cyril M (08/10, 03 h 20) : Paperclip fait autorité (companyId, agentId) → le pack attribue seul les
// alias courts et stables dans <ws>/donnees/identites.json → HC lit et REFUSE :
//   - projection invalide (illisible, corrompue, schéma ou relations incohérents, enveloppe différente) ;
//   - statut hors de la liste fermée (actif | absent | retire), pour une entreprise comme pour un agent ;
//   - alias absent (agent sans entrée), agent sans affectation explicite d'instance ;
//   - IDENTITÉ INACTIVE : un agent ne tourne (préparation, exécution, reprise, skills) que si l'entreprise ET l'agent sont
//     « actif ». Choix de Cyril M (08/10) : « un agent absent est préservé » — alias, dossiers, mémoire et affectation
//     restent, mais il ne peut pas tourner ; « retire » ne tourne plus jamais (alias jamais réattribué). Le refus est un
//     refus de configuration (non réessayé) : seul le pack peut changer le statut (identites sync / retirer) ;
//   - incohérence d'entreprise (l'agent appartient à une autre entreprise que le contexte Paperclip) ;
//   - dossier attribué à une autre identité (voir proprietaire.ts).
// Dossiers dérivés des seuls alias : profil <ws>/donnees/h/<i>/profiles/<a>, données <ws>/donnees/e/<e>/a/<a>.
// L'affectation agent → instance n'est PAS administrée ici : elle vient de la projection (commande du pack
// `identites affecter --agent <id> --instance <iNNNNN>`). En mode projection, assignments.json ne porte plus ni
// `companies` ni `agents` (table concurrente refusée), seulement les réglages d'exécution (binaire, racine d'exécution).
// Validation volontairement redondante avec celle du pack (HC ne fait pas confiance à l'écrivain).
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { budgetSockets } from "./health.js";
import { type Workspace, exists } from "./workspace.js";

const ALIAS = { e: /^e[0-9]{5}$/, i: /^i[0-9]{5}$/, a: /^a[0-9]{5}$/ } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Liste FERMÉE des statuts de la projection (schéma 2) ; tout autre valeur rend la projection invalide. */
export const STATUTS = ["actif", "absent", "retire"] as const;
export type Statut = (typeof STATUTS)[number];
const isStatut = (x: unknown): x is Statut => typeof x === "string" && (STATUTS as readonly string[]).includes(x);
/** Préfixe stable des refus d'identité inactive (reconnu par l'exécution pour son type de refus). */
export const INACTIVE = "identité inactive";

export interface PEntreprise { companyId: string; alias: string; name: string; statut: Statut }
export interface PInstance { alias: string; companyAlias: string; section: string; modelAccount: string }
export interface PAgent { agentId: string; companyAlias: string; profileAlias: string; name: string; statut: Statut; instanceAlias?: string; affecteLe?: string; affectePar?: string }
export interface Projection { schemaVersion: 2; revision: number; envelope: { root: string; maxSocketPathBytes: 100 }; compteurs: { e: number; i: number; a: number }; companies: PEntreprise[]; instances: PInstance[]; agents: PAgent[] }

export function identitesFile(ws: Pick<Workspace, "root">): string {
  return join(ws.root, "donnees", "identites.json");
}

export function instanceDir(ws: Pick<Workspace, "root">, i: string): string {
  return join(ws.root, "donnees", "h", i);
}
export function dataDir(ws: Pick<Workspace, "root">, e: string, a: string): string {
  return join(ws.root, "donnees", "e", e, "a", a);
}

export async function projectionMode(ws: Workspace | null): Promise<boolean> {
  return !!ws && (await exists(identitesFile(ws)));
}

function errors(x: unknown): string[] {
  const e: string[] = [];
  if (!x || typeof x !== "object" || Array.isArray(x)) return ["pas un objet JSON"];
  const p = x as Partial<Projection>;
  if (p.schemaVersion !== 2) e.push(`schemaVersion ${JSON.stringify(p.schemaVersion)} (attendu 2)`);
  if (!Number.isInteger(p.revision)) e.push("revision manquante");
  const root = p.envelope?.root;
  if (typeof root !== "string" || !isAbsolute(root) || normalize(root) !== root) e.push("envelope.root invalide");
  if (p.envelope?.maxSocketPathBytes !== 100) e.push("envelope.maxSocketPathBytes ≠ 100");
  const c = p.compteurs;
  if (!c || !(["e", "i", "a"] as const).every((k) => Number.isInteger(c[k]) && c[k] >= 0)) e.push("compteurs invalides");
  if (!Array.isArray(p.companies) || !Array.isArray(p.instances) || !Array.isArray(p.agents)) return [...e, "listes manquantes"];
  const ids = new Set<string>();
  const aliasE = new Map<string, PEntreprise>();
  for (const co of p.companies) {
    if (!co || !UUID.test(String(co.companyId)) || !ALIAS.e.test(String(co.alias))) { e.push(`entreprise invalide ${JSON.stringify(co?.companyId)}`); continue; }
    if (!isStatut(co.statut)) e.push(`entreprise ${co.companyId} : statut ${JSON.stringify(co.statut)} inconnu (attendus : ${STATUTS.join(", ")})`);
    if (ids.has(co.companyId) || aliasE.has(co.alias)) e.push(`entreprise ou alias en double : ${co.companyId} / ${co.alias}`);
    if (c && Number(co.alias.slice(1)) > c.e) e.push(`alias ${co.alias} au-delà du compteur`);
    ids.add(co.companyId);
    aliasE.set(co.alias, co);
  }
  const instE = new Map<string, string>();
  for (const i of p.instances) {
    if (!i || !ALIAS.i.test(String(i.alias)) || !aliasE.has(i.companyAlias)) { e.push(`instance invalide ${JSON.stringify(i?.alias)}`); continue; }
    if (instE.has(i.alias)) e.push(`instance ${i.alias} en double`);
    if (c && Number(i.alias.slice(1)) > c.i) e.push(`alias ${i.alias} au-delà du compteur`);
    instE.set(i.alias, i.companyAlias);
  }
  const aids = new Set<string>();
  const aliasA = new Set<string>();
  for (const a of p.agents) {
    if (!a || !UUID.test(String(a.agentId)) || !ALIAS.a.test(String(a.profileAlias)) || !aliasE.has(a.companyAlias) || typeof a.name !== "string") { e.push(`agent invalide ${JSON.stringify(a?.agentId)}`); continue; }
    if (!isStatut(a.statut)) e.push(`agent ${a.agentId} : statut ${JSON.stringify(a.statut)} inconnu (attendus : ${STATUTS.join(", ")})`);
    if (aids.has(a.agentId)) e.push(`agent ${a.agentId} en double`);
    if (aliasA.has(a.profileAlias)) e.push(`alias ${a.profileAlias} attribué à deux agents`);
    if (c && Number(a.profileAlias.slice(1)) > c.a) e.push(`alias ${a.profileAlias} au-delà du compteur`);
    aids.add(a.agentId);
    aliasA.add(a.profileAlias);
    if (a.instanceAlias !== undefined) {
      if (!instE.has(a.instanceAlias)) e.push(`agent ${a.agentId} : instance ${a.instanceAlias} inconnue`);
      else if (instE.get(a.instanceAlias) !== a.companyAlias) e.push(`agent ${a.agentId} (${a.companyAlias}) affecté à une instance d'une autre entreprise (${a.instanceAlias})`);
      if (a.statut === "retire") e.push(`agent retiré ${a.agentId} encore affecté`);
    }
  }
  return e;
}

/**
 * Lecture et validation de la projection. `raw` : le texte lu (empreinte pour le contrôle de fraîcheur,
 * identites-fraicheur.ts) ; ce lecteur ne garde aucun état et n'écrit rien.
 */
export async function readIdentites(ws: Pick<Workspace, "root">): Promise<{ projection: Projection | null; error: string | null; raw?: string }> {
  const f = identitesFile(ws);
  let txt: string;
  try {
    txt = await readFile(f, "utf8");
  } catch (e) {
    return { projection: null, error: `projection ${f} illisible (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})` };
  }
  let x: unknown;
  try {
    x = JSON.parse(txt);
  } catch (e) {
    return { projection: null, error: `projection ${f} corrompue (${(e as Error).message})` };
  }
  const errs = errors(x);
  if (errs.length) return { projection: null, error: `projection ${f} invalide : ${errs.join(" ; ")}` };
  const p = x as Projection;
  if (p.envelope.root !== ws.root) return { projection: null, error: `projection ${f} : enveloppe ${p.envelope.root} ≠ dossier de travail ${ws.root} ; refus` };
  return { projection: p, error: null, raw: txt };
}

const ETAT: Record<Statut, string> = { actif: "active", absent: "absente de la dernière liste Paperclip", retire: "retirée" };

/**
 * Raison du refus quand l'identité n'est pas autorisée à tourner (entreprise ou agent non « actif »), sinon null.
 * Seule règle d'autorisation : entreprise ET agent actifs. Utilisée par la préparation ET par l'exécution.
 */
export function inactiveReason(co: Pick<PEntreprise, "companyId" | "alias" | "statut">, a: Pick<PAgent, "agentId" | "profileAlias" | "statut">): string | null {
  const who = `agent ${a.agentId} (${a.profileAlias})`;
  if (co.statut !== "actif") {
    const etat = isStatut(co.statut) ? ETAT[co.statut] : `au statut inconnu ${JSON.stringify(co.statut)}`;
    return `${INACTIVE} : entreprise ${co.companyId} (${co.alias}) ${etat} dans la projection ; ${who} préservé mais il ne peut pas tourner ; refus non réessayé (le pack seul change ce statut : identites sync)`;
  }
  if (a.statut === "absent") return `${INACTIVE} : ${who} absent de la dernière liste Paperclip ; préservé (alias, dossiers, mémoire, affectation) mais il ne peut pas tourner ; refus non réessayé (il redevient actif quand le pack le revoit : identites sync)`;
  if (a.statut === "retire") return `${INACTIVE} : ${who} retiré ; son alias n'est jamais réattribué et il ne tourne plus ; refus non réessayé`;
  if (a.statut !== "actif") return `${INACTIVE} : ${who} au statut inconnu ${JSON.stringify(a.statut)} ; refus non réessayé`;
  return null;
}

export interface Identity {
  companyId: string;
  agentId: string;
  companyAlias: string;
  agentAlias: string;
  instanceAlias: string;
  name: string;
  instanceHome: string; // <ws>/donnees/h/<i> (lexical ; le canonique est vérifié à part)
  profile: string; // = agentAlias
  agentDir: string; // <ws>/donnees/e/<e>/a/<a>
}

export type IdentityResolution = { ok: Identity; reason: null } | { ok: null; reason: string };

/** Identité d'un agent pour le contexte Paperclip (companyId, agentId) ; jamais par nom. Lecture seule. */
export function resolveIdentity(ws: Pick<Workspace, "root">, p: Projection, q: { companyId: string; agentId: string }): IdentityResolution {
  const a = p.agents.find((x) => x.agentId === q.agentId);
  if (!a) return { ok: null, reason: `alias absent : l'agent ${q.agentId} n'a pas d'entrée dans la projection (le pack l'attribue : identites sync) ; refus` };
  const co = p.companies.find((x) => x.alias === a.companyAlias)!;
  if (co.companyId !== q.companyId) return { ok: null, reason: `incohérence d'entreprise : l'agent ${q.agentId} est projeté pour l'entreprise ${co.companyId} (${co.alias}), pas pour ${q.companyId} ; refus` };
  const inactive = inactiveReason(co, a);
  if (inactive) return { ok: null, reason: inactive };
  if (!a.instanceAlias) return { ok: null, reason: `agent ${q.agentId} (${a.profileAlias}) sans affectation explicite d'instance (pack : identites affecter --agent ${q.agentId} --instance i…) ; refus` };
  return {
    ok: { companyId: co.companyId, agentId: a.agentId, companyAlias: co.alias, agentAlias: a.profileAlias, instanceAlias: a.instanceAlias, name: a.name, instanceHome: instanceDir(ws, a.instanceAlias), profile: a.profileAlias, agentDir: dataDir(ws, co.alias, a.profileAlias) },
    reason: null,
  };
}

/** Pour l'affichage et le diagnostic : budget des sockets d'une identité affectée, sur le HERMES_HOME littéral. */
export function identityBudget(id: Identity, executionRoot?: string): ReturnType<typeof budgetSockets> {
  return budgetSockets(`${(executionRoot ?? id.instanceHome).replace(/\/+$/, "")}/profiles/${id.profile}`);
}
