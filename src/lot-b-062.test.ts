// 0.6.2 — autorisations par le contexte d'action, binaire global réservé à l'administrateur, instances non partagées,
// vue filtrée AVANT les sondes, mesure des sockets sur la racine courte pour tout profil.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestHarness } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import plugin from "./worker.js";
import { assignAgent, assignmentsFile, readAssignments, replaceTable, setCompanyInstances, setHermesBinary, sharedInstances, unassignAgent } from "./assignments.js";
import { actionScope, adminScope, companyScope } from "./scope.js";
import { fakeCalls, makeFakeHermes, writeRoots, writeWorkspaceFile } from "./testkit.js";

async function start() {
  const h = createTestHarness({ manifest: manifest as unknown as PaperclipPluginManifestV1, config: {} });
  await plugin.definition.setup(h.ctx);
  return h;
}
/** Utilisateur dans le périmètre d'une entreprise (ce que Paperclip transmet après assertCompanyAccess). */
const inCo = (companyId: string) => ({ actor: { type: "user" as const, userId: "u-" + companyId, companyId } });
/** Appel sans entreprise (Paperclip l'a réservé à l'administrateur d'instance). */
const admin = { actor: { type: "user" as const, userId: "admin" } };

describe("contrat de périmètre (src/scope.ts)", () => {
  it("entreprise = contexte autorisé ; paramètre contradictoire refusé ; global seulement sans entreprise ; agent / système refusés", () => {
    expect(actionScope({ actor: { type: "user", userId: "u" }, companyId: "A" }, {})).toEqual({ kind: "company", companyId: "A", by: "user:u" });
    expect(actionScope({ actor: { type: "user", userId: "u" }, companyId: "A" }, { companyId: "A" })).toMatchObject({ kind: "company" });
    expect(() => actionScope({ actor: { type: "user", userId: "u" }, companyId: "A" }, { companyId: "B" })).toThrow(/paramètres contradictoires/);
    expect(actionScope({ actor: { type: "user", userId: "u" }, companyId: null }, { companyId: "B" })).toEqual({ kind: "admin", by: "user:u" });
    expect(() => companyScope({ actor: { type: "user", userId: "u" }, companyId: null }, {})).toThrow(/sans entreprise autorisée/);
    expect(() => adminScope({ actor: { type: "user", userId: "u" }, companyId: "A" }, {}, "x")).toThrow(/opération GLOBALE réservée/);
    expect(adminScope({ actor: { type: "user", userId: "u" }, companyId: null }, {}, "x")).toEqual({ by: "user:u" });
    expect(() => actionScope({ actor: { type: "agent", userId: null }, companyId: "A" }, {})).toThrow(/réservée à un utilisateur/);
    expect(() => actionScope({ actor: { type: "system", userId: null }, companyId: null }, {})).toThrow(/réservée à un utilisateur/);
  });
});

