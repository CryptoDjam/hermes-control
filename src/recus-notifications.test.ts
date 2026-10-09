// Recette du REÇU DURABLE d'acquittement (revue Codex du 08/10 §5) : module réel notifications.ts, données FICTIVES dans
// un compte temporaire ; aucun notifier réel, aucun appel réseau.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlDir, setAccountHomeResolverForTests } from "./paths.js";
import { ConsommateurFichier, type Consommateur, type Evenement, type Ticket, acquitter, enfiler, etatNotifications, livrer, lireRecu, notificationsDir, queueFile, recuFile, rejouer } from "./notifications.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hc-recus-"));
  setAccountHomeResolverForTests(() => home);
});
afterEach(async () => {
  setAccountHomeResolverForTests(null);
  await rm(home, { recursive: true, force: true });
});

const compte = { revision: 1, compteurs: { e: 1, i: 1, a: 1 } };
/** Bilan conservé + événement « restauration » fictif n°i. */
async function bilan(i: number): Promise<Evenement> {
  const dossier = join(controlDir(), "restaurations", "enveloppe-fictive", `op-${String(i).padStart(5, "0")}`);
  await mkdir(dossier, { recursive: true });
  const ev: Evenement = { schema: 1, id: `restauration-fictive-${i}`, type: "restauration", at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(), root: join(home, "travail"), operateur: "operateur-fictif", resume: "fixture sans secret", preuve: join(dossier, "bilan.json"), avant: compte, apres: compte };
  await writeFile(ev.preuve, JSON.stringify({ resultat: "termine", evenement: ev }));
  return ev;
}
const ticketsDir = () => join(home, "consommateur", "tickets");
/** Consommateur qui compte ses créations (relation persistante = ConsommateurFichier). */
function compteur(): Consommateur & { crees: string[] } {
  const base = new ConsommateurFichier(ticketsDir());
  const crees: string[] = [];
  return { nom: base.nom, crees, trouver: (id) => base.trouver(id), creer: async (ev) => { crees.push(ev.id); return base.creer(ev); } };
}

