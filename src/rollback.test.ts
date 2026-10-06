// Retour arrière 0.6.1 → 0.5.0 : verdict par simulation de la règle du nom de la 0.5 ; écriture refusée si incompatible.
import { beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsMapFile } from "./agents-map.js";
import { assignAgent, assignmentsFile, setCompanyInstances } from "./assignments.js";
import { RollbackRefused, applyRollback, checkExport, planRollback } from "./rollback.js";
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

type Ag = { id: string; name: string; companyId: string; adapterType: string };
/** Export conforme (scripts/export-agents.mjs) pour une liste d'agents. */
function exportOf(agents: Ag[], at = new Date()) {
  const cos = [...new Set(["A", "B", ...agents.map((a) => a.companyId)])];
  return { kind: "hermes-control/agents-export", version: 1, collectedAt: at.toISOString(), source: { api: "test", method: "test" }, collector: { instanceAdmin: true, check: "test" }, companies: cos.map((id) => ({ id, name: id, agentCount: agents.filter((a) => a.companyId === id).length })), agents };
}
const H = (id: string, name: string, companyId: string): Ag => ({ id, name, companyId, adapterType: "hermes_local" });

describe("planRollback / applyRollback (0.6.2 : inventaire complet obligatoire)", () => {
  it("HOMONYMES : « Chef » de B affecté à b/chef, la 0.5 prendrait a/chef → INCOMPATIBLE, écriture refusée (erreur typée), rien ne bouge", async () => {
    await assignAgent({ agentId: "chef-a", companyId: "A", instanceHome: instA, profile: "chef", name: "Chef", assignedBy: "u" });
    await assignAgent({ agentId: "chef-b", companyId: "B", instanceHome: instB, profile: "chef", name: "Chef", assignedBy: "u" });
    const plan = await planRollback({ exportData: exportOf([H("chef-a", "Chef", "A"), H("chef-b", "Chef", "B")]) });
    expect(plan.agents.find((a) => a.agentId === "chef-a")?.verdict).toBe("identique");
    expect(plan.agents.find((a) => a.agentId === "chef-b")).toMatchObject({ verdict: "autre-profil", under05: join(instA, "profiles", "chef") });
    expect(plan.compatible).toBe(false);
    const before = await readFile(agentsMapFile(), "utf8");
    await expect(applyRollback(plan)).rejects.toBeInstanceOf(RollbackRefused);
    await expect(applyRollback(plan)).rejects.toThrow(/retour arrière refusé.*restauration complète/);
    expect(await readFile(agentsMapFile(), "utf8")).toBe(before);
  });

  it("LE CAS DE LA RECETTE 0.6.1 : Chef de B désaffecté mais toujours hermes_local → la 0.5 le ferait tourner dans a/chef → INCOMPATIBLE", async () => {
    await assignAgent({ agentId: "chef-a", companyId: "A", instanceHome: instA, profile: "chef", name: "Chef", assignedBy: "u" });
    const plan = await planRollback({ exportData: exportOf([H("chef-a", "Chef", "A"), H("chef-b", "Chef", "B")]) });
    expect(plan.agents.find((a) => a.agentId === "chef-b")).toMatchObject({ verdict: "non-affecte-retrouve", assigned: null, under05: join(instA, "profiles", "chef") });
    expect(plan.compatible).toBe(false);
    expect(plan.blockers.join("\n")).toMatch(/NON affecté en 0\.6.*la 0\.5 le ferait tourner/);
    expect(plan.coverage).toMatchObject({ hermesAgents: 2, assignedInTable: 1, assignedFoundInExport: 1 });
  });

  it("non affecté SANS profil retrouvable : simple avertissement ; agent d'un autre type ignoré", async () => {
    await assignAgent({ agentId: "chef-a", companyId: "A", instanceHome: instA, profile: "chef", name: "Chef", assignedBy: "u" });
    const plan = await planRollback({ exportData: exportOf([H("chef-a", "Chef", "A"), H("x", "Personne", "B"), { id: "cl", name: "Chef", companyId: "B", adapterType: "claude_local" }]) });
    expect(plan.agents.map((a) => a.verdict).sort()).toEqual(["identique", "non-affecte-sans-profil"]);
    expect(plan.compatible).toBe(true);
    expect(plan.warnings.join(" ")).toMatch(/Personne.*aucun profil/);
  });

  it("RENOMMÉ : l'agent s'appelle maintenant « Directeur » → INCOMPATIBLE", async () => {
    await assignAgent({ agentId: "chef-a", companyId: "A", instanceHome: instA, profile: "chef", name: "Chef", assignedBy: "u" });
    const plan = await planRollback({ exportData: exportOf([H("chef-a", "Directeur", "A")]) });
    expect(plan.agents[0]).toMatchObject({ verdict: "aucun-profil", nameSource: "paperclip" });
    expect(plan.compatible).toBe(false);
  });

  it("export ABSENT, non reconnu (simple liste), PÉRIMÉ, antérieur à la table, incomplet, doublon, type / entreprise manquants, agent de la table absent → refus", async () => {
    await assignAgent({ agentId: "chef-a", companyId: "A", instanceHome: instA, profile: "chef", name: "Chef", assignedBy: "u" });
    expect((await planRollback()).blockers.join(" ")).toMatch(/export des agents Paperclip ABSENT/);
    expect((await planRollback({ exportData: [{ id: "chef-a", name: "Chef" }] })).blockers.join(" ")).toMatch(/non reconnu.*ne prouve pas la complétude/);
    const old = new Date(Date.now() - 3 * 3600_000);
    await utimes(assignmentsFile(), old, old);
    expect((await planRollback({ exportData: exportOf([H("chef-a", "Chef", "A")], new Date(Date.now() - 2 * 3600_000)) })).blockers.join(" ")).toMatch(/PÉRIMÉ : collecté il y a/);
    await utimes(assignmentsFile(), new Date(), new Date());
    expect((await planRollback({ exportData: exportOf([H("chef-a", "Chef", "A")], new Date(Date.now() - 60_000)) })).blockers.join(" ")).toMatch(/modifié .*APRÈS la collecte/);
    const now = new Date(Date.now() + 1000);
    const chk = (exp: unknown) => checkExport(exp, { now, maxAgeMinutes: 30, tableModifiedAt: null, tableCompanies: ["A", "B"], tableAgents: ["chef-a"] }).blockers.join("\n");
    const base = exportOf([H("chef-a", "Chef", "A")]);
    expect(chk({ ...base, companies: base.companies.map((c) => (c.id === "A" ? { ...c, agentCount: 2 } : c)) })).toMatch(/INCOMPLET : entreprise A déclare 2/);
    expect(chk({ ...base, companies: base.companies.filter((c) => c.id !== "B") })).toMatch(/entreprise B de la table est absente/);
    expect(chk({ ...base, agents: [...base.agents, H("chef-a", "Chef", "A")], companies: base.companies.map((c) => (c.id === "A" ? { ...c, agentCount: 2 } : c)) })).toMatch(/chef-a en DOUBLE/);
    expect(chk({ ...base, agents: [{ id: "chef-a", name: "Chef", companyId: "A" }] })).toMatch(/sans type d'adaptateur/);
    expect(chk({ ...base, agents: [{ id: "chef-a", name: "Chef", adapterType: "hermes_local" }] })).toMatch(/sans entreprise/);
    expect(chk({ ...base, agents: [], companies: base.companies.map((c) => ({ ...c, agentCount: 0 })) })).toMatch(/chef-a affecté dans la table mais ABSENT de l'export/);
    expect(chk({ ...base, collector: { instanceAdmin: false, check: "x" } })).toMatch(/SANS droit d'administrateur d'instance/);
    expect(chk({ ...base, collector: undefined })).toMatch(/SANS droit d'administrateur d'instance/);
  });

  it("COMPATIBLE : chaque agent hermes_local retombe sur son profil (ou n'en trouve aucun s'il est non affecté) → carte plate 0.5 écrite après sauvegarde ; la table est conservée", async () => {
    await assignAgent({ agentId: "chef-a", companyId: "A", instanceHome: instA, profile: "chef", name: "Chef", assignedBy: "u" });
    const table = await readFile(assignmentsFile(), "utf8");
    const plan = await planRollback({ exportData: exportOf([H("chef-a", "Chef", "A")], new Date(Date.now() + 500)) });
    expect(plan.blockers).toEqual([]);
    expect(plan.compatible).toBe(true);
    expect(plan.commands.join("\n")).toMatch(/paperclip-plugin-hermes-control@0\.5\.0/);
    const r = await applyRollback(plan);
    expect(r.backups.some((b) => b.includes("agents.json.bak-rollback-"))).toBe(true);
    const flat = JSON.parse(await readFile(agentsMapFile(), "utf8")) as Record<string, { home: string; profile: string }>;
    expect(flat["chef-a"]).toMatchObject({ home: join(instA, "profiles", "chef"), profile: "chef" });
    expect(Object.keys(flat)).toEqual(["chef-a"]);
    expect(await readFile(assignmentsFile(), "utf8")).toBe(table);
  });
});
