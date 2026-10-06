// PÉRIMÈTRE D'UNE ACTION (0.6.2) : on part du contexte d'action AUTORISÉ par Paperclip, jamais d'un paramètre.
// Paperclip 2026.1001.0 (routes/plugins.js, assertPluginBridgeScope) sur les deux routes d'action
// (POST /api/plugins/:id/actions/:key et POST /api/plugins/:id/bridge/action) :
//   - corps AVEC `companyId` → assertCompanyAccess(req, companyId) puis actorContext.companyId = ce companyId (et
//     params.companyId est remplacé par lui) ;
//   - corps SANS `companyId` → assertInstanceAdmin(req) (administrateur d'instance, ou board local implicite en
//     local_trusted) puis actorContext.companyId = null.
// Le worker en déduit un contrat VÉRIFIABLE :
//   - action d'ENTREPRISE : actx.companyId non nul (accès à l'entreprise contrôlé par le serveur) ; un params.companyId
//     différent est une contradiction → refus ; c'est actx.companyId qui fait foi, jamais le paramètre ;
//   - action GLOBALE (binaire Hermes par défaut pour toutes les entreprises) : actx.companyId NUL, donc appel sans
//     entreprise que seul un administrateur d'instance peut faire passer ; avec une entreprise → refus (un utilisateur
//     d'entreprise ne change pas le défaut des autres), même si c'est l'administrateur qui l'envoie depuis une page
//     d'entreprise : la page du plugin envoie TOUJOURS le companyId de la page, l'opération globale passe donc par l'API.
// Toute action exige un acteur « user » (board) : un agent ou le système sont refusés.

export interface ActionContextLike {
  actor: { type: string; userId: string | null; companyId?: string | null };
  companyId?: string | null;
}

export type ActionScope = { kind: "company"; companyId: string; by: string } | { kind: "admin"; by: string };

function nonEmpty(x: unknown): string | null {
  return typeof x === "string" && x.trim() ? x.trim() : null;
}

/** Acteur + périmètre autorisé ; refus si l'acteur n'est pas un utilisateur ou si les paramètres contredisent le contexte. */
export function actionScope(actx: ActionContextLike, params: Record<string, unknown>): ActionScope {
  if (actx.actor.type !== "user") throw new Error("action réservée à un utilisateur du board");
  const by = `user:${actx.actor.userId ?? "?"}`;
  const authorized = nonEmpty(actx.companyId) ?? nonEmpty(actx.actor.companyId);
  const asked = params["companyId"] === undefined || params["companyId"] === null ? null : String(params["companyId"]).trim();
  if (authorized) {
    if (asked !== null && asked !== authorized) throw new Error(`paramètres contradictoires : companyId ${asked || "(vide)"} ≠ entreprise autorisée par Paperclip pour cette action (${authorized}) ; rien n'est fait`);
    return { kind: "company", companyId: authorized, by };
  }
  return { kind: "admin", by };
}

/** Action d'entreprise : le contexte autorisé doit porter une entreprise. */
export function companyScope(actx: ActionContextLike, params: Record<string, unknown>): { companyId: string; by: string } {
  const s = actionScope(actx, params);
  if (s.kind !== "company") throw new Error("action d'entreprise appelée sans entreprise autorisée (companyId absent du contexte d'action) ; rien n'est fait");
  return { companyId: s.companyId, by: s.by };
}

/** Action globale : seulement sans entreprise (le serveur a exigé un administrateur d'instance). */
export function adminScope(actx: ActionContextLike, params: Record<string, unknown>, what: string): { by: string } {
  const s = actionScope(actx, params);
  if (s.kind !== "admin") throw new Error(`${what} : opération GLOBALE réservée à l'administrateur d'instance — appel sans entreprise (sans companyId), que Paperclip n'accepte que d'un administrateur ; refusée dans le périmètre de l'entreprise ${s.companyId} ; rien n'est écrit`);
  return { by: s.by };
}
