// hermes-control-suivi — commande de l'OPÉRATEUR (jamais exposée au worker, à l'adaptateur ni à l'Assistant) :
//   etat           [--enveloppe <dossier>]   bilan de l'état de suivi (et maximum fiable pour le pack, en JSON)
//   amorcer        --enveloppe <dossier> --operateur <nom>
//   restaurer      --enveloppe <dossier> --operateur <nom> [--revision-min N] [--compteurs-min e,i,a] [--sans-reference]
//   notifications  [--rejouer] [--acquitter <id>]
// amorcer / restaurer demandent un terminal et la saisie du chemin exact de l'enveloppe (confirmation) ; ils sont refusés
// dans l'environnement d'un run d'agent. Code de sortie : 0 fait, 2 refusé, 1 erreur inattendue.
import { createInterface } from "node:readline/promises";
import { freshnessFile, readSuiviFile } from "./identites-fraicheur.js";
import { acquitter, etatNotifications, rejouer } from "./notifications.js";
import { type Bilan, OperationRefusee, etatEnveloppe, historique, operer } from "./suivi-operations.js";

function args(argv: string[]): { cmd: string; o: Record<string, string | true> } {
  const [cmd = "aide", ...rest] = argv;
  const o: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i]!;
    if (!k.startsWith("--")) throw new Error(`argument inattendu : ${k}`);
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) o[k.slice(2)] = true;
    else {
      o[k.slice(2)] = v;
      i++;
    }
  }
  return { cmd, o };
}

const entier = (v: string | true | undefined, nom: string): number | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !/^[0-9]+$/.test(v)) throw new Error(`--${nom} : entier attendu`);
  return Number(v);
};

function afficherBilan(b: Bilan): void {
  const ligne = (t: string) => process.stdout.write(t + "\n");
  ligne(`${b.type} ${b.resultat.toUpperCase()} — enveloppe ${b.root} — opérateur ${b.operateur} — ${b.id}${b.reprises ? ` (reprise ×${b.reprises})` : ""}`);
  if (b.raison) ligne(`  raison : ${b.raison}`);
  const e = (x: Bilan["avant"]) => `suivi ${x.suivi.etat}${x.entree ? ` r${x.entree.revision} e${x.entree.compteurs.e} i${x.entree.compteurs.i} a${x.entree.compteurs.a}` : ""} · marqueur ${x.marqueur.etat}${x.marqueur.coherent === false ? " (différent)" : ""} · projection ${"erreur" in x.projection ? `ERREUR ${x.projection.erreur}` : `r${x.projection.revision} e${x.projection.compteurs.e} i${x.projection.compteurs.i} a${x.projection.compteurs.a}`}`;
  ligne(`  avant : ${e(b.avant)}`);
  if (b.apres) ligne(`  après : ${e(b.apres)}`);
  if (b.maxFiable) ligne(`  maximum fiable : r${b.maxFiable.revision} e${b.maxFiable.compteurs.e} i${b.maxFiable.compteurs.i} a${b.maxFiable.compteurs.a}, ${b.maxFiable.retires} retiré(s) ; sources : ${b.maxFiable.sources.join(", ") || "aucune"}${b.sansReference ? " ; SANS RÉFÉRENCE (choix de l'opérateur)" : ""}`);
  if (b.sauvegarde) ligne(`  sauvegarde : ${b.sauvegarde.dossier} (${b.sauvegarde.fichiers.map((f) => `${f.nom} ${f.sha256.slice(0, 12)}`).join(", ") || "aucun fichier"})`);
  if (b.evenement) ligne(`  événement pour Chef : ${b.evenement.resume}`);
  if (b.notification) ligne(b.notification.ecrite ? `  notification : en file locale (${b.evenement?.id}) ; notifier absent → non livrée tant qu'il ne l'a pas acquittée${b.notification.perdus.length ? ` ; PERDUES (file pleine) : ${b.notification.perdus.join(", ")}` : ""}` : `  notification NON ÉCRITE (${b.notification.erreur}) : la restauration est faite et prouvée ; rejoue avec « hermes-control-suivi notifications --rejouer »`);
}