describe("reçu durable : aucune réapparition après de nombreux acquittements", () => {
  it("501 puis 1001 acquittements opérateur → rejouer ne remet rien ; un reçu par événement, lié à son bilan", async () => {
    for (let i = 0; i < 1001; i++) {
      const ev = await bilan(i);
      await enfiler(ev);
      expect(await acquitter(ev.id)).toBe(true);
      if (i === 500) expect(await rejouer()).toEqual([]);
    }
    expect(await rejouer()).toEqual([]);
    const n = await etatNotifications();
    expect(n.enAttente).toHaveLength(0);
    expect(n.recus).toBe(1001);
    const r0 = await lireRecu("restauration-fictive-0");
    expect(r0).toMatchObject({ source: "operateur", bilan: (await bilan(0)).preuve });
    expect(r0!.bilanSha256).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);

  it("1001 livraisons par le consommateur → aucune réapparition, un seul ticket par ID", async () => {
    const c = compteur();
    for (let i = 0; i < 1001; i++) {
      await enfiler(await bilan(i));
      if (i % 100 === 99 || i === 1000) await livrer(c);
    }
    expect(await rejouer()).toEqual([]);
    expect(await livrer(c)).toEqual({ livres: [], echecs: [] });
    expect(c.crees).toHaveLength(1001);
    expect(new Set(c.crees).size).toBe(1001);
    expect((await readdir(ticketsDir())).filter((f) => f.endsWith(".json"))).toHaveLength(1001);
  }, 120_000);
});

describe("rejeu, débordement et reprise", () => {
  it("un événement jamais livré reste rejouable (file effacée, puis bilan relu)", async () => {
    const ev = await bilan(1);
    await enfiler(ev);
    await rm(queueFile());
    expect((await etatNotifications()).enAttente).toHaveLength(0);
    expect(await rejouer()).toEqual([ev.id]);
    expect((await etatNotifications()).enAttente.map((e) => e.id)).toEqual([ev.id]);
  });

  it("débordement visible : pertes inscrites et compteur non borné ; les sortis restent rejouables", async () => {
    for (let i = 0; i < 5; i++) await enfiler(await bilan(i), 2);
    const n = await etatNotifications();
    expect(n.enAttente.map((e) => e.id)).toEqual(["restauration-fictive-3", "restauration-fictive-4"]);
    expect(n.debordements).toBe(3);
    expect(n.pertes.map((p) => p.id)).toEqual(["restauration-fictive-0", "restauration-fictive-1", "restauration-fictive-2"]);
    const c = compteur();
    await livrer(c);
    expect((await rejouer()).sort()).toEqual(["restauration-fictive-0", "restauration-fictive-1", "restauration-fictive-2"]);
    await livrer(c);
    expect(new Set(c.crees).size).toBe(5);
    expect(c.crees).toHaveLength(5);
    expect(await rejouer()).toEqual([]);
    expect((await etatNotifications()).debordements).toBe(3);
  });

  it("reprise après redémarrage : module rechargé, état relu du disque, rien de perdu ni de doublé", async () => {
    const a = await bilan(1);
    const b = await bilan(2);
    await enfiler(a);
    await enfiler(b);
    await livrer(compteur()); // a et b livrés
    const c = await bilan(3);
    await enfiler(c);
    vi.resetModules();
    const m = await import("./notifications.js");
    const p = await import("./paths.js");
    p.setAccountHomeResolverForTests(() => home);
    expect(await m.rejouer()).toEqual([]);
    expect((await m.etatNotifications()).enAttente.map((e) => e.id)).toEqual([c.id]);
    const base = new m.ConsommateurFichier(ticketsDir());
    const crees: string[] = [];
    const r = await m.livrer({ nom: base.nom, trouver: (id) => base.trouver(id), creer: async (ev) => { crees.push(ev.id); return base.creer(ev); } });
    expect(r.livres.map((x) => x.id)).toEqual([c.id]);
    expect(crees).toEqual([c.id]);
    p.setAccountHomeResolverForTests(null);
  });

  it("livraison confirmée puis panne avant le reçu → reprise sans second ticket, reçu écrit ensuite", async () => {
    const ev = await bilan(7);
    await enfiler(ev);
    const c = compteur();
    await expect(livrer(c, { avantRecu: async () => { throw new Error("panne simulée entre livraison et reçu"); } })).rejects.toThrow(/panne simulée/);
    expect(await lireRecu(ev.id)).toBeNull();
    expect((await etatNotifications()).enAttente.map((e) => e.id)).toEqual([ev.id]);
    // redémarrage : rejouer ne double pas, livrer retrouve le ticket
    expect(await rejouer()).toEqual([]);
    const r = await livrer(c);
    expect(r.livres).toEqual([{ id: ev.id, ticket: expect.objectContaining({ consommateur: "fichier" }) as Ticket, repris: true }]);
    expect(c.crees).toEqual([ev.id]);
    const recu = await lireRecu(ev.id);
    expect(recu).toMatchObject({ source: "notifier", ticket: r.livres[0]!.ticket });
    expect(recu!.livreLe).not.toBeNull();
  });

  it("échec du consommateur → événement laissé en file, aucun reçu ; livré au passage suivant", async () => {
    const ev = await bilan(8);
    await enfiler(ev);
    const base = compteur();
    let panne = true;
    const c: Consommateur = { nom: "fichier", trouver: base.trouver, creer: async (e) => { if (panne) throw new Error("injoignable"); return base.creer(e); } };
    expect((await livrer(c)).echecs.map((x) => x.id)).toEqual([ev.id]);
    expect(await lireRecu(ev.id)).toBeNull();
    panne = false;
    expect((await livrer(c)).livres.map((x) => x.id)).toEqual([ev.id]);
    expect(base.crees).toEqual([ev.id]);
  });

  it("un seul ticket par ID : rejouer + livrer répétés, enfiler du même événement après reçu refusé", async () => {
    const ev = await bilan(9);
    const c = compteur();
    for (let k = 0; k < 5; k++) {
      await enfiler(ev);
      await rejouer();
      await livrer(c);
    }
    expect(c.crees).toEqual([ev.id]);
    expect((await enfiler(ev)).ajoute).toBe(false);
  });

  it("deux consommateurs concurrents sur le même dossier de tickets : un seul ticket créé", async () => {
    const ev = await bilan(10);
    const a = new ConsommateurFichier(ticketsDir());
    const [t1, t2] = await Promise.all([a.creer(ev), a.creer(ev)]);
    expect(t1.ref).toBe(t2.ref);
    expect(await readdir(ticketsDir())).toHaveLength(1);
  });
});

describe("compatibilité et garde-fous", () => {
  it("ancien etat.json (schéma 1, acquittes) : les acquittés ne réapparaissent pas et deviennent des reçus « migration »", async () => {
    const ev = await bilan(1);
    const autre = await bilan(2);
    await mkdir(notificationsDir(), { recursive: true });
    await writeFile(join(notificationsDir(), "etat.json"), JSON.stringify({ schema: 1, acquittes: [ev.id], pertes: [] }));
    expect(await rejouer()).toEqual([autre.id]);
    expect(await lireRecu(ev.id)).toMatchObject({ source: "migration" });
    const etat = JSON.parse(await readFile(join(notificationsDir(), "etat.json"), "utf8")) as { schema: number; acquittesHerites: string[] };
    expect(etat.schema).toBe(2);
    expect(etat.acquittesHerites).toEqual([]);
  });

  it("preuve hors du dossier des bilans ou id dangereux : refus ou clé hachée", async () => {
    const ev = await bilan(1);
    await expect(enfiler({ ...ev, preuve: join(home, "ailleurs", "bilan.json") })).rejects.toThrow(/preuve hors du dossier/);
    await expect(enfiler({ ...ev, preuve: join(controlDir(), "restaurations", "x", "autre.json") })).rejects.toThrow(/preuve hors du dossier/);
    await expect(enfiler({ ...ev, preuve: join(controlDir(), "restaurations", "..", "bilan.json").replace("/restaurations/..", "/restaurations/../restaurations/..") })).rejects.toThrow(/preuve hors du dossier/);
    const bizarre = { ...ev, id: "../../evil/id" };
    expect(recuFile(bizarre.id)).toMatch(/recus\/h-[0-9a-f]{64}\.json$/);
    await enfiler(bizarre);
    expect(await acquitter(bizarre.id)).toBe(true);
    expect(await lireRecu(bizarre.id)).toMatchObject({ id: bizarre.id });
  });

  it("reçu illisible : l'événement redevient rejouable, et la relation du consommateur empêche le second ticket", async () => {
    const ev = await bilan(1);
    const c = compteur();
    await enfiler(ev);
    await livrer(c);
    await writeFile(recuFile(ev.id), "{tronqué");
    expect(await rejouer()).toEqual([ev.id]);
    const r = await livrer(c);
    expect(r.livres[0]).toMatchObject({ id: ev.id, repris: true });
    expect(c.crees).toEqual([ev.id]);
  });
});
