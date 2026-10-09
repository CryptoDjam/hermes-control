// 10/10 : libellés de la page Hermes (défaut n° 6 : « default » pris pour un second Chef), amorcer --confirmation (défaut n° 3),
// catalogue de modèles complet du fournisseur connecté (point 12). Données fictives, HOME temporaire.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HermesInstance, HermesProfile } from "./hermes.js";
import { compareModelIds, readModelsDevCatalog } from "./hermes.js";
import { identitesFile, type Projection } from "./identites.js";
import { LIBELLE_CONNEXION_SECTION, decorerInstances } from "./libelles.js";
import { main } from "./suivi-cli.js";
import { hermesModels } from "../adapter/src/index.js";

const CO = "11111111-1111-4111-8111-111111111111";
const CHEF = "22222222-2222-4222-8222-222222222222";
const ASSIST = "33333333-3333-4333-8333-333333333333";
const prof = (name: string, home: string, model = "gpt-5.6-luna"): HermesProfile => ({ name, home, description: null, model, provider: "openai-codex", authStatus: "unknown", approvalsMode: null, terminalBackend: null, toolsets: [], configError: null });
const projection = (root: string): Projection => ({ schemaVersion: 2, revision: 3, envelope: { root, maxSocketPathBytes: 100 }, compteurs: { e: 1, i: 1, a: 2 }, companies: [{ companyId: CO, alias: "e00001", name: "Fictive", statut: "actif" }], instances: [{ alias: "i00001", companyAlias: "e00001", section: "direction", modelAccount: "openai-codex:oauth" }], agents: [{ agentId: ASSIST, companyAlias: "e00001", profileAlias: "a00002", name: "Assistant", statut: "actif", instanceAlias: "i00001" }, { agentId: CHEF, companyAlias: "e00001", profileAlias: "a00001", name: "Chef", statut: "actif", instanceAlias: "i00001" }] });

describe("libellés de la page Hermes", () => {
  it("instance « direction (i00001) », racine « direction — connexion de la section », agents nommés, Chef en premier, racine en dernier", () => {
    const home = "/e/donnees/h/i00001";
    const inst: HermesInstance = { name: "i00001", home, launcher: null, dashboardUrl: null, errors24h: 0, lastError: null, profiles: [prof("default", home), prof("a00002", `${home}/profiles/a00002`), prof("a00001", `${home}/profiles/a00001`)] };
    const [d] = decorerInstances([inst], projection("/e"), new Map([[CHEF, "ceo"], [ASSIST, "general"]]));
    expect(d!.label).toBe("direction (i00001)");
    expect(d!.section).toBe("direction");
    expect(d!.profiles.map((p) => [p.name, p.label, p.role])).toEqual([["a00001", "Chef (a00001)", "ceo"], ["a00002", "Assistant (a00002)", "general"], ["default", `direction — ${LIBELLE_CONNEXION_SECTION}`, null]]);
    expect(d!.profiles.find((p) => p.name === "default")!.label).not.toBe("default");
  });
  it("sans projection (instance hors pack) : noms du disque inchangés, rien n'est inventé", () => {
    const home = "/x/autre";
    const inst: HermesInstance = { name: "autre", home, launcher: null, dashboardUrl: null, errors24h: 0, lastError: null, profiles: [prof("default", home), prof("bob", `${home}/profiles/bob`)] };
    const [d] = decorerInstances([inst], null);
    expect(d!.label).toBe("autre");
    expect(d!.profiles.map((p) => p.label)).toEqual(["bob", "default"]);
  });
});

