// Recette de la FRAÎCHEUR du lecteur B et de la RESTAURATION CONTRÔLÉE (revue Codex du 08/10 §1 et GO quatre chantiers
// §2). Modules réels (identites, identites-fraicheur, lock, suivi-operations, notifications) sur données FICTIVES dans un
// HOME temporaire ; aucun serveur, aucun Hermes. Chaque cas vérifie la cause STRUCTURÉE (contrat identite_inactive).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identitesFile } from "./identites.js";
import { freshnessFile, inProgressFile, markerFile, previousFile, readCurrentIdentites, setWriteFaultForTests } from "./identites-fraicheur.js";
import { enfiler, etatNotifications, notificationsDir, queueFile, rejouer } from "./notifications.js";
import { OperationRefusee, amorcer, etatEnveloppe, restaurer } from "./suivi-operations.js";
import { main as cli } from "./suivi-cli.js";

const CO = "11111111-1111-4111-8111-111111111111";
const AG = "22222222-2222-4222-8222-222222222222";
const AG2 = "33333333-3333-4333-8333-333333333333";

let home: string;
let saved: string | undefined;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hc-fraicheur-"));
  saved = process.env["HOME"];
  process.env["HOME"] = home;
});
afterEach(async () => {
  setWriteFaultForTests(null);
  if (saved) process.env["HOME"] = saved;
  await chmod(home, 0o700).catch(() => undefined);
});

type P = ReturnType<typeof fixture>;
/** Projection telle que le pack l'écrit : un agent actif, un agent retiré (pierre tombale), compteurs a=4. */
function fixture(root: string, revision: number, a = 4) {
  return {
    schemaVersion: 2, revision, envelope: { root, maxSocketPathBytes: 100 }, compteurs: { e: 1, i: 1, a },
    companies: [{ companyId: CO, alias: "e00001", name: "Fictive", statut: "actif" }],
    instances: [{ alias: "i00001", companyAlias: "e00001", section: "Direction", modelAccount: "fictif" }],
    agents: [
      { agentId: AG, companyAlias: "e00001", profileAlias: "a00001", name: "Fictif", statut: "actif", instanceAlias: "i00001" } as Record<string, unknown>,
      { agentId: AG2, companyAlias: "e00001", profileAlias: "a00002", name: "Ancien", statut: "retire" } as Record<string, unknown>,
    ],
  };
}
async function enveloppe(nom = "equipe"): Promise<string> {
  const root = join(home, nom);
  await mkdir(join(root, "donnees"), { recursive: true });
  return root;
}
const write = (root: string, p: P) => writeFile(identitesFile({ root }), JSON.stringify(p));
const read = (root: string) => readCurrentIdentites({ root });
const op = (root: string, extra: Record<string, unknown> = {}) => ({ root, operateur: "Cyril M", confirmation: root, env: {}, processus: async () => [], ...extra });
async function amorcee(nom = "equipe", rev = 10): Promise<string> {
  const root = await enveloppe(nom);
  await write(root, fixture(root, rev));
  await amorcer(op(root));
  return root;
}
async function refus(root: string) {
  const r = await read(root);
  expect(r.projection).toBeNull();
  return r.refus!;
}

