// Amorçage EXPLICITE gardé (décision du 09/10, revue Codex du 08/10) : installation neuve, amorçage relancé, suivi supprimé
// ou tronqué APRÈS usage, marqueur supprimé, tout supprimé sauf l'historique. Aucune remise à zéro silencieuse : l'état
// existant n'est jamais réécrit par un amorçage refusé, et les lecteurs continuent de refuser. Données FICTIVES, HOME
// temporaire. L'état rendu par `hermes-control-suivi etat` est celui que lit le pack (decisionAmorcage).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identitesFile } from "./identites.js";
import { freshnessFile, markerFile, readCurrentIdentites } from "./identites-fraicheur.js";
import { amorcer, etatEnveloppe, historique } from "./suivi-operations.js";

const CO = "11111111-1111-4111-8111-111111111111";
const AG = "22222222-2222-4222-8222-222222222222";
let home: string;
let saved: string | undefined;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hc-amorce-"));
  saved = process.env["HOME"];
  process.env["HOME"] = home;
});
afterEach(async () => {
  if (saved) process.env["HOME"] = saved;
  await rm(home, { recursive: true, force: true });
});
const projection = (root: string, revision: number) => ({
  schemaVersion: 2, revision, envelope: { root, maxSocketPathBytes: 100 }, compteurs: { e: 1, i: 1, a: 1 },
  companies: [{ companyId: CO, alias: "e00001", name: "Fictive", statut: "actif" }],
  instances: [{ alias: "i00001", companyAlias: "e00001", section: "Direction", modelAccount: "fictif" }],
  agents: [{ agentId: AG, companyAlias: "e00001", profileAlias: "a00001", name: "Fictif", statut: "actif", instanceAlias: "i00001" }],
});
const op = (root: string) => ({ root, operateur: "operateur-fictif", confirmation: root, env: {}, processus: async () => [] });
async function neuve(): Promise<string> {
  const root = join(home, "Equipe");
  await mkdir(join(root, "donnees"), { recursive: true });
  await writeFile(identitesFile({ root }), JSON.stringify(projection(root, 5)));
  return root;
}
const octets = async (f: string) => readFile(f).then((b) => b.toString("base64"), () => null);

describe("amorçage explicite", () => {
  it("installation neuve : état « absent/absent », amorçage accepté, état « ok/ok » ensuite", async () => {
    const root = await neuve();
    const avant = await etatEnveloppe(root);
    expect([avant.suivi.etat, avant.marqueur.etat]).toEqual(["absent", "absent"]);
    expect((await amorcer(op(root))).resultat).toBe("termine");
    const apres = await etatEnveloppe(root);
    expect([apres.suivi.etat, apres.marqueur.etat, apres.marqueur.coherent]).toEqual(["ok", "ok", true]);
    expect((await readCurrentIdentites({ root })).projection?.revision).toBe(5);
  });

  it("amorçage relancé (init relancé) : refusé, suivi et marqueur inchangés octet pour octet", async () => {
    const root = await neuve();
    await amorcer(op(root));
    const s = await octets(freshnessFile());
    const m = await octets(markerFile(root));
    await expect(amorcer(op(root))).rejects.toThrow(/déjà amorcée/);
    expect(await octets(freshnessFile())).toBe(s);
    expect(await octets(markerFile(root))).toBe(m);
  });

  it("suivi supprimé après usage : état « absent/ok », amorçage refusé, rien n'est recréé, les lecteurs refusent", async () => {
    const root = await neuve();
    await amorcer(op(root));
    await unlink(freshnessFile());
    const e = await etatEnveloppe(root);
    expect([e.suivi.etat, e.marqueur.etat]).toEqual(["absent", "ok"]);
    await expect(amorcer(op(root))).rejects.toThrow(/marqueur d'enveloppe présent/);
    await expect(stat(freshnessFile())).rejects.toThrow();
    expect((await readCurrentIdentites({ root })).refus).toMatchObject({ cause: "etat_suivi_invalide" });
  });

  it("suivi tronqué après usage : amorçage refusé, fichier tronqué laissé tel quel (jamais remplacé par un état vide)", async () => {
    const root = await neuve();
    await amorcer(op(root));
    const t = (await readFile(freshnessFile(), "utf8")).slice(0, 40);
    await writeFile(freshnessFile(), t);
    const e = await etatEnveloppe(root);
    expect(e.suivi.etat).not.toBe("ok");
    await expect(amorcer(op(root))).rejects.toThrow(/l'amorçage ne remplace jamais un état existant|marqueur d'enveloppe présent/);
    expect(await readFile(freshnessFile(), "utf8")).toBe(t);
    expect((await readCurrentIdentites({ root })).refus).toMatchObject({ cause: "etat_suivi_invalide" });
  });

  it("marqueur supprimé, suivi intact : amorçage refusé (enveloppe déjà connue du suivi)", async () => {
    const root = await neuve();
    await amorcer(op(root));
    await unlink(markerFile(root));
    expect((await etatEnveloppe(root)).marqueur.etat).toBe("absent");
    await expect(amorcer(op(root))).rejects.toThrow(/déjà amorcée/);
  });

  it("suivi ET marqueur supprimés après usage, historique conservé : amorçage refusé (une perte n'est jamais une première fois)", async () => {
    const root = await neuve();
    await amorcer(op(root));
    expect((await historique(root)).length).toBeGreaterThan(0);
    await unlink(freshnessFile());
    await unlink(markerFile(root));
    await expect(amorcer(op(root))).rejects.toThrow(/déjà été suivie|historique/);
    await expect(stat(freshnessFile())).rejects.toThrow();
  });
});
