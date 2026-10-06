import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestHarness } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import plugin from "./worker.js";
import { assignAgent, assignmentsFile, readAssignments, setCompanyInstances, setHermesBinary } from "./assignments.js";
import { agentsMapFile } from "./agents-map.js";
import { fakeCalls, makeFakeHermes, writeRoots, writeWorkspaceFile } from "./testkit.js";
import { sha256 } from "./assignments.js";

async function start() {
  const h = createTestHarness({ manifest: manifest as unknown as PaperclipPluginManifestV1, config: {} });
  await plugin.definition.setup(h.ctx);
  return h;
}
const user = { actor: { type: "user" as const, userId: "u1" } };

/** Empreinte d'un dossier (chemins + mtimes + tailles) : pour prouver qu'il n'a pas bougé. */
async function fingerprint(dir: string): Promise<string> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const st = await stat(p);
    out.push(`${p}:${st.size}:${st.mtimeMs}`);
    if (e.isDirectory()) out.push(await fingerprint(p));
  }
  return out.sort().join("\n");
}

describe("worker Hermes Control", () => {
  // HOME isolé : ni le dossier de travail ni les roots réels de la machine ne doivent entrer dans ces tests
  let savedHome: string | undefined;
  beforeEach(async () => { savedHome = process.env["HOME"]; process.env["HOME"] = await mkdtemp(join(tmpdir(), "hc-worker-")); });
  afterEach(() => { if (savedHome) process.env["HOME"] = savedHome; });

  it("le job sync ne fait rien sans instantané d'agents", async () => {
    const h = await start();
    await expect(h.runJob("sync")).resolves.toBeUndefined();
  });

  it("instances : liste vide et aucune synchro sans agent Hermes", async () => {
    const h = await start();
    h.seed({ companies: [{ id: "co", name: "Test" } as never], agents: [] });
    const r = await h.getData<{ instances: unknown[]; sync: unknown[]; assignments: { company: unknown; error: string | null } }>("instances", { companyId: "co" });
    expect(r.sync).toEqual([]);
    expect(Array.isArray(r.instances)).toBe(true);
    expect(r.assignments.company).toBeNull();
    expect(r.assignments.error).toBeNull();
  });

  it("un agent Hermes sans affectation est « non affecté », sans suggestion quand aucune instance n'est autorisée", async () => {
    const h = await start();
    h.seed({ companies: [{ id: "co", name: "Test" } as never], agents: [{ id: "a1", companyId: "co", name: "Inconnu", adapterType: "hermes_local", adapterConfig: { model: "m", provider: "openai-codex" }, status: "idle" } as never] });
    const r = await h.getData<{ sync: { agentName: string; error: string | null; suggestion: unknown; assignment: unknown }[] }>("instances", { companyId: "co" });
    expect(r.sync[0]?.agentName).toBe("Inconnu");
    expect(r.sync[0]?.error).toBe("non affecté");
    expect(r.sync[0]?.suggestion).toBeNull();
    expect(r.sync[0]?.assignment).toBeNull();
    await expect(stat(assignmentsFile())).rejects.toThrow(); // la vue n'écrit jamais la table
  });
});