async function confirmer(root: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new OperationRefusee("refus : terminal interactif requis (geste de l'opérateur) ; aucune confirmation par argument");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`Opération sur l'enveloppe ${root}.\nRetape son chemin exact pour confirmer : `)).trim();
  } finally {
    rl.close();
  }
}

export async function main(argv: string[]): Promise<number> {
  const { cmd, o } = args(argv);
  try {
    if (cmd === "etat") {
      const root = typeof o["enveloppe"] === "string" ? o["enveloppe"] : null;
      const s = await readSuiviFile();
      const out = { suivi: freshnessFile(), etatGlobal: s.kind === "ok" ? "ok" : s.kind === "absent" ? "absent" : s.regle, enveloppes: s.kind === "ok" ? Object.keys(s.value.enveloppes) : [], enveloppe: root ? await etatEnveloppe(root) : null, historique: root ? (await historique(root)).map((b) => ({ id: b.id, type: b.type, resultat: b.resultat, fin: b.fin, maxFiable: b.maxFiable })) : [], notifications: await etatNotifications().then((n) => ({ enAttente: n.enAttente.length, pertes: n.pertes.length })) };
      process.stdout.write(JSON.stringify(out, null, 2) + "\n"); // toujours JSON (lu par le pack : maximum fiable)
      return 0;
    }
    if (cmd === "amorcer" || cmd === "restaurer") {
      const root = o["enveloppe"];
      const operateur = o["operateur"];
      if (typeof root !== "string" || typeof operateur !== "string") throw new OperationRefusee("refus : --enveloppe et --operateur sont obligatoires");
      const cm = typeof o["compteurs-min"] === "string" ? o["compteurs-min"].split(",") : null;
      if (cm && (cm.length !== 3 || cm.some((x) => !/^[0-9]+$/.test(x)))) throw new OperationRefusee("refus : --compteurs-min e,i,a (trois entiers)");
      const minimums = { revision: entier(o["revision-min"], "revision-min"), ...(cm ? { e: Number(cm[0]), i: Number(cm[1]), a: Number(cm[2]) } : {}) };
      const confirmation = await confirmer(root);
      const b = await operer(cmd === "amorcer" ? "amorcage" : "restauration", { root, operateur, confirmation, minimums, sansReference: o["sans-reference"] === true });
      afficherBilan(b);
      return 0;
    }
    if (cmd === "notifications") {
      if (typeof o["acquitter"] === "string") process.stdout.write(((await acquitter(o["acquitter"])) ? "acquitté" : "introuvable dans la file") + "\n");
      if (o["rejouer"]) process.stdout.write(`rejouées : ${(await rejouer()).join(", ") || "aucune"}\n`);
      const n = await etatNotifications();
      process.stdout.write(JSON.stringify({ enAttente: n.enAttente, pertes: n.pertes, acquittes: n.acquittes, illisibles: n.illisibles }, null, 2) + "\n");
      return 0;
    }
    process.stdout.write("hermes-control-suivi etat [--enveloppe <dossier>] | amorcer --enveloppe <dossier> --operateur <nom> | restaurer --enveloppe <dossier> --operateur <nom> [--revision-min N] [--compteurs-min e,i,a] [--sans-reference] | notifications [--rejouer] [--acquitter <id>]\n");
    return cmd === "aide" ? 0 : 2;
  } catch (e) {
    if (e instanceof OperationRefusee) {
      if (e.bilan) afficherBilan(e.bilan);
      else process.stderr.write(e.message + "\n");
      return 2;
    }
    process.stderr.write(`erreur : ${(e as Error).message}\n`);
    return 1;
  }
}

if (process.argv[1] && /suivi(-cli)?\.(js|ts|mjs)$|hermes-control-suivi$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