describe("0.6.2 : actions croisées entre deux entreprises, sans effet en cas de refus", () => {
  let root: string;
  let savedHome: string | undefined;
  let instA: string;
  let instB: string;
  let instC: string;
  let fake: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hc-b-"));
    savedHome = process.env["HOME"];
    process.env["HOME"] = root;
    fake = await makeFakeHermes(join(root, "bin"));
    const ws = join(root, "ws");
    instA = join(ws, "hermes", "profils", "societe-a");
    instB = join(ws, "hermes", "profils", "societe-b");
    instC = join(ws, "hermes", "profils", "libre");
    for (const i of [instA, instB, instC]) {
      await mkdir(join(i, "profiles", "assistant"), { recursive: true });
      await writeFile(join(i, "config.yaml"), "model:\n  provider: openai-codex\n  default: gpt-5.6-luna\n");
      await writeFile(join(i, "profiles", "assistant", "config.yaml"), "model:\n  provider: openai-codex\n  default: gpt-5.6-luna\n");
    }
    await writeWorkspaceFile(ws);
    await writeRoots(join(ws, "hermes", "profils"));
    await setHermesBinary({ binary: fake });
    await setCompanyInstances("A", "Societe A", [instA]);
    await setCompanyInstances("B", "Societe B", [instB]);
  });
  afterEach(() => { if (savedHome) process.env["HOME"] = savedHome; });
  const agent = (id: string, companyId: string, name: string) => ({ id, companyId, name, title: "T", adapterType: "hermes_local", adapterConfig: { model: "gpt-5.6-luna", provider: "openai-codex" }, status: "idle" }) as never;
  const seed = (h: Awaited<ReturnType<typeof start>>) => h.seed({ companies: [{ id: "A", name: "Societe A" } as never, { id: "B", name: "Societe B" } as never], agents: [agent("agent-A", "A", "Assistant"), agent("agent-B", "B", "Assistant")] });
  const table = () => readFile(assignmentsFile(), "utf8");

  it("unassign-agent : B ne désaffecte pas l'agent de A (avec ou sans paramètre companyId), table intacte ; A le peut ; orphelin de A retirable par A seulement", async () => {
    const h = await start();
    seed(h);
    await assignAgent({ agentId: "agent-A", companyId: "A", instanceHome: instA, profile: "assistant", name: "Assistant", assignedBy: "u" });
    const before = await table();
    // le scénario de la recette 0.6.1 : companyId = B, agent de A
    await expect(h.performAction("unassign-agent", { agentId: "agent-A", companyId: "B" }, inCo("B"))).rejects.toThrow(/autre entreprise.*rien n'est écrit/);
    await expect(h.performAction("unassign-agent", { agentId: "agent-A" }, inCo("B"))).rejects.toThrow(/autre entreprise/);
    // paramètre contradictoire : contexte B, paramètre A
    await expect(h.performAction("unassign-agent", { agentId: "agent-A", companyId: "A" }, inCo("B"))).rejects.toThrow(/paramètres contradictoires/);
    // sans entreprise, agent, système
    await expect(h.performAction("unassign-agent", { agentId: "agent-A" }, admin)).rejects.toThrow(/sans entreprise autorisée/);
    await expect(h.performAction("unassign-agent", { agentId: "agent-A" }, { actor: { type: "agent" as const, agentId: "x", companyId: "A" } })).rejects.toThrow(/utilisateur du board/);
    // identifiant inconnu
    await expect(h.performAction("unassign-agent", { agentId: "inconnu" }, inCo("B"))).rejects.toThrow(/introuvable dans cette entreprise/);
    expect(await table()).toBe(before);
    // sous le verrou aussi (appel direct de la bibliothèque)
    await expect(unassignAgent("agent-A", { companyId: "B" })).rejects.toThrow(/autre entreprise/);
    expect(await table()).toBe(before);
    expect(await h.performAction("unassign-agent", { agentId: "agent-A" }, inCo("A"))).toEqual({ removed: true });
    // orphelin (agent supprimé de Paperclip, encore dans la table) : A peut le retirer, B non
    await assignAgent({ agentId: "fantome", companyId: "A", instanceHome: instA, profile: "assistant", name: "Fantôme", assignedBy: "u" });
    await expect(h.performAction("unassign-agent", { agentId: "fantome" }, inCo("B"))).rejects.toThrow(/autre entreprise/);
    expect(await h.performAction("unassign-agent", { agentId: "fantome" }, inCo("A"))).toEqual({ removed: true });
  });

  it("assign-agent / prepare-agent : contexte B vers l'agent ou l'instance de A → refus sans écriture ; prepare d'un agent affecté ailleurs → refus", async () => {
    const h = await start();
    seed(h);
    const before = await table();
    await expect(h.performAction("assign-agent", { agentId: "agent-A", instanceHome: instB, profile: "assistant" }, inCo("B"))).rejects.toThrow(/introuvable dans cette entreprise/);
    await expect(h.performAction("assign-agent", { agentId: "agent-B", instanceHome: instA, profile: "assistant" }, inCo("B"))).rejects.toThrow(/n'est pas une instance autorisée/);
    await expect(h.performAction("prepare-agent", { agentId: "agent-A", instanceHome: instB }, inCo("B"))).rejects.toThrow(/introuvable dans cette entreprise/);
    expect(await table()).toBe(before);
    expect(await fakeCalls(join(root, "bin"))).toEqual([]);
  });

  it("set-hermes-binary : global refusé dans une entreprise (A ou B), accepté sans entreprise (administrateur) ; par instance : la sienne oui, celle de l'autre non", async () => {
    const h = await start();
    seed(h);
    const other = await makeFakeHermes(join(root, "bin2"));
    const before = await table();
    await expect(h.performAction("set-hermes-binary", { binary: other }, inCo("A"))).rejects.toThrow(/opération GLOBALE réservée à l'administrateur/);
    await expect(h.performAction("set-hermes-binary", { binary: other }, inCo("B"))).rejects.toThrow(/opération GLOBALE réservée/);
    await expect(h.performAction("set-hermes-binary", { binary: other, instanceHome: instA }, inCo("B"))).rejects.toThrow(/n'est pas une instance autorisée de cette entreprise.*autre entreprise/);
    expect(await table()).toBe(before);
    const r = await h.performAction<{ scope: string }>("set-hermes-binary", { binary: other, instanceHome: instB }, inCo("B"));
    expect(r.scope).toBe(instB);
    const g = await h.performAction<{ scope: string }>("set-hermes-binary", { binary: other }, admin);
    expect(g.scope).toBe("global");
    const t = (await readAssignments()).table;
    expect(t.hermes?.binary).toBe(other);
    expect(t.instances?.[instB]?.hermes?.binary).toBe(other);
    expect(t.instances?.[instA]?.hermes).toBeUndefined();
  });

  it("instances : une instance de A demandée par B → refus, rien n'est réattribué ; instance libre → acceptée ; nouveau partage refusé même par remplacement de table", async () => {
    const h = await start();
    seed(h);
    const before = await table();
    await expect(h.performAction("set-company-instances", { instances: [instB, instA] }, inCo("B"))).rejects.toThrow(/déjà rattachée à l'entreprise « Societe A » \(A\).*rien n'est réattribué/);
    expect(await table()).toBe(before);
    await h.performAction("set-company-instances", { instances: [instB, instC] }, inCo("B"));
    expect((await readAssignments()).table.companies["B"]?.instances).toEqual([instB, instC]);
    await expect(setCompanyInstances("A", "Societe A", [instA, instC])).rejects.toThrow(/déjà rattachée/);
    const t = (await readAssignments()).table;
    t.companies["A"]!.instances.push(instC);
    await expect(replaceTable(t)).rejects.toThrow(/partage non pris en charge/);
  });

  it("table ANTÉRIEURE avec une instance partagée : diagnostic dans la vue des deux entreprises, réglages communs refusés, rien n'est réattribué ni supprimé", async () => {
    const h = await start();
    seed(h);
    // écrite à la main (comme une table 0.6.1)
    const t = JSON.parse(await table()) as { companies: Record<string, { instances: string[] }> };
    t.companies["B"]!.instances.push(instA);
    await writeFile(assignmentsFile(), JSON.stringify(t, null, 2));
    const before = await table();
    expect(sharedInstances((await readAssignments()).table)).toEqual({ [instA]: ["A", "B"] });
    const vA = await h.getData<{ alerts: string[] }>("instances", { companyId: "A" });
    const vB = await h.getData<{ alerts: string[] }>("instances", { companyId: "B" });
    for (const v of [vA, vB]) expect(v.alerts.join("\n")).toMatch(/rattachée à 2 entreprises.*partage non pris en charge.*rien n'est réattribué ni supprimé/);
    await expect(h.performAction("set-execution-root", { instanceHome: instA, executionRoot: instA }, inCo("A"))).rejects.toThrow(/rattachée à 2 entreprises/);
    await expect(h.performAction("set-hermes-binary", { binary: fake, instanceHome: instA }, inCo("B"))).rejects.toThrow(/rattachée à 2 entreprises/);
    await expect(h.performAction("set-hermes-binary", { binary: fake, instanceHome: instA }, admin)).rejects.toThrow(/rattachée à 2 entreprises/);
    // la vue et les refus n'ont rien réécrit ; l'entreprise peut encore garder sa liste (pas de nouveau partage)
    expect(await table()).toBe(before);
    await h.performAction("set-company-instances", { instances: [instB, instA] }, inCo("B"));
    // et peut retirer l'instance partagée (geste de l'administrateur) : le diagnostic disparaît
    await h.performAction("set-company-instances", { instances: [instB] }, inCo("B"));
    expect(sharedInstances((await readAssignments()).table)).toEqual({});
  });

  it("vue FILTRÉE AVANT LES SONDES : la page de B ne lance aucun `hermes auth status` sur l'instance de A ni sur une instance libre ; celle de A seulement sur A", async () => {
    const h = await start();
    seed(h);
    await h.getData("instances", { companyId: "B" });
    const callsB = await fakeCalls(join(root, "bin"));
    expect(callsB.filter((c) => c.argv[0] === "auth").map((c) => c.HERMES_HOME).every((home) => home.startsWith(instB))).toBe(true);
    expect(callsB.filter((c) => c.argv[0] === "auth").length).toBeGreaterThan(0);
    expect(callsB.some((c) => c.HERMES_HOME.startsWith(instA) || c.HERMES_HOME.startsWith(instC))).toBe(false);
    await writeFile(join(root, "bin", "calls.jsonl"), "");
    const vA = await h.getData<{ instances: { home: string }[] }>("instances", { companyId: "A" });
    const callsA = await fakeCalls(join(root, "bin"));
    expect(callsA.length).toBeGreaterThan(0);
    expect(callsA.every((c) => c.HERMES_HOME.startsWith(instA))).toBe(true);
    // A voit son instance et l'instance libre (lue en mode léger), pas celle de B
    expect(vA.instances.map((i) => i.home).sort()).toEqual([instA, instC].sort());
  });

  it("socket : profil `default` (et profil non affecté) d'une instance à racine courte mesurés sur la racine courte — plus de fausse alerte", async () => {
    // instance à racine longue, racine d'exécution courte par lien
    const deep = join(root, "ws", "hermes", "profils", "p".repeat(60));
    await mkdir(join(deep, "profiles", "x".repeat(10)), { recursive: true });
    await writeFile(join(deep, "config.yaml"), "model: {}\n");
    await writeFile(join(deep, "profiles", "x".repeat(10), "config.yaml"), "model: {}\n");
    await mkdir(join(root, ".h"), { recursive: true });
    await symlink(deep, join(root, ".h", "d"));
    await setCompanyInstances("A", "Societe A", [instA, deep]);
    const h = await start();
    seed(h);
    const { setExecutionRoot } = await import("./assignments.js");
    await setExecutionRoot(deep, "~/.h/d");
    const v = await h.getData<{ health: Record<string, { socketBase: string; socketPathOk: boolean; alerts: string[] }>; alerts: string[] }>("instances", { companyId: "A" });
    expect(v.health[deep]).toMatchObject({ socketBase: join(root, ".h", "d"), socketPathOk: true });
    expect(v.health[join(deep, "profiles", "x".repeat(10))]).toMatchObject({ socketBase: join(root, ".h", "d", "profiles", "x".repeat(10)), socketPathOk: true });
    expect(v.alerts.join("\n")).not.toMatch(/socket trop long/);
  });
});
