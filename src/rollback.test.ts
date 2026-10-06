// Retour arrière 0.6.1 → 0.5.0 : verdict par simulation de la règle du nom de la 0.5 ; écriture refusée si incompatible.
import { beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsMapFile } from "./agents-map.js";
import { assignAgent, assignmentsFile, setCompanyInstances } from "./assignments.js";
import { applyRollback, planRollback } from "./rollback.js";
import { writeRoots } from "./testkit.js";

let root: string;
let instA: string;
let instB: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hc-rb-"));
  process.env["HOME"] = root;
  instA = join(root, "inst", "a");
  instB = join(root, "inst", "b");
  for (const i of [instA, instB]) {
    await mkdir(join(i, "profiles", "chef"), { recursive: true });
    await writeFile(join(i, "config.yaml"), "model: {}\n");
    await writeFile(join(i, "profiles", "chef", "config.yaml"), "model: {}\n");
  }
  await writeRoots(join(root, "inst"));
  await setCompanyInstances("A", "A", [instA]);
  await setCompanyInstances("B", "B", [instB]);
});

describe("planRollback / applyRollback", () => {
  it("HOMONYMES : « Chef » de B affecté à b/chef, la 0.5 prendrait a/chef → INCOMPATIBLE, écriture refusée, rien ne bouge", async () => {
    await assignAgent({ agentId: "chef-a", companyId: "A", instanceHome: instA, profile: "chef", name: "Chef", assignedBy: "u" });
    await assignAgent({ agentId: "chef-b", companyId: "B", instanceHome: instB, profile: "chef", name: "Chef", assignedBy: "u" });
    const plan = await planRollback({ agentNames: { "chef-a": "Chef", "chef-b": "Chef" } });
    expect(plan.agents.find((a) => a.agentId === "chef-a")?.verdict).toBe("identique");
    expect(plan.agents.find((a) => a.agentId === "chef-b")).toMatchObject({ verdict: "autre-profil", under05: join(instA, "profiles", "chef") });
    expect(plan.compatible).toBe(false);
    const before = await readFile(agentsMapFile(), "utf8");
    await expect(applyRollback(plan)).rejects.toThrow(/retour arrière refusé.*restauration complète/);
    expect(await readFile(agentsMapFile(), "utf8")).toBe(before);
  });

  it("RENOMMÉ : l'agent s'appelle maintenant « Directeur » (export Paperclip), aucun profil de ce nom → INCOMPATIBLE", async () => {
    await assignAgent({ agentId: "chef-a", companyId: "A", instanceHome: instA, profile: "chef", name: "Chef", assignedBy: "u" });
    const plan = await planRollback({ agentNames: { "chef-a": "Directeur" } });
    expect(plan.agents[0]).toMatchObject({ verdict: "aucun-profil", nameSource: "paperclip" });
    expect(plan.compatible).toBe(false);
    // sans export des noms : la simulation ne peut pas voir le renommage → bloquant aussi (on ne conclut pas sans savoir)
    expect((await planRollback()).blockers.join(" ")).toMatch(/noms actuels des agents inconnus/);
  });

  it("COMPATIBLE : chaque agent retombe sur son profil → carte plate 0.5 écrite après sauvegarde ; la table est conservée", async () => {
    await assignAgent({ agentId: "chef-a", companyId: "A", instanceHome: instA, profile: "chef", name: "Chef", assignedBy: "u" });
    const table = await readFile(assignmentsFile(), "utf8");
    const plan = await planRollback({ agentNames: { "chef-a": "Chef" } });
    expect(plan.compatible).toBe(true);
    expect(plan.commands.join("\n")).toMatch(/paperclip-plugin-hermes-control@0\.5\.0/);
    const r = await applyRollback(plan);
    expect(r.backups.some((b) => b.includes("agents.json.bak-rollback-"))).toBe(true);
    const flat = JSON.parse(await readFile(agentsMapFile(), "utf8")) as Record<string, { home: string; profile: string }>;
    expect(flat["chef-a"]).toMatchObject({ home: join(instA, "profiles", "chef"), profile: "chef" });
    expect(Object.keys(flat)).toEqual(["chef-a"]); // carte plate : ce que la 0.5 lit (recallAgent)
    expect(await readFile(assignmentsFile(), "utf8")).toBe(table);
  });
});