describe("amorçage explicite : jamais initialisé ≠ état perdu", () => {
  it("jamais amorcée → refus suivi_non_amorce (aucun amorçage implicite) ; amorçage par l'opérateur → acceptée", async () => {
    const root = await enveloppe();
    await write(root, fixture(root, 10));
    expect(await refus(root)).toMatchObject({ schema: 1, code: "identite_inactive", cause: "suivi_non_amorce", regle: "jamais_amorce", revision: 10 });
    await expect(stat(freshnessFile())).rejects.toThrow(); // le refus n'a rien écrit
    const b = await amorcer(op(root));
    expect(b.resultat).toBe("termine");
    expect(b.avant.suivi.etat).toBe("absent");
    expect(b.apres?.entree?.revision).toBe(10);
    expect((await read(root)).projection?.revision).toBe(10);
    await expect(amorcer(op(root))).rejects.toThrow(/déjà amorcée/);
  });

  it("amorçage refusé si l'enveloppe a déjà été suivie (marqueur présent, suivi supprimé) : c'est une perte, pas une première fois", async () => {
    const root = await amorcee();
    await unlink(freshnessFile());
    await expect(amorcer(op(root))).rejects.toThrow(/marqueur d'enveloppe présent/);
  });

  it("ancien format (a1eadae) → refus explicite ; l'amorçage reprend ses maxima (compteur ancien a=6 > projection a=4 → refus)", async () => {
    const root = await enveloppe();
    await write(root, fixture(root, 10));
    await mkdir(join(home, ".config", "hermes-control"), { recursive: true });
    await writeFile(freshnessFile(), JSON.stringify({ [root]: { revision: 9, sha256: "0".repeat(64), compteurs: { e: 1, i: 1, a: 6 }, vuLe: "x" } }));
    expect(await refus(root)).toMatchObject({ cause: "etat_suivi_invalide", regle: "ancien_format" });
    await expect(amorcer(op(root))).rejects.toThrow(/compteur\(s\) d'alias en recul \(a 4 < 6\)/);
  });

  it("ancien format pour DEUX enveloppes : amorcer la première ne fait pas perdre les maxima de la seconde (sauvegarde commune)", async () => {
    const x = await enveloppe("x");
    const y = await enveloppe("y");
    await write(x, fixture(x, 10));
    await write(y, fixture(y, 10, 4));
    await mkdir(join(home, ".config", "hermes-control"), { recursive: true });
    const legacy = (r: number, a: number) => ({ revision: r, sha256: "0".repeat(64), compteurs: { e: 1, i: 1, a }, vuLe: "x" });
    await writeFile(freshnessFile(), JSON.stringify({ [x]: legacy(9, 4), [y]: legacy(9, 6) }));
    await amorcer(op(x));
    expect(await refus(y)).toMatchObject({ cause: "suivi_non_amorce" });
    await expect(amorcer(op(y))).rejects.toThrow(/a 4 < 6/);
  });
});

describe("fraîcheur : cas de la revue Codex", () => {
  it("révision suivante acceptée ; précédente refusée ; répétition conforme (état inchangé)", async () => {
    const root = await amorcee();
    await write(root, fixture(root, 11));
    expect((await read(root)).projection?.revision).toBe(11);
    await write(root, fixture(root, 10));
    expect(await refus(root)).toMatchObject({ cause: "projection_perimee", regle: "revision_inferieure", revision: 10 });
    await write(root, fixture(root, 11));
    const avant = await readFile(freshnessFile(), "utf8");
    expect((await read(root)).projection?.revision).toBe(11);
    expect((await read(root)).projection?.revision).toBe(11);
    expect(await readFile(freshnessFile(), "utf8")).toBe(avant); // répétition : rien n'est réécrit
  });

  it("état tronqué → refus explicite (jamais un état vide) pour TOUTES les enveloppes ; r9 refusée ; état non remplacé", async () => {
    const a = await amorcee("a");
    const b = await amorcee("b");
    await writeFile(freshnessFile(), "{TRONQUE");
    for (const root of [a, b]) {
      await write(root, fixture(root, 9));
      expect(await refus(root)).toMatchObject({ cause: "etat_suivi_invalide", regle: "tronque_ou_corrompu" });
    }
    expect(await readFile(freshnessFile(), "utf8")).toBe("{TRONQUE");
  });

  it("schéma invalide (compteurs négatifs) → refus etat_suivi_invalide", async () => {
    const root = await amorcee();
    const s = JSON.parse(await readFile(freshnessFile(), "utf8"));
    s.enveloppes[root].compteurs.a = -1;
    await writeFile(freshnessFile(), JSON.stringify(s));
    expect(await refus(root)).toMatchObject({ cause: "etat_suivi_invalide", regle: "schema_invalide" });
  });

  it("suivi supprimé APRÈS usage → refus (r9 et compteur abaissé ne passent plus)", async () => {
    const root = await amorcee();
    await unlink(freshnessFile());
    await write(root, fixture(root, 9, 2));
    expect(await refus(root)).toMatchObject({ cause: "etat_suivi_invalide", regle: "suivi_absent_apres_usage" });
  });

  it("marqueur d'enveloppe supprimé (enveloppe restaurée d'avant l'amorçage) → refus", async () => {
    const root = await amorcee();
    await unlink(markerFile(root));
    expect(await refus(root)).toMatchObject({ cause: "etat_suivi_invalide", regle: "marqueur_absent" });
  });

  it.skipIf(process.getuid?.() === 0)("permission refusée sur l'état de suivi → refus explicite", async () => {
    const root = await amorcee();
    await chmod(freshnessFile(), 0o000);
    try {
      expect(await refus(root)).toMatchObject({ cause: "etat_suivi_invalide", regle: "permission_refusee" });
    } finally {
      await chmod(freshnessFile(), 0o600);
    }
  });

  it("révision augmentée mais compteur abaissé → refus compteur_en_recul", async () => {
    const root = await amorcee();
    await write(root, fixture(root, 11, 3));
    expect(await refus(root)).toMatchObject({ cause: "projection_perimee", regle: "compteur_en_recul" });
  });

  it("identité retirée remise active sous une révision supérieure, compteurs inchangés → refus retiree_reactivee (et disparue → refus)", async () => {
    const root = await amorcee();
    const p = fixture(root, 11);
    p.agents[1]!["statut"] = "actif";
    p.agents[1]!["instanceAlias"] = "i00001";
    await write(root, p);
    expect(await refus(root)).toMatchObject({ cause: "projection_perimee", regle: "retiree_reactivee" });
    const q = fixture(root, 12);
    q.agents.pop();
    await write(root, q);
    expect(await refus(root)).toMatchObject({ cause: "projection_perimee", regle: "retiree_disparue" });
  });

  it("un alias qui change d'identité → refus alias_modifie", async () => {
    const root = await amorcee();
    const p = fixture(root, 11);
    p.agents[0]!["profileAlias"] = "a00003";
    p.compteurs.a = 4;
    await write(root, p);
    expect(await refus(root)).toMatchObject({ cause: "projection_perimee", regle: "alias_modifie" });
  });

  it("deux enveloppes : la révision de l'une ne protège ni ne bloque l'autre", async () => {
    const a = await amorcee("a", 10);
    const b = await amorcee("b", 3);
    await write(b, fixture(b, 4));
    expect((await read(b)).projection?.revision).toBe(4);
    await write(a, fixture(a, 9));
    expect((await refus(a)).regle).toBe("revision_inferieure");
    const s = JSON.parse(await readFile(freshnessFile(), "utf8"));
    expect([s.enveloppes[a].revision, s.enveloppes[b].revision]).toEqual([10, 4]);
  });

  it("écriture interrompue (temporaire écrit, rename jamais fait) → refus explicite, état précédent intact, puis reprise normale", async () => {
    const root = await amorcee();
    const avant = await readFile(freshnessFile(), "utf8");
    await write(root, fixture(root, 11));
    setWriteFaultForTests("suivi-avant-rename");
    expect(await refus(root)).toMatchObject({ cause: "etat_suivi_invalide", regle: "ecriture_impossible" });
    expect(await readFile(freshnessFile(), "utf8")).toBe(avant);
    setWriteFaultForTests(null);
    expect((await read(root)).projection?.revision).toBe(11);
    expect(JSON.parse(await readFile(previousFile(), "utf8")).enveloppes[root].revision).toBe(10); // .prec = version valide précédente
  });

  it("deux écritures concurrentes (deux enveloppes, révisions différentes) : aucune mise à jour perdue", async () => {
    const a = await amorcee("a", 1);
    const b = await amorcee("b", 1);
    const runs: Promise<unknown>[] = [];
    for (let r = 2; r <= 6; r++) {
      await write(a, fixture(a, r));
      await write(b, fixture(b, r));
      runs.push(read(a), read(b));
    }
    await Promise.all(runs);
    const s = JSON.parse(await readFile(freshnessFile(), "utf8"));
    expect([s.enveloppes[a].revision, s.enveloppes[b].revision]).toEqual([6, 6]);
    expect((await readdir(join(home, ".config", "hermes-control"))).filter((n) => n.endsWith(".tmp") || n.endsWith(".lock"))).toEqual([]);
  });
});

describe("restauration contrôlée (opérateur seulement)", () => {
  it("gardes : environnement d'agent, confirmation, écrivain du pack, Hermes en cours, suivi en cours d'écriture → refus sans rien modifier", async () => {
    const root = await amorcee();
    const avant = await readFile(freshnessFile(), "utf8");
    await expect(restaurer(op(root, { env: { PAPERCLIP_RUN_ID: "run-fictif" } }))).rejects.toThrow(/jamais de l'Assistant/);
    await expect(restaurer(op(root, { confirmation: root + "x" }))).rejects.toThrow(/confirmation/);
    await expect(restaurer(op(root, { processus: async () => [{ pid: 4242, hermesHome: join(root, "donnees/h/i00001/profiles/a00001") }] }))).rejects.toThrow(/Hermes tourne dans l'enveloppe \(pid 4242\)/);
    await mkdir(`${identitesFile({ root })}.lock`);
    await writeFile(join(`${identitesFile({ root })}.lock`, "owner.json"), JSON.stringify({ pid: process.pid, host: (await import("node:os")).hostname(), token: "t" }));
    await expect(restaurer(op(root))).rejects.toThrow(/écrivain du pack tient le verrou/);
    await rm(`${identitesFile({ root })}.lock`, { recursive: true });
    await mkdir(`${freshnessFile()}.lock`);
    await writeFile(join(`${freshnessFile()}.lock`, "owner.json"), JSON.stringify({ pid: process.pid, host: (await import("node:os")).hostname(), token: "t", renewedAt: new Date().toISOString() }));
    await expect(restaurer(op(root))).rejects.toThrow(/en cours d'écriture/);
    await rm(`${freshnessFile()}.lock`, { recursive: true });
    expect(await readFile(freshnessFile(), "utf8")).toBe(avant);
    await expect(stat(`${identitesFile({ root })}.lock`)).rejects.toThrow(); // verrou du pack rendu
  });

  it("CLI : amorcer/restaurer exigent un terminal (aucune confirmation par argument) ; etat rend le JSON du maximum", async () => {
    const root = await amorcee();
    expect(await cli(["restaurer", "--enveloppe", root, "--operateur", "x"])).toBe(2);
    expect(await cli(["etat", "--enveloppe", root])).toBe(0);
  });

  it("sauvegarde ancienne (r5, compteurs plus bas) → refusée contre le maximum fiable ; le pack réécrit r11 au maximum → restauration autorisée", async () => {
    const root = await amorcee("equipe", 10);
    await write(root, fixture(root, 5, 2)); // le pack remet une vieille sauvegarde
    const e = await restaurer(op(root)).catch((x: OperationRefusee) => x);
    expect(e).toBeInstanceOf(OperationRefusee);
    expect((e as OperationRefusee).message).toMatch(/maximum fiable connu \(r10, compteurs e1 i1 a4, 1 retiré\(s\)\)/);
    expect((e as OperationRefusee).bilan?.resultat).toBe("refuse");
    await expect(stat(inProgressFile(root))).rejects.toThrow();
    // révision plus haute SEULE ne suffit pas : retiré remis actif → refus
    const bad = fixture(root, 11, 4);
    bad.agents[1]!["statut"] = "actif";
    await write(root, bad);
    await expect(restaurer(op(root))).rejects.toThrow(/retiré mais au statut « actif »/);
    await write(root, fixture(root, 11, 4));
    const b = await restaurer(op(root));
    expect(b.resultat).toBe("termine");
    expect(b.maxFiable).toMatchObject({ revision: 10, compteurs: { e: 1, i: 1, a: 4 }, retires: 1 });
    expect((await read(root)).projection?.revision).toBe(11);
  });

  it("suivi corrompu : restauration autorisée — sauvegarde brute vérifiée, bilan avant/après, alias retirés conservés, compteurs au maximum (.prec), événement en file ; enveloppe non ciblée inchangée", async () => {
    const autre = await amorcee("autre", 7);
    const root = await amorcee("equipe", 10);
    await write(root, fixture(root, 11, 5)); // r11 lue → .prec garde r10, le suivi r11 a=5
    expect((await read(root)).projection?.revision).toBe(11);
    const autreMarqueur = await readFile(markerFile(autre), "utf8");
    const s0 = JSON.parse(await readFile(freshnessFile(), "utf8"));
    await writeFile(freshnessFile(), "{TRONQUE");
    // le pack remet r12 avec a=4 : refusée — le maximum perdu avec le suivi (r11, a=5) est repris de la DEUXIÈME copie
    // (marqueur d'enveloppe), pas seulement du .prec (r10, a=4) ; il réécrit r12 avec a=5
    await write(root, fixture(root, 12, 4));
    await expect(restaurer(op(root))).rejects.toThrow(/maximum fiable connu \(r11, compteurs e1 i1 a5/);
    await write(root, fixture(root, 12, 5));
    const b = await restaurer(op(root));
    expect(b.avant.suivi.etat).toBe("tronque_ou_corrompu");
    expect(b.sauvegarde?.fichiers.map((f) => f.nom).sort()).toEqual(["identites-vues.json", "identites-vues.json.prec", "identites.json", "marqueur.json"]);
    for (const f of b.sauvegarde!.fichiers) expect((await readFile(join(b.sauvegarde!.dossier, f.nom))).length).toBe(f.octets);
    expect(await readFile(join(b.sauvegarde!.dossier, "identites-vues.json"), "utf8")).toBe("{TRONQUE");
    expect(b.apres?.suivi.etat).toBe("ok");
    expect(b.apres?.marqueur.coherent).toBe(true);
    expect(b.maxFiable?.sources.join(" ")).toMatch(/\.prec.*marqueur d'enveloppe/);
    const s = JSON.parse(await readFile(freshnessFile(), "utf8"));
    expect(s.enveloppes[root].retires.agents).toEqual([AG2]);
    expect(s.enveloppes[root].compteurs.a).toBe(5);
    expect(s.enveloppes[root].restaurations).toBe(1);
    // enveloppe non ciblée : son entrée était dans le fichier corrompu → protégée (refus), jamais vidée en silence
    expect(s.enveloppes[autre]).toBeUndefined();
    expect(await readFile(markerFile(autre), "utf8")).toBe(autreMarqueur);
    expect(await refus(autre)).toMatchObject({ cause: "etat_suivi_invalide", regle: "enveloppe_absente_du_suivi" });
    // … puis sa réinitialisation CIBLÉE reprend son maximum (marqueur, .prec, bilan d'amorçage) ; r7 déjà lue → acceptée
    const b2 = await restaurer(op(autre));
    expect(b2.resultat).toBe("termine");
    expect(JSON.parse(await readFile(freshnessFile(), "utf8")).enveloppes[root]).toEqual(s.enveloppes[root]); // la 1re n'a pas bougé
    expect(s0.enveloppes[autre].revision).toBe(7);
    // événement « restauration » en file, sans secret, affichable à l'opérateur
    const n = await etatNotifications();
    expect(n.enAttente.map((e) => e.type)).toEqual(["restauration", "restauration"]);
    expect(n.enAttente[0]!.preuve).toBe(join(b.sauvegarde!.dossier, "bilan.json"));
  });

  it("restauration interrompue (après le marqueur) : les lecteurs refusent ; reprise → terminée, un seul événement", async () => {
    const root = await amorcee();
    await unlink(freshnessFile());
    await write(root, fixture(root, 11));
    await expect(restaurer(op(root, { arretApres: "marqueur_ecrit" }))).rejects.toThrow(/interruption simulée/);
    expect(await refus(root)).toMatchObject({ cause: "etat_suivi_invalide", regle: "restauration_en_cours" });
    expect((await etatEnveloppe(root)).operationEnCours).toMatchObject({ type: "restauration", phase: "marqueur_ecrit" });
    await expect(amorcer(op(root))).rejects.toThrow(/« restauration » interrompue est en cours/);
    const b = await restaurer(op(root));
    expect(b).toMatchObject({ resultat: "termine", reprises: 1 });
    expect((await read(root)).projection?.revision).toBe(11);
    expect((await etatNotifications()).enAttente).toHaveLength(1);
  });

  it("restauration interrompue après la sauvegarde puis après le suivi : chaque reprise termine sans double sauvegarde", async () => {
    const root = await amorcee();
    await write(root, fixture(root, 11));
    await expect(restaurer(op(root, { arretApres: "sauvegardee" }))).rejects.toThrow(/interruption/);
    await expect(restaurer(op(root, { arretApres: "suivi_ecrit" }))).rejects.toThrow(/interruption/);
    const b = await restaurer(op(root));
    expect(b.reprises).toBe(2);
    const ops = await readdir(join(home, ".config", "hermes-control", "restaurations", (await import("./identites-fraicheur.js")).envelopeKey(root)));
    expect(ops).toHaveLength(2); // amorçage + UNE restauration
  });

  it("aucune référence fiable → refus, sauf minimums de l'opérateur (consignés)", async () => {
    const root = await enveloppe();
    await write(root, fixture(root, 3));
    await writeMarker(root);
    await expect(restaurer(op(root))).rejects.toThrow(/aucune référence fiable/);
    await expect(restaurer(op(root, { minimums: { revision: 5, a: 4 } }))).rejects.toThrow(/révision r3 < r5/);
    await write(root, fixture(root, 6));
    const b = await restaurer(op(root, { minimums: { revision: 5, a: 4 } }));
    expect(b.maxFiable?.sources).toContain("minimums de l'opérateur");
  });
});

async function writeMarker(root: string) {
  await writeFile(markerFile(root), JSON.stringify({ schema: 1, root, marqueur: "ab".repeat(16), ecritLe: "x", par: "test" }));
}

describe("notification au Chef : file bornée, perte visible et rejouable", () => {
  it("file pleine → la perte est inscrite ; rejouer remet l'événement depuis le bilan (preuve conservée)", async () => {
    const root = await amorcee();
    await write(root, fixture(root, 11));
    const b = await restaurer(op(root));
    const id = b.evenement!.id;
    for (let k = 0; k < 3; k++) await enfiler({ ...b.evenement!, id: `bruit-${k}` }, 2);
    const n = await etatNotifications();
    expect(n.enAttente.map((e) => e.id)).not.toContain(id);
    expect(n.pertes.map((p) => p.id)).toContain(id);
    expect(await rejouer()).toEqual([id]);
    const n2 = await etatNotifications();
    expect(n2.enAttente.map((e) => e.id)).toContain(id);
    expect(n2.pertes.map((p) => p.id)).not.toContain(id);
  });

  it("notification impossible à écrire → restauration faite et prouvée, notification NON écrite signalée, rejouable ensuite", async () => {
    const root = await amorcee();
    await write(root, fixture(root, 11));
    await mkdir(join(home, ".config", "hermes-control"), { recursive: true });
    await writeFile(notificationsDir(), "pas un dossier");
    const b = await restaurer(op(root));
    expect(b.resultat).toBe("termine");
    expect(b.notification).toMatchObject({ ecrite: false });
    expect((await read(root)).projection?.revision).toBe(11);
    await unlink(notificationsDir());
    expect(await rejouer()).toEqual([b.evenement!.id]);
    expect((await readFile(queueFile(), "utf8")).trim().split("\n")).toHaveLength(1);
  });
});
