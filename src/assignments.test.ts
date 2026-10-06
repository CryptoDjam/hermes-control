import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assignAgent, assignmentsFile, canonicalInstance, emptyTable, isApprovedBinary, knownRoots, parseTable, readAssignments, relationalIssues, replaceTable, resolveAssignment, setCompanyInstances, sha256, unassignAgent } from "./assignments.js";
import { agentsMapFile, readProjection } from "./agents-map.js";
import { ownerFile } from "./lock.js";

let root: string;
let instA: string;
let instB: string;
let savedHome: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hc-assign-"));
  savedHome = process.env["HOME"];
  process.env["HOME"] = root;
  instA = join(root, "instances", "societe-a");
  instB = join(root, "instances", "societe-b");
  for (const i of [instA, instB]) {
    await mkdir(join(i, "profiles", "assistant"), { recursive: true });
    await writeFile(join(i, "config.yaml"), "model: {}\n");
    await writeFile(join(i, "profiles", "assistant", "config.yaml"), "model: {}\n");
  }
  process.env["HERMES_CONTROL_ROOTS"] = join(root, "instances");
});
afterEach(() => {
  delete process.env["HERMES_CONTROL_ROOTS"];
  if (savedHome) process.env["HOME"] = savedHome;
});

describe("table assignments.json : fichier, schéma, racines", () => {
  it("chemin : ~/.config/hermes-control/assignments.json, ou HERMES_CONTROL_ASSIGNMENTS ; absente → table vide, exists faux", async () => {
    expect(assignmentsFile()).toBe(join(root, ".config", "hermes-control", "assignments.json"));
    process.env["HERMES_CONTROL_ASSIGNMENTS"] = join(root, "x", "t.json");
    try {
      expect(assignmentsFile()).toBe(join(root, "x", "t.json"));
    } finally {
      delete process.env["HERMES_CONTROL_ASSIGNMENTS"];
    }
    const r = await readAssignments();
    expect(r.exists).toBe(false);
    expect(r.error).toBeNull();
    expect(r.table).toEqual(emptyTable());
  });

  it("parseTable refuse tout écart de schéma ; accepte approvedBinaries", () => {
    expect(parseTable(null).error).toMatch(/pas un objet/);
    expect(parseTable({ schemaVersion: 2 }).error).toMatch(/schemaVersion/);
    expect(parseTable({ schemaVersion: 1, companies: [] }).error).toMatch(/companies/);
    expect(parseTable({ schemaVersion: 1, companies: { c: { name: "x", instances: ["rel/path"] } } }).error).toMatch(/non absolu/);
    expect(parseTable({ schemaVersion: 1, agents: { a: { companyId: "c" } } }).error).toMatch(/agents\[a\]\.instanceHome manquant/);
    const ok = parseTable({ schemaVersion: 1, companies: {}, agents: {}, approvedBinaries: ["/usr/bin/hermes"] });
    expect(ok.error).toBeNull();
    expect(ok.table?.approvedBinaries).toEqual(["/usr/bin/hermes"]);
  });

  it("fichier corrompu → error, table refusée, fichier intact ; une écriture est refusée", async () => {
    await mkdir(dirname(assignmentsFile()), { recursive: true });
    await writeFile(assignmentsFile(), "{ pas du json\n");
    const r = await readAssignments();
    expect(r.error).toMatch(/corrompu/);
    await expect(setCompanyInstances("A", "Societe A", [instA])).rejects.toThrow(/corrompu.*rien n'est écrit/);
    expect(await readFile(assignmentsFile(), "utf8")).toBe("{ pas du json\n");
    await expect(stat(agentsMapFile())).rejects.toThrow(); // pas de projection écrite non plus
  });

  it("racines connues = racines configurées (réelles) ; canonicalInstance refuse hors racine, inexistant, relatif ; suit les liens", async () => {
    const roots = await knownRoots();
    expect(roots).toEqual([join(root, "instances")]);
    expect((await canonicalInstance(instA, roots)).real).toBe(instA);
    expect((await canonicalInstance(join(root, "ailleurs"), roots)).error).toMatch(/introuvable/);
    await mkdir(join(root, "hors"));
    expect((await canonicalInstance(join(root, "hors"), roots)).error).toMatch(/hors des racines connues/);
    expect((await canonicalInstance("rel", roots)).error).toMatch(/non absolu/);
    await symlink(instA, join(root, "lien-a"));
    expect((await canonicalInstance(join(root, "lien-a"), roots)).real).toBe(instA); // realpath
    await symlink(join(root, "hors"), join(root, "instances", "lien-hors"));
    expect((await canonicalInstance(join(root, "instances", "lien-hors"), roots)).error).toMatch(/hors des racines/); // un lien ne fait pas rentrer un dossier
  });
});

describe("écritures : set-company-instances, assign, unassign — validées, atomiques, projection réécrite", () => {
  it("déclare les instances autorisées d'une entreprise ; refuse une instance hors racine ou inexistante ; écrit la projection avec l'empreinte", async () => {
    const t = await setCompanyInstances("A", "Societe A", [instA, instA]);
    expect(t.companies["A"]).toEqual({ name: "Societe A", instances: [instA] });
    expect((await stat(assignmentsFile())).mode & 0o777).toBe(0o600);
    await expect(setCompanyInstances("B", "Societe B", [join(root, "ailleurs")])).rejects.toThrow(/introuvable/);
    const text = await readFile(assignmentsFile(), "utf8");
    const p = await readProjection();
    expect(p.projection?.derivedFrom.sha256).toBe(sha256(text));
    expect(p.projection?.companies["A"]?.instances).toEqual([instA]);
    await expect(lstat(`${assignmentsFile()}.lock`)).rejects.toThrow(); // verrou relâché
  });

  it("affecte seulement vers une instance autorisée de l'entreprise de l'agent ; refus sinon ; aucune entreprise déclarée → refus", async () => {
    await expect(assignAgent({ agentId: "b1", companyId: "B", companyName: "Societe B", instanceHome: instA, profile: "assistant", name: "Assistant", assignedBy: "user:u1" })).rejects.toThrow(/aucune instance autorisée déclarée pour l'entreprise « Societe B »/);
    await setCompanyInstances("A", "Societe A", [instA]);
    await setCompanyInstances("B", "Societe B", [instB]);
    await expect(assignAgent({ agentId: "b1", companyId: "B", instanceHome: instA, profile: "assistant", name: "Assistant", assignedBy: "user:u1" })).rejects.toThrow(/n'est pas une instance autorisée de l'entreprise « Societe B »/);
    expect((await readAssignments()).table.agents).toEqual({});
    const r = await assignAgent({ agentId: "b1", companyId: "B", instanceHome: instB, profile: "assistant", name: "Assistant", assignedBy: "user:u1" });
    expect(r.home).toBe(join(instB, "profiles", "assistant"));
    expect(r.assignedBy).toBe("user:u1");
    const back = await readAssignments();
    expect(back.table.agents["b1"]).toMatchObject({ companyId: "B", instanceHome: instB, profile: "assistant", name: "Assistant" });
    expect(back.issues.agents).toEqual({});
    expect((await readProjection()).projection?.agents["b1"]?.home).toBe(join(instB, "profiles", "assistant"));
  });

  it("deux agents ne revendiquent pas le même profil ; un agent peut être réaffecté ; désaffectation", async () => {
    await setCompanyInstances("A", "Societe A", [instA]);
    await assignAgent({ agentId: "a1", companyId: "A", instanceHome: instA, profile: "assistant", name: "Assistant", assignedBy: "user:u1" });
    await expect(assignAgent({ agentId: "a2", companyId: "A", instanceHome: instA, profile: "assistant", name: "Assistant bis", assignedBy: "user:u1" })).rejects.toThrow(/déjà affecté à l'agent « Assistant » \(a1\)/);
    await assignAgent({ agentId: "a1", companyId: "A", instanceHome: instA, profile: "default", name: "Assistant", assignedBy: "user:u1" }); // réaffectation du même agent : ok
    await assignAgent({ agentId: "a2", companyId: "A", instanceHome: instA, profile: "assistant", name: "Assistant bis", assignedBy: "user:u1" });
    expect(await unassignAgent("a1")).toBe(true);
    expect(await unassignAgent("a1")).toBe(false);
    expect(Object.keys((await readAssignments()).table.agents)).toEqual(["a2"]);
  });

  it("retirer une instance encore utilisée par un agent affecté est refusé ; profil au nom invalide refusé", async () => {
    await setCompanyInstances("A", "Societe A", [instA, instB]);
    await assignAgent({ agentId: "a1", companyId: "A", instanceHome: instB, profile: "assistant", name: "X", assignedBy: "user:u1" });
    await expect(setCompanyInstances("A", "Societe A", [instA])).rejects.toThrow(/affectés à une instance retirée.*a1/);
    expect((await readAssignments()).table.companies["A"]?.instances).toEqual([instA, instB]);
    await expect(assignAgent({ agentId: "a3", companyId: "A", instanceHome: instA, profile: "../x", name: "X", assignedBy: "u" })).rejects.toThrow(/nom de profil invalide/);
  });

  it("validation à la LECTURE : une table écrite à la main avec une instance non autorisée, un profil doublé ou une racine inconnue signale l'entrée (issues), sans refuser les autres", async () => {
    await mkdir(join(root, "hors"), { recursive: true });
    await mkdir(dirname(assignmentsFile()), { recursive: true });
    const table = { schemaVersion: 1, companies: { A: { name: "A", instances: [instA] }, B: { name: "B", instances: [instB, join(root, "hors")] } }, agents: {
      ok: { companyId: "A", instanceHome: instA, profile: "default", name: "Ok", assignedAt: "t", assignedBy: "m" },
      cross: { companyId: "B", instanceHome: instA, profile: "assistant", name: "Cross", assignedAt: "t", assignedBy: "m" },
      dup1: { companyId: "A", instanceHome: instA, profile: "assistant", name: "D1", assignedAt: "t", assignedBy: "m" },
      dup2: { companyId: "A", instanceHome: instA, profile: "assistant", name: "D2", assignedAt: "t", assignedBy: "m" },
      orphan: { companyId: "Z", instanceHome: instA, profile: "default", name: "O", assignedAt: "t", assignedBy: "m" },
      gone: { companyId: "A", instanceHome: join(root, "instances", "disparue"), profile: "default", name: "G", assignedAt: "t", assignedBy: "m" },
    } };
    await writeFile(assignmentsFile(), JSON.stringify(table));
    const r = await readAssignments();
    expect(r.error).toBeNull();
    expect(r.issues.companies["B"]).toMatch(/hors des racines connues/);
    expect(r.issues.agents["ok"]).toBeUndefined();
    expect(r.issues.agents["cross"]).toMatch(/non autorisée pour l'entreprise « B »/);
    expect(r.issues.agents["dup1"]).toMatch(/revendiqué par 2 agents \(dup1, dup2\)/);
    expect(r.issues.agents["dup2"]).toMatch(/revendiqué/);
    expect(r.issues.agents["orphan"]).toMatch(/entreprise Z absente/);
    expect(r.issues.agents["gone"]).toMatch(/introuvable/);
    expect((await resolveAssignment("ok")).ok?.home).toBe(instA);
    expect((await resolveAssignment("cross")).reason).toMatch(/affectation invalide.*non autorisée/);
    expect((await resolveAssignment("dup1")).reason).toMatch(/revendiqué/);
    // une écriture qui ne crée pas de NOUVEAU problème passe (les anciens restent signalés) ; une qui en crée un est refusée
    await assignAgent({ agentId: "new", companyId: "A", instanceHome: instA, profile: "autre", name: "N", assignedBy: "u" });
    await expect(replaceTable(table as never)).rejects.toThrow(/table refusée/);
    expect(await relationalIssues(emptyTable(), [])).toEqual({ companies: {}, agents: {} });
  });
});

describe("résolution (plugin et adaptateur)", () => {
  it("sans table → « non affecté » ; entreprise différente → refus ; renommer l'agent ne change rien (le nom est informatif)", async () => {
    expect((await resolveAssignment("a1")).reason).toMatch(/non affecté.*table absente/);
    await setCompanyInstances("A", "Societe A", [instA]);
    expect((await resolveAssignment("a1")).reason).toMatch(/non affecté/);
    await assignAgent({ agentId: "a1", companyId: "A", instanceHome: instA, profile: "assistant", name: "Assistant", assignedBy: "u" });
    expect((await resolveAssignment("a1", { companyId: "B" })).reason).toMatch(/pour l'entreprise A, pas pour B/);
    const ok = await resolveAssignment("a1", { companyId: "A" });
    expect(ok.ok?.home).toBe(join(instA, "profiles", "assistant"));
    expect(ok.ok?.source).toBe("table");
    expect(ok.approvedBinaries).toEqual([]);
  });

  it("projection de secours : utilisée seulement si la table présente est illisible pour ce lecteur ET que l'empreinte est identique ; sinon refus", async () => {
    await setCompanyInstances("A", "Societe A", [instA]);
    await assignAgent({ agentId: "a1", companyId: "A", instanceHome: instA, profile: "assistant", name: "Assistant", assignedBy: "u" });
    const good = await readFile(assignmentsFile(), "utf8");
    // 1. table réécrite avec un schéma inconnu, projection d'une autre empreinte → refus
    await writeFile(assignmentsFile(), JSON.stringify({ schemaVersion: 7 }));
    const r1 = await resolveAssignment("a1");
    expect(r1.ok).toBeNull();
    expect(r1.reason).toMatch(/schemaVersion.*aucune projection.*même empreinte/);
    // 2. la projection porte exactement l'empreinte de la table présente → secours accepté
    const p = JSON.parse(await readFile(agentsMapFile(), "utf8")) as { derivedFrom: { sha256: string } };
    p.derivedFrom.sha256 = sha256(JSON.stringify({ schemaVersion: 7 }));
    await writeFile(agentsMapFile(), JSON.stringify(p));
    const r2 = await resolveAssignment("a1");
    expect(r2.ok?.source).toBe("projection");
    expect(r2.ok?.home).toBe(join(instA, "profiles", "assistant"));
    // 3. table valide à nouveau : la table l'emporte, même si la projection divergeait
    await writeFile(assignmentsFile(), good);
    expect((await resolveAssignment("a1")).ok?.source).toBe("table");
    // 4. projection ancienne (format plat) + table absente : jamais utilisée
    const { rm } = await import("node:fs/promises");
    await rm(assignmentsFile());
    await writeFile(agentsMapFile(), JSON.stringify({ a1: { name: "Assistant", home: join(instA, "profiles", "assistant"), instance: "societe-a", profile: "assistant", at: "x" } }));
    expect((await resolveAssignment("a1")).reason).toMatch(/non affecté/);
  });

  it("isApprovedBinary : nom nu, HERMES_CONTROL_HERMES_BIN ou approvedBinaries ; un chemin de script non", () => {
    expect(isApprovedBinary("hermes", {})).toBe(true);
    expect(isApprovedBinary("/opt/hermes/bin/hermes", {})).toBe(false);
    expect(isApprovedBinary("/opt/hermes/bin/hermes", { approvedBinaries: ["/opt/hermes/bin/hermes"] })).toBe(true);
    process.env["HERMES_CONTROL_HERMES_BIN"] = "/usr/local/bin/hermes";
    try {
      expect(isApprovedBinary("/usr/local/bin/hermes", {})).toBe(true);
      expect(isApprovedBinary("/usr/local/bin/hermes-x", {})).toBe(false);
    } finally {
      delete process.env["HERMES_CONTROL_HERMES_BIN"];
    }
    expect(isApprovedBinary("", {})).toBe(false);
  });

  it("verrou de la table : abandonné (owner.json périmé, pid mort) → repris ; détenteur vivant → « verrou tenu »", async () => {
    const lock = `${assignmentsFile()}.lock`;
    await mkdir(lock, { recursive: true });
    await writeFile(ownerFile(lock), JSON.stringify({ pid: 4194303, host: "x", token: "t", startedAt: "s", renewedAt: new Date(Date.now() - 60_000).toISOString() }));
    await setCompanyInstances("A", "Societe A", [instA]);
    expect((await readAssignments()).table.companies["A"]?.instances).toEqual([instA]);
    await expect(lstat(lock)).rejects.toThrow();
    await mkdir(lock, { recursive: true });
    await writeFile(ownerFile(lock), JSON.stringify({ pid: process.pid, token: "t", startedAt: "s", renewedAt: new Date(Date.now() - 60_000).toISOString() }));
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await expect(setCompanyInstances("A", "Societe A", [instA, instB])).rejects.toThrow(/verrou tenu trop longtemps/);
  }, 10_000);
});