describe("affectation explicite (table assignments.json) — aucune affectation par le nom", () => {
  let root: string;
  let savedHome: string | undefined;
  let savedPath: string | undefined;
  let instA: string;
  let instB: string;
  let fake: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hc-w-")); // court : les profils préparés doivent rester sous 100 octets de chemin de socket
    savedHome = process.env["HOME"]; savedPath = process.env["PATH"];
    process.env["HOME"] = root;
    // faux point d'entrée Hermes ADMINISTRÉ (Python, comme le vrai) : « profile create » clone l'instance ; « config set » laisse une trace
    fake = await makeFakeHermes(join(root, "bin"));
    const ws = join(root, "ws");
    instA = join(ws, "hermes", "profils", "societe-a");
    instB = join(ws, "hermes", "profils", "societe-b");
    for (const i of [instA, instB]) {
      await mkdir(i, { recursive: true });
      await writeFile(join(i, "config.yaml"), "model:\n  provider: openai-codex\n  default: gpt-5.6-luna\n");
      await writeFile(join(i, ".env"), "OPENAI_API_KEY=marqueur\n");
    }
    // l'instance de A a déjà un profil « assistant » (homonyme de l'agent de B)
    await mkdir(join(instA, "profiles", "assistant"), { recursive: true });
    await writeFile(join(instA, "profiles", "assistant", "config.yaml"), "model:\n  provider: openai-codex\n  default: gpt-5.6-luna\n");
    await writeFile(join(instA, "profiles", "assistant", "SOUL.md"), "# assistant de A\n");
    await writeWorkspaceFile(ws);
    await writeRoots(join(ws, "hermes", "profils"));
    await setHermesBinary({ binary: fake });
  });
  afterEach(() => { if (savedHome) process.env["HOME"] = savedHome; if (savedPath) process.env["PATH"] = savedPath; });

  type Rec = { agentId: string; companyId: string; agentName: string; instance: string | null; profile: string | null; home: string | null; prepared: string[] | null; error: string | null; changed: string[]; suggestion: { instance: string; profile: string; by: string } | null; assignment: { instanceHome: string; profile: string; assignedBy: string } | null };
  type Data = { sync: Rec[]; workspace: { root: string } | null; states: Record<string, string>; health: Record<string, { alerts: string[] }>; instances: { name: string; home: string }[]; assignments: { company: { instances: string[] } | null; error: string | null } };
  const agent = (id: string, companyId: string, name: string) => ({ id, companyId, name, title: "Testeur", adapterType: "hermes_local", adapterConfig: { model: "gpt-5.6-luna", provider: "openai-codex" }, status: "idle" }) as never;
  const seedTwo = (h: Awaited<ReturnType<typeof start>>, nameB = "Assistant") => h.seed({ companies: [{ id: "A", name: "Societe A" } as never, { id: "B", name: "Societe B" } as never], agents: [agent("agent-A", "A", "Assistant"), agent("agent-B", "B", nameB)] });

  it("NON-RÉGRESSION (sonde Codex n°1) : deux entreprises avec un « Assistant » ; profil homonyme dans l'instance de A → la vue de B n'écrit RIEN, B n'est pas affecté, rien ne traverse", async () => {
    const h = await start();
    seedTwo(h);
    // B a ses instances autorisées (B seulement) ; A a les siennes ; aucune affectation
    await setCompanyInstances("A", "Societe A", [instA]);
    await setCompanyInstances("B", "Societe B", [instB]);
    const tableBefore = await readFile(assignmentsFile(), "utf8");
    const mapBefore = await readFile(agentsMapFile(), "utf8");
    const aBefore = await fingerprint(instA);
    const viewB = await h.getData<Data>("instances", { companyId: "B" });
    const b = viewB.sync.find((s) => s.agentId === "agent-B")!;
    expect(b.assignment).toBeNull();
    expect(b.home).toBeNull();
    expect(b.error).toBe("non affecté");
    expect(b.suggestion).toBeNull(); // le profil homonyme est dans l'instance de A : hors des instances autorisées de B → pas même suggéré
    expect(viewB.sync.map((s) => s.companyId)).toEqual(["B"]);
    // ni la table, ni la projection, ni les fichiers de A n'ont bougé ; aucun hermes config set
    expect(await readFile(assignmentsFile(), "utf8")).toBe(tableBefore);
    expect(await readFile(agentsMapFile(), "utf8")).toBe(mapBefore);
    expect(await fingerprint(instA)).toBe(aBefore);
    await expect(stat(join(root, "hermes-config-set"))).rejects.toThrow();
    // la vue de A : son Assistant non affecté non plus, mais une SUGGESTION (affichée, jamais appliquée) vers societe-a/assistant
    const viewA = await h.getData<Data>("instances", { companyId: "A" });
    const a = viewA.sync.find((s) => s.agentId === "agent-A")!;
    expect(a.assignment).toBeNull();
    expect(a.error).toBe("non affecté");
    expect(a.suggestion).toEqual({ instance: "societe-a", instanceHome: instA, profile: "assistant", by: "profile-name" });
    expect(await readFile(assignmentsFile(), "utf8")).toBe(tableBefore);
    // le job 5 min et les événements n'affectent pas davantage
    await h.emit("agent.created", { agentId: "agent-B" }, { companyId: "B" });
    await h.emit("agent.updated", { agentId: "agent-A" }, { companyId: "A" });
    await h.runJob("sync");
    expect(await readFile(assignmentsFile(), "utf8")).toBe(tableBefore);
    expect(await fingerprint(instA)).toBe(aBefore);
    await expect(stat(join(instB, "profiles"))).rejects.toThrow(); // rien de préparé chez B non plus
    await expect(stat(join(root, "hermes-config-set"))).rejects.toThrow();
  });

  it("renommer un agent AFFECTÉ ne change rien (ni table, ni profil, ni projection) ; renommer un agent non affecté n'affecte rien", async () => {
    const h = await start();
    seedTwo(h);
    await setCompanyInstances("A", "Societe A", [instA]);
    await setCompanyInstances("B", "Societe B", [instB]);
    await assignAgent({ agentId: "agent-A", companyId: "A", instanceHome: instA, profile: "assistant", name: "Assistant", assignedBy: "user:u1" });
    const tableBefore = await readFile(assignmentsFile(), "utf8");
    const mapBefore = await readFile(agentsMapFile(), "utf8");
    // la synchro d'un agent affecté écrit les champs déclarés dans SON profil (c'est la seule écriture Hermes)
    const v1 = await h.getData<Data>("instances", { companyId: "A" });
    expect(v1.sync[0]!.home).toBe(join(instA, "profiles", "assistant"));
    expect(v1.sync[0]!.error).toBeNull();
    expect(v1.states["agent-A"]).toBe("installed");
    // renommage dans Paperclip : « Assistant » → « Secrétaire » (il existe maintenant un profil « default » dont la description pourrait matcher…)
    h.seed({ companies: [{ id: "A", name: "Societe A" } as never, { id: "B", name: "Societe B" } as never], agents: [agent("agent-A", "A", "Secrétaire"), agent("agent-B", "B", "Assistant")] });
    await h.emit("agent.updated", { agentId: "agent-A" }, { companyId: "A" });
    const v2 = await h.getData<Data>("instances", { companyId: "A" });
    expect(v2.sync[0]!.agentName).toBe("Secrétaire");
    expect(v2.sync[0]!.home).toBe(join(instA, "profiles", "assistant")); // même profil
    expect(v2.sync[0]!.assignment?.assignedBy).toBe("user:u1");
    expect(await readFile(assignmentsFile(), "utf8")).toBe(tableBefore);
    expect(await readFile(agentsMapFile(), "utf8")).toBe(mapBefore);
    expect(await readFile(join(instA, "profiles", "assistant", "SOUL.md"), "utf8")).toBe("# assistant de A\n");
    // B renommé « Assistant » → « assistant » (homonyme exact du profil de A) : toujours non affecté, rien n'écrit
    await h.emit("agent.updated", { agentId: "agent-B" }, { companyId: "B" });
    const vB = await h.getData<Data>("instances", { companyId: "B" });
    expect(vB.sync[0]!.assignment).toBeNull();
    expect(vB.sync[0]!.error).toBe("non affecté");
    expect(await readFile(assignmentsFile(), "utf8")).toBe(tableBefore);
  });

  it("cas positif : affectation explicite (action assign-agent) conservée, synchro des champs déclarés dans le profil affecté seulement", async () => {
    const h = await start();
    seedTwo(h);
    await h.performAction("set-company-instances", { companyId: "A", instances: [instA] }, user);
    await h.performAction("set-company-instances", { companyId: "B", instances: [instB] }, user);
    const r = await h.performAction<{ assignment: { home: string }; toPrepare: boolean }>("assign-agent", { agentId: "agent-A", companyId: "A", instanceHome: instA, profile: "assistant" }, user);
    expect(r.assignment.home).toBe(join(instA, "profiles", "assistant"));
    expect(r.toPrepare).toBe(false);
    const table = await readAssignments();
    expect(table.table.agents["agent-A"]).toMatchObject({ companyId: "A", instanceHome: instA, profile: "assistant", assignedBy: "user:u1" });
    expect(table.table.companies["A"]?.instances).toEqual([instA]);
    const v = await h.getData<Data>("instances", { companyId: "A" });
    const a = v.sync.find((s) => s.agentId === "agent-A")!;
    expect(a.error).toBeNull();
    expect(a.assignment?.profile).toBe("assistant");
    expect(v.assignments.company?.instances).toEqual([instA]);
    // les champs déclarés diffèrent ? ici identiques → rien d'écrit ; on change le modèle dans Paperclip → hermes config set sur CE profil
    h.seed({ companies: [{ id: "A", name: "Societe A" } as never], agents: [{ ...(agent("agent-A", "A", "Assistant") as object), adapterConfig: { model: "gpt-6-sol", provider: "openai-codex" } } as never] });
    const v2 = await h.getData<Data>("instances", { companyId: "A" });
    expect(v2.sync[0]!.changed).toEqual(["model.default"]);
    expect(await readFile(join(root, "hermes-config-set"), "utf8")).toBe(`${join(instA, "profiles", "assistant")} model.default=gpt-6-sol\n`);
    // désaffectation explicite
    expect(await h.performAction<{ removed: boolean }>("unassign-agent", { agentId: "agent-A", companyId: "A" }, user)).toEqual({ removed: true });
    expect((await h.getData<Data>("instances", { companyId: "A" })).sync[0]!.assignment).toBeNull();
  });

  it("assign-agent refuse : instance non autorisée pour l'entreprise, profil inexistant (sauf le slug à préparer), acteur non utilisateur", async () => {
    const h = await start();
    seedTwo(h);
    await setCompanyInstances("B", "Societe B", [instB]);
    await expect(h.performAction("assign-agent", { agentId: "agent-B", companyId: "B", instanceHome: instA, profile: "assistant" }, user)).rejects.toThrow(/n'est pas une instance autorisée de l'entreprise « Societe B »/);
    await expect(h.performAction("assign-agent", { agentId: "agent-B", companyId: "B", instanceHome: instB, profile: "inconnu" }, user)).rejects.toThrow(/le profil « inconnu » n'existe pas dans societe-b.*seul « assistant » peut être affecté avant d'être préparé/);
    await expect(h.performAction("assign-agent", { agentId: "agent-B", companyId: "B", instanceHome: instB, profile: "assistant" }, { actor: { type: "agent", agentId: "x" } })).rejects.toThrow(/réservée à un utilisateur/);
    expect((await readAssignments()).table.agents).toEqual({});
    // le slug du nom peut être affecté avant d'exister (« à préparer ») ; l'adaptateur refusera tant que config.yaml manque
    const r = await h.performAction<{ toPrepare: boolean }>("assign-agent", { agentId: "agent-B", companyId: "B", instanceHome: instB, profile: "assistant" }, user);
    expect(r.toPrepare).toBe(true);
    const v = await h.getData<Data>("instances", { companyId: "B" });
    expect(v.sync[0]!.error).toMatch(/introuvable.*Préparer l'agent/);
  });

  it("set-company-instances : seulement des instances découvertes ; la vue montre les instances autorisées ; une instance utilisée ne se retire pas", async () => {
    const h = await start();
    seedTwo(h);
    await expect(h.performAction("set-company-instances", { companyId: "A", instances: [join(root, "ailleurs")] }, user)).rejects.toThrow(/instance inconnue/);
    await h.performAction("set-company-instances", { companyId: "A", instances: [instA, instB] }, user);
    expect((await h.getData<Data>("instances", { companyId: "A" })).assignments.company?.instances).toEqual([instA, instB]);
    await h.performAction("assign-agent", { agentId: "agent-A", companyId: "A", instanceHome: instB, profile: "default" }, user);
    await expect(h.performAction("set-company-instances", { companyId: "A", instances: [instA] }, user)).rejects.toThrow(/affectés à une instance retirée/);
  });

  it("prepare-agent : instance EXPLICITE et autorisée ; crée le profil (.env vide) et affecte en même temps ; refuse une instance non autorisée ; idempotent", async () => {
    const h = await start();
    seedTwo(h);
    await setCompanyInstances("B", "Societe B", [instB]);
    await expect(h.performAction("prepare-agent", { agentId: "agent-B", companyId: "B" }, user)).rejects.toThrow(/instanceHome requis/);
    await expect(h.performAction("prepare-agent", { agentId: "agent-B", companyId: "B", instanceHome: instA }, user)).rejects.toThrow(/n'est pas une instance autorisée/);
    await expect(stat(join(instA, "profiles", "assistant", ".hermes-control"))).rejects.toThrow(); // le profil de A n'a pas été touché
    const r = await h.performAction<{ created: string[]; warnings: string[] }>("prepare-agent", { agentId: "agent-B", companyId: "B", instanceHome: instB }, user);
    expect(r.created.some((c) => c.startsWith("profil Hermes societe-b/assistant"))).toBe(true);
    const home = join(instB, "profiles", "assistant");
    expect(await readFile(join(home, ".env"), "utf8")).not.toMatch(/=/); // .env vide (R02a)
    const t = await readAssignments();
    expect(t.table.agents["agent-B"]).toMatchObject({ companyId: "B", instanceHome: instB, profile: "assistant", assignedBy: "user:u1" });
    const v = await h.getData<Data>("instances", { companyId: "B" });
    const b = v.sync.find((s) => s.agentId === "agent-B")!;
    expect(b.home).toBe(home);
    expect(b.error).toBeNull();
    expect(b.prepared?.length).toBeGreaterThan(0);
    expect(v.states["agent-B"]).toBe("installed");
    expect(v.health[home]?.alerts).toEqual([]);
    const map = JSON.parse(await readFile(agentsMapFile(), "utf8")) as { agents: Record<string, { home: string }>; derivedFrom: { sha256: string } };
    expect(map.agents["agent-B"]?.home).toBe(home); // projection écrite pour l'adaptateur
    // second passage (agent déjà affecté : instance implicite = la sienne) : rien de nouveau, rien ne casse
    const again = await h.performAction<{ created: string[] }>("prepare-agent", { agentId: "agent-B", companyId: "B" }, user);
    expect(again.created).toEqual([]);
    await expect(h.performAction("prepare-agent", { agentId: "agent-B", companyId: "B", instanceHome: instA }, user)).rejects.toThrow(/déjà affecté/);
  });

  it("agent.created / agent.updated ne préparent et n'affectent plus rien (aucune instance choisie par défaut)", async () => {
    const h = await start();
    seedTwo(h);
    await setCompanyInstances("B", "Societe B", [instB]);
    await h.emit("agent.created", { agentId: "agent-B" }, { companyId: "B" });
    await expect(stat(join(instB, "profiles"))).rejects.toThrow();
    expect((await readAssignments()).table.agents).toEqual({});
  });

  it("profil affecté au config.yaml corrompu : jamais synchronisé (aucun hermes config set), erreur « aucune écriture », fichier intact", async () => {
    await mkdir(join(instA, "profiles", "casse"), { recursive: true });
    await writeFile(join(instA, "profiles", "casse", "config.yaml"), "model: [oops\n");
    const h = await start();
    h.seed({ companies: [{ id: "A", name: "Societe A" } as never], agents: [agent("a1", "A", "Casse")] });
    await setCompanyInstances("A", "Societe A", [instA]);
    await assignAgent({ agentId: "a1", companyId: "A", instanceHome: instA, profile: "casse", name: "Casse", assignedBy: "u" });
    const r = await h.getData<Data>("instances", { companyId: "A" });
    expect(r.sync[0]!.profile).toBe("casse");
    expect(r.sync[0]!.error).toMatch(/config.yaml invalide.*aucune écriture/);
    await expect(stat(join(root, "hermes-config-set"))).rejects.toThrow();
    expect(await readFile(join(instA, "profiles", "casse", "config.yaml"), "utf8")).toBe("model: [oops\n");
    expect(r.health[join(instA, "profiles", "casse")]?.alerts.join(" ")).toMatch(/invalide/);
  });

  it("table corrompue : la vue la signale, n'écrit rien, aucune synchro ; affectation invalide (instance plus autorisée) signalée", async () => {
    const h = await start();
    seedTwo(h);
    await setCompanyInstances("A", "Societe A", [instA, instB]);
    await assignAgent({ agentId: "agent-A", companyId: "A", instanceHome: instB, profile: "default", name: "Assistant", assignedBy: "u" });
    // la table est éditée à la main : B retiré des instances de A → l'affectation devient invalide
    const t = JSON.parse(await readFile(assignmentsFile(), "utf8")) as { companies: Record<string, { instances: string[] }> };
    t.companies["A"]!.instances = [instA];
    await writeFile(assignmentsFile(), JSON.stringify(t));
    const v = await h.getData<Data>("instances", { companyId: "A" });
    expect(v.sync[0]!.error).toMatch(/affectation invalide.*non autorisée pour l'entreprise/);
    expect(v.sync[0]!.changed).toEqual([]);
    await writeFile(assignmentsFile(), "{ cassé");
    const v2 = await h.getData<Data>("instances", { companyId: "A" });
    expect(v2.assignments.error).toMatch(/corrompu/);
    expect(v2.sync[0]!.error).toMatch(/table des affectations refusée/);
    await expect(h.performAction("assign-agent", { agentId: "agent-A", companyId: "A", instanceHome: instA, profile: "default" }, user)).rejects.toThrow(/corrompu.*rien n'est écrit/);
    expect(await readFile(assignmentsFile(), "utf8")).toBe("{ cassé");
    await expect(stat(join(root, "hermes-config-set"))).rejects.toThrow();
  });

  it("le hermesCommand d'un agent n'est ni lu ni exécuté (0.6.1) : aucune instance découverte par un lanceur ; il est montré « ignoré » et signalé", async () => {
    const other = join(root, "autre-racine", "beta");
    await mkdir(join(other, "profiles", "p1"), { recursive: true });
    await writeFile(join(other, "config.yaml"), "model: {}\n");
    await writeFile(join(other, "profiles", "p1", "config.yaml"), "model: {}\n");
    const marker = join(root, "LANCE");
    const launcher = join(root, "lanceurs", "hermes-p1");
    await mkdir(join(root, "lanceurs"), { recursive: true });
    await writeFile(launcher, `#!/bin/bash\necho x > "${marker}"\nexport HERMES_HOME="${join(other, "profiles", "p1")}"\nexec hermes "$@"\n`, { mode: 0o755 });
    const h = await start();
    h.seed({ companies: [{ id: "co", name: "ACME" } as never], agents: [{ id: "a1", companyId: "co", name: "P1", adapterType: "hermes_local", adapterConfig: { hermesCommand: launcher }, status: "idle" } as never] });
    const r = await h.getData<{ instances: { name: string }[]; sync: { ignoredCommand: string | null }[]; alerts: string[] }>("instances", { companyId: "co" });
    expect(r.instances.map((i) => i.name).sort()).toEqual(["societe-a", "societe-b"]); // beta n'est pas découverte par le lanceur
    expect(r.sync[0]!.ignoredCommand).toBe(launcher);
    expect(r.alerts.join(" ")).toMatch(/agent a1 \(« P1 »\) : hermesCommand .*hermes-p1 ignoré depuis 0\.6\.1/);
    await expect(stat(marker)).rejects.toThrow(); // jamais exécuté
    expect((await fakeCalls(join(root, "bin"))).every((c) => c.exe === fake)).toBe(true);
  });

  it("sans binaire administré valide : aucune exécution Hermes (ni synchro, ni préparation) ; un binaire shell est refusé", async () => {
    const h = await start();
    seedTwo(h);
    await setCompanyInstances("A", "Societe A", [instA]);
    await setCompanyInstances("B", "Societe B", [instB]);
    await assignAgent({ agentId: "agent-A", companyId: "A", instanceHome: instA, profile: "assistant", name: "Assistant", assignedBy: "u" });
    const t = JSON.parse(await readFile(assignmentsFile(), "utf8")) as Record<string, unknown>;
    delete t["hermes"];
    await writeFile(assignmentsFile(), JSON.stringify(t));
    h.seed({ companies: [{ id: "A", name: "Societe A" } as never, { id: "B", name: "Societe B" } as never], agents: [{ ...(agent("agent-A", "A", "Assistant") as object), adapterConfig: { model: "gpt-6-sol", provider: "openai-codex" } } as never, agent("agent-B", "B", "Assistant")] });
    const v = await h.getData<Data & { assignments: { binary: { ok: boolean; error: string | null } } }>("instances", { companyId: "A" });
    expect(v.sync[0]!.error).toMatch(/binaire Hermes refusé : aucun binaire Hermes administré.*aucune écriture/);
    expect(v.assignments.binary.ok).toBe(false);
    await expect(h.performAction("prepare-agent", { agentId: "agent-B", companyId: "B", instanceHome: instB }, user)).rejects.toThrow(/préparation refusée : binaire Hermes refusé/);
    await expect(stat(join(instB, "profiles"))).rejects.toThrow();
    await expect(h.performAction("set-hermes-binary", { companyId: "A", binary: "/bin/bash" }, user)).rejects.toThrow(/binaire refusé/);
    expect(await fakeCalls(join(root, "bin"))).toEqual([]);
    await expect(stat(join(root, "hermes-config-set"))).rejects.toThrow();
    // administré par l'action (board) → la synchro passe par lui
    await h.performAction("set-hermes-binary", { companyId: "A", binary: fake }, user);
    const v2 = await h.getData<Data>("instances", { companyId: "A" });
    expect(v2.sync[0]!.changed).toEqual(["model.default"]);
    const calls = await fakeCalls(join(root, "bin"));
    expect(calls.filter((c) => c.argv[0] === "config").map((c) => [c.exe, c.HERMES_HOME])).toEqual([[fake, join(instA, "profiles", "assistant")]]);
    expect(calls[0]!.PATH.split(":")[0]).toBe("/usr/bin"); // dossier de l'interpréteur du point d'entrée en tête
  });

  it("donnée « instances » FILTRÉE PAR ENTREPRISE : A ne voit ni l'instance, ni l'état, ni la santé, ni les erreurs de l'agent de B", async () => {
    const h = await start();
    seedTwo(h);
    await setCompanyInstances("A", "Societe A", [instA]);
    await setCompanyInstances("B", "Societe B", [instB]);
    await mkdir(join(instB, "profiles", "assistant"), { recursive: true });
    await writeFile(join(instB, "profiles", "assistant", "config.yaml"), "model: {}\n");
    await assignAgent({ agentId: "agent-B", companyId: "B", instanceHome: instB, profile: "assistant", name: "Assistant", assignedBy: "u" });
    // une erreur sur l'affectation de B (profil revendiqué deux fois, table écrite à la main)
    const t = JSON.parse(await readFile(assignmentsFile(), "utf8")) as { agents: Record<string, unknown> };
    t.agents["agent-B2"] = { companyId: "B", instanceHome: instB, profile: "assistant", name: "Doublon B", assignedAt: "t", assignedBy: "m" };
    await writeFile(assignmentsFile(), JSON.stringify(t));
    await h.getData<Data>("instances", { companyId: "B" }); // B a ouvert sa vue : son état est dans le stockage du plugin
    const vA = await h.getData<Data & { assignments: { issues: { agents: Record<string, string>; companies: Record<string, string> } }; alerts: string[] }>("instances", { companyId: "A" });
    const text = JSON.stringify(vA);
    expect(vA.instances.map((i) => i.name)).toEqual(["societe-a"]);
    expect(Object.keys(vA.states)).not.toContain("agent-B");
    expect(vA.sync.map((s) => s.agentId)).toEqual(["agent-A"]);
    expect(Object.keys(vA.health).some((h) => h.startsWith(instB))).toBe(false);
    expect(vA.assignments.issues.agents).toEqual({});
    expect(text).not.toContain("agent-B");
    expect(text).not.toContain(instB);
    expect(text).not.toContain("Doublon B");
    // B voit les siennes
    const vB = await h.getData<Data & { assignments: { issues: { agents: Record<string, string> } } }>("instances", { companyId: "B" });
    expect(vB.assignments.issues.agents["agent-B"]).toMatch(/revendiqué/);
    expect(vB.instances.map((i) => i.name)).toEqual(["societe-b"]);
  });

  it("référence exposée (chemin + empreintes) ; projection agents.json HYBRIDE signalée dans la vue et la santé", async () => {
    const h = await start();
    seedTwo(h);
    await setCompanyInstances("A", "Societe A", [instA]);
    type V = { assignments: { reference: { dir: string; files: { name: string; sha256: string | null }[] }; referenceLine: string; projection: string | null }; alerts: string[] };
    const v = await h.getData<V>("instances", { companyId: "A" });
    expect(v.assignments.reference.dir).toBe(join(root, ".config", "hermes-control"));
    expect(v.assignments.reference.files.find((f) => f.name === "assignments.json")?.sha256).toBe(sha256(await readFile(assignmentsFile(), "utf8")));
    expect(v.assignments.referenceLine).toMatch(/référence .*\.config\/hermes-control \(compte .*\) · assignments\.json sha256 [0-9a-f]{16}…/);
    expect(v.assignments.projection).toBeNull();
    // une 0.5 réinstallée écrit ses entrées plates dans la projection → hybride
    const p = JSON.parse(await readFile(agentsMapFile(), "utf8")) as Record<string, unknown>;
    p["agent-A"] = { name: "Assistant", instance: "societe-a", profile: "assistant", home: join(instA, "profiles", "assistant"), at: "t" };
    await writeFile(agentsMapFile(), JSON.stringify(p));
    const v2 = await h.getData<V>("instances", { companyId: "A" });
    expect(v2.assignments.projection).toMatch(/HYBRIDE/);
    expect(v2.alerts.join(" ")).toMatch(/HYBRIDE/);
    const health = await plugin.definition.onHealth!();
    expect(health.status).toBe("degraded");
    expect(JSON.stringify(health)).toMatch(/HYBRIDE/);
  });

  it("santé : sockets mesurés sur le HERMES_HOME TRANSMIS (racine d'exécution courte `~/.h/d`, action set-execution-root) ; sans elle, chemin long → alerte ; alias vers une autre instance refusé", async () => {
    const { symlink } = await import("node:fs/promises");
    const instL = join(root, "ws", "hermes", "profils", "d".repeat(30));
    const home = join(instL, "profiles", "assistant");
    await mkdir(home, { recursive: true });
    await writeFile(join(instL, "config.yaml"), "model: {}\n");
    await writeFile(join(home, "config.yaml"), "model: {}\n");
    await mkdir(join(root, ".h"));
    await symlink(instL, join(root, ".h", "d"));
    await symlink(instA, join(root, ".h", "a"));
    await setCompanyInstances("co", "ACME", [instL]);
    await assignAgent({ agentId: "a1", companyId: "co", instanceHome: instL, profile: "assistant", name: "Assistant", assignedBy: "u" });
    const h = await start();
    h.seed({ companies: [{ id: "co", name: "ACME" } as never], agents: [{ id: "a1", companyId: "co", name: "Assistant", adapterType: "hermes_local", adapterConfig: {}, status: "idle" } as never] });
    type H = { health: Record<string, { socketPathOk: boolean; socketBase: string; alerts: string[] }> };
    const r1 = await h.getData<H>("instances", { companyId: "co" });
    expect(r1.health[home]?.socketPathOk).toBe(false);
    expect(r1.health[home]?.socketBase).toBe(home);
    expect(r1.health[home]?.alerts.join(" ")).toMatch(/socket trop long/);
    await expect(h.performAction("set-execution-root", { companyId: "co", instanceHome: instL, executionRoot: "~/.h/a" }, user)).rejects.toThrow(/désigne .*societe-a, pas l'instance/);
    await h.performAction("set-execution-root", { companyId: "co", instanceHome: instL, executionRoot: "~/.h/d" }, user);
    const r2 = await h.getData<H>("instances", { companyId: "co" });
    expect(r2.health[home]).toMatchObject({ socketPathOk: true, socketBase: join(root, ".h", "d", "profiles", "assistant"), alerts: [] });
  });

  it("set-telegram refuse quand une unité de passerelle existe pour un autre profil, et un chemin qui n'est pas un profil connu", async () => {
    const units = join(root, ".config", "systemd", "user");
    await mkdir(units, { recursive: true });
    await writeFile(join(units, "hermes-gateway-x.service"), `[Service]\nEnvironment="HERMES_HOME=${join(root, "ailleurs", "x")}"\n`);
    const h = await start();
    h.seed({ companies: [{ id: "co", name: "ACME" } as never], agents: [] });
    await h.getData("instances", { companyId: "co" });
    await expect(h.performAction("set-telegram", { home: instA, token: "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789abc" }, user)).rejects.toThrow(/tient déjà la passerelle.*hermes-gateway-x\.service/);
    expect(await readFile(join(instA, ".env"), "utf8")).toBe("OPENAI_API_KEY=marqueur\n");
    await expect(h.performAction("set-telegram", { home: join(root, "ailleurs"), token: "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789abc" }, user)).rejects.toThrow(/inconnu/);
  });
});