describe("hermes-control-suivi amorcer --confirmation (confirmation portée par l'appelant, sans terminal)", () => {
  let home: string;
  let saved: string | undefined;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "hc-conf-"));
    saved = process.env["HOME"];
    process.env["HOME"] = home;
  });
  afterEach(async () => {
    if (saved) process.env["HOME"] = saved;
    await rm(home, { recursive: true, force: true });
  });
  it("chemin exact → amorçage fait (code 0) ; chemin différent → refus (2), rien d'écrit ; restaurer --confirmation → refus", async () => {
    const root = join(home, "Equipe");
    await mkdir(join(root, "donnees"), { recursive: true });
    await writeFile(identitesFile({ root }), JSON.stringify(projection(root)));
    const sorties: string[] = [];
    const w = process.stdout.write.bind(process.stdout);
    const we = process.stderr.write.bind(process.stderr);
    (process.stdout as { write: unknown }).write = (s: string) => (sorties.push(String(s)), true);
    (process.stderr as { write: unknown }).write = (s: string) => (sorties.push(String(s)), true);
    try {
      expect(await main(["amorcer", "--enveloppe", root, "--operateur", "init-yes", "--confirmation", `${root}-autre`])).toBe(2);
      expect(sorties.join("")).toMatch(/chemin exact de l'enveloppe/);
      expect(await main(["restaurer", "--enveloppe", root, "--operateur", "init-yes", "--confirmation", root])).toBe(2);
      expect(sorties.join("")).toMatch(/--confirmation n'existe que pour amorcer/);
      const etatAvant = JSON.parse(((await main(["etat", "--enveloppe", root]), sorties.pop()) as string)) as { enveloppe: { suivi: { etat: string } } };
      expect(etatAvant.enveloppe.suivi.etat).toBe("absent"); // les refus n'ont rien écrit
      expect(await main(["amorcer", "--enveloppe", root, "--operateur", "init-yes", "--confirmation", root])).toBe(0);
      expect(sorties.join("")).toMatch(/amorcage TERMINE/);
      const etatApres = JSON.parse(((await main(["etat", "--enveloppe", root]), sorties.pop()) as string)) as { enveloppe: { suivi: { etat: string }; marqueur: { etat: string } } };
      expect([etatApres.enveloppe.suivi.etat, etatApres.enveloppe.marqueur.etat]).toEqual(["ok", "ok"]);
    } finally {
      (process.stdout as { write: unknown }).write = w;
      (process.stderr as { write: unknown }).write = we;
    }
  });
});

describe("catalogue de modèles du fournisseur connecté (point 12)", () => {
  it("repli models_dev_cache.json (profil ou instance) : openai-codex → entrée « openai », modèles de conversation/code seulement, récents d'abord ; modèle courant en tête ; provider_models_cache.json prioritaire", async () => {
    const home = await mkdtemp(join(tmpdir(), "hc-models-"));
    await mkdir(join(home, "profiles", "a00001"), { recursive: true });
    const fictif = { openai: { id: "openai", models: { "gpt-5.6-luna": {}, "gpt-6-astra": {}, "gpt-5.5": {}, "gpt-image-2": {}, "text-embedding-3-small": {}, "gpt-realtime-2.1": {}, "o3-mini": {}, "gpt-5.3-codex": {}, "gpt-5.2-chat-latest": {} } }, anthropic: { id: "anthropic", models: { "claude-opus-5": {} } } };
    await writeFile(join(home, "profiles", "a00001", "models_dev_cache.json"), JSON.stringify(fictif));
    const cat = await readModelsDevCatalog(home, "openai-codex");
    expect(cat).toEqual(["gpt-6-astra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.3-codex", "o3-mini"]);
    expect(await readModelsDevCatalog(home, "anthropic")).toEqual([]); // claude-* : pas un modèle gpt/o/codex (filtre), rien d'inventé
    expect(["gpt-5.5", "gpt-6-astra", "gpt-5.6-luna", "o3-mini"].sort(compareModelIds)).toEqual(["gpt-6-astra", "gpt-5.6-luna", "gpt-5.5", "o3-mini"]);
    const inst: HermesInstance = { name: "i00001", home, launcher: null, dashboardUrl: null, errors24h: 0, lastError: null, profiles: [prof("default", home), prof("a00001", join(home, "profiles", "a00001"))] };
    const list = await hermesModels([inst]);
    expect(list.map((m) => m.id)).toEqual(["gpt-5.6-luna", "gpt-6-astra", "gpt-5.5", "gpt-5.3-codex", "o3-mini"]); // courant en tête, puis le catalogue
    // le catalogue vivant écrit par Hermes a priorité
    await writeFile(join(home, "provider_models_cache.json"), JSON.stringify({ "openai-codex": { models: ["gpt-6-astra", "gpt-5.6-luna", "gpt-5.5-codex"] } }));
    expect((await hermesModels([inst])).map((m) => m.id)).toEqual(["gpt-5.6-luna", "gpt-6-astra", "gpt-5.5-codex"]);
    expect(await readFile(join(home, "provider_models_cache.json"), "utf8")).toContain("gpt-5.5-codex"); // rien n'est écrit par la lecture
    await rm(home, { recursive: true, force: true });
  });
});
