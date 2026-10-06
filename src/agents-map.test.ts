import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentsMapError, agentsMapFile, projectionOf, projectionProblem, readProjection, writeProjection } from "./agents-map.js";
import { emptyTable, sha256 } from "./assignments.js";
import { profileHome } from "./hermes.js";

let root: string;
let savedHome: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hc-agents-map-"));
  savedHome = process.env["HOME"];
  process.env["HOME"] = root;
});
afterEach(() => {
  if (savedHome) process.env["HOME"] = savedHome;
});

describe("agents.json = projection dérivée de la table (jamais une source)", () => {
  it("absent → null sans erreur ; chemin sous <compte>/.config/hermes-control ; HERMES_CONTROL_AGENTS_MAP n'est plus lue", async () => {
    expect(await readProjection()).toEqual({ projection: null, error: null });
    expect(agentsMapFile()).toBe(join(root, ".config", "hermes-control", "agents.json"));
    process.env["HERMES_CONTROL_AGENTS_MAP"] = join(root, "ailleurs", "carte.json");
    try {
      expect(agentsMapFile()).toBe(join(root, ".config", "hermes-control", "agents.json"));
    } finally {
      delete process.env["HERMES_CONTROL_AGENTS_MAP"];
    }
  });

  it("projectionOf porte schemaVersion, derivedFrom { file, sha256 } et un agent aplati (home = racine du profil)", async () => {
    const table = emptyTable();
    table.companies["co"] = { name: "ACME", instances: [join(root, "acme")] };
    table.agents["a1"] = { companyId: "co", instanceHome: join(root, "acme"), profile: "chef", name: "Chef", assignedAt: "2026-10-06T00:00:00.000Z", assignedBy: "user:u1" };
    const text = JSON.stringify(table);
    const p = projectionOf(table, "/x/assignments.json", sha256(text), profileHome);
    expect(p.schemaVersion).toBe(1);
    expect(p.derivedFrom.file).toBe("/x/assignments.json");
    expect(p.derivedFrom.sha256).toBe(sha256(text));
    expect(p.agents["a1"]).toMatchObject({ name: "Chef", companyId: "co", instance: "acme", profile: "chef", home: join(root, "acme", "profiles", "chef"), by: "user:u1" });
    await writeProjection(p);
    expect((await stat(agentsMapFile())).mode & 0o777).toBe(0o600);
    const back = await readProjection();
    expect(back.error).toBeNull();
    expect(back.projection?.agents["a1"]?.home).toBe(join(root, "acme", "profiles", "chef"));
    expect(back.projection?.companies["co"]?.instances).toEqual([join(root, "acme")]);
  });

  it("format plat de la 0.4–0.6.0 (produit par le nom) → projection ANCIENNE ignorée et signalée, fichier intact", async () => {
    await mkdir(dirname(agentsMapFile()), { recursive: true });
    const legacy = JSON.stringify({ a1: { name: "Chef", instance: "direction", profile: "default", home: "/x/direction", at: "2026-10-04T10:00:45.587Z" } }, null, 2) + "\n";
    await writeFile(agentsMapFile(), legacy);
    const r = await readProjection();
    expect(r.projection).toBeNull();
    expect(r.error).toMatch(/projection ancienne ou sans empreinte/);
    expect(await agentsMapError()).toMatch(/ancienne/);
    expect(await readFile(agentsMapFile(), "utf8")).toBe(legacy);
  });

  it("fichier corrompu ou pas un objet → erreur explicite, fichier intact", async () => {
    await mkdir(dirname(agentsMapFile()), { recursive: true });
    await writeFile(agentsMapFile(), "{ pas du json\n");
    expect((await readProjection()).error).toMatch(/corrompu/);
    expect(await readFile(agentsMapFile(), "utf8")).toBe("{ pas du json\n");
    await writeFile(agentsMapFile(), "[1,2]\n");
    expect((await readProjection()).error).toMatch(/pas un objet/);
    await writeFile(agentsMapFile(), JSON.stringify({ schemaVersion: 1, derivedFrom: { sha256: "abc" } }));
    expect((await readProjection()).error).toMatch(/sans table `agents`/);
  });

  it("projection HYBRIDE (projection 0.6 + entrées plates écrites par une 0.5 après retour arrière) → détectée, ignorée, signalée ; désynchronisée → signalée", async () => {
    const table = emptyTable();
    table.agents["a1"] = { companyId: "co", instanceHome: join(root, "acme"), profile: "chef", name: "Chef", assignedAt: "t", assignedBy: "u" };
    const p = projectionOf(table, "/x/assignments.json", sha256("t1"), profileHome);
    await writeProjection(p);
    expect(await projectionProblem(sha256("t1"))).toBeNull();
    expect(await projectionProblem(sha256("t2"))).toMatch(/désynchronisé/);
    // ce que fait rememberAgent de la 0.5 : lecture comme carte plate, ajout d'une entrée au premier niveau
    const hybrid = { ...p, "agent-0-5": { name: "Chef", instance: "acme", profile: "chef", home: "/x", at: "t" } };
    await writeFile(agentsMapFile(), JSON.stringify(hybrid));
    const r = await readProjection();
    expect(r.projection).toBeNull();
    expect(r.error).toMatch(/HYBRIDE.*1 entrée\(s\) plate\(s\).*agent-0-5/);
    expect(await projectionProblem(sha256("t1"))).toMatch(/HYBRIDE/);
    expect(await agentsMapError()).toMatch(/HYBRIDE/);
  });
});
