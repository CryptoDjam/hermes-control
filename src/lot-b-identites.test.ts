// Lot B (08/10, prototype) : C2 côté Hermes Control — propriétaire des dossiers métier (court terme), consommation de la
// projection d'identités du pack (cible), T16 avant création. Données FICTIVES ; faux Hermes ; aucun serveur, aucun modèle.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignAgent, assignmentsFile, readAssignments, resolveAssignment, setCompanyInstances, setExecutionRoot } from "./assignments.js";
import { budgetSockets } from "./health.js";
import { identitesFile } from "./identites.js";
import { prepareAgent } from "./prepare.js";
import { prepareByIdentity } from "./prepare-identite.js";
import { OWNER_REL, readOwner } from "./proprietaire.js";
import { fakeCalls, makeFakeHermes, writeRoots, writeWorkspaceFile } from "./testkit.js";
import { layout } from "./workspace.js";

const CA = "11111111-1111-4111-8111-111111111111";
const CB = "22222222-2222-4222-8222-222222222222";
const AG = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let root: string;
let saved: string | undefined;
let fake: string;
let fakeDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lb-")); // court : T16 est contrôlé avant la création
  saved = process.env["HOME"];
  process.env["HOME"] = root;
  fakeDir = join(root, "bin");
  fake = await makeFakeHermes(fakeDir);
});
afterEach(() => {
  if (saved) process.env["HOME"] = saved;
});

async function instance(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.yaml"), "model: {}\n");
  await writeFile(join(dir, ".env"), "TELEGRAM_BOT_TOKEN=FAUX-MARQUEUR\n");
  return dir;
}

/* ---------- court terme (layout 0.6.x : <ws>/agents/<slug>) ---------- */

describe("C2 court terme : dossier métier à une seule identité (layout 0.6.x)", () => {
  it("cas Codex same_name_different_companies (même fixture, fonction réelle modifiée) : B est refusé et ne lit pas le marqueur de A", async () => {
    const ws = layout(join(root, "w"));
    const rows: { agentDir: string | null; memory: string | null; sees_A: boolean; refus: string | null }[] = [];
    for (const [company, owner] of [["A", { companyId: CA, agentId: AG(1) }], ["B", { companyId: CB, agentId: AG(2) }]] as const) {
      const instanceHome = join(ws.profils, company);
      const profile = join(instanceHome, "profiles/chef");
      await mkdir(profile, { recursive: true });
      await writeFile(join(profile, "config.yaml"), "model: {}\n");
      let refus: string | null = null;
      let agentDir: string | null = null;
      try {
        agentDir = (await prepareAgent({ ws, instanceHome, agentName: "Chef", entreprise: company, owner })).agentDir;
      } catch (e) {
        refus = (e as Error).message;
      }
      if (company === "A") await writeFile(join(profile, "memories", "fiction-A.txt"), "FICTITIOUS_COMPANY_A");
      rows.push({ agentDir, refus, memory: await realpath(join(profile, "memories")).catch(() => null), sees_A: await readFile(join(profile, "memories", "fiction-A.txt"), "utf8").then((t) => t === "FICTITIOUS_COMPANY_A", () => false) });
    }
    const result = { case: "same_name_different_companies", same_agent_directory: rows[0]!.agentDir === rows[1]!.agentDir, same_memory_directory: rows[0]!.memory !== null && rows[0]!.memory === rows[1]!.memory, company_B_reads_fictitious_A: rows[1]!.sees_A };
    expect(result).toEqual({ case: "same_name_different_companies", same_agent_directory: false, same_memory_directory: false, company_B_reads_fictitious_A: false });
    expect(rows[1]!.refus).toMatch(/appartient à une autre identité \(agent 00000000-0000-4000-8000-000000000001/);
    expect((await readOwner(join(ws.agents, "chef"))).owner).toMatchObject({ companyId: CA, agentId: AG(1) });
  });

  it("préparations simultanées de deux homonymes (deux instances) : un seul gagnant, l'autre refusé, aucun dossier partagé", async () => {
    const ws = layout(join(root, "w"));
    const run = (c: string, owner: { companyId: string; agentId: string }) => instance(join(ws.profils, c)).then((inst) => prepareAgent({ ws, instanceHome: inst, agentName: "Chef", binary: fake, owner }));
    const res = await Promise.allSettled([run("A", { companyId: CA, agentId: AG(1) }), run("B", { companyId: CB, agentId: AG(2) })]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refus = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(refus.reason)).toMatch(/appartient à une autre identité/);
    const owner = (await readOwner(join(ws.agents, "chef"))).owner!;
    const winner = res[0]!.status === "fulfilled" ? AG(1) : AG(2);
    expect(owner.agentId).toBe(winner);
    expect((await readdir(ws.agents)).filter((n) => n.startsWith(".creation-"))).toEqual([]);
  });

  it("dossier existant SANS propriétaire : refus, aucune adoption (aucun marqueur posé), aucun profil créé", async () => {
    const ws = layout(join(root, "w"));
    await mkdir(join(ws.agents, "chef", "memoire"), { recursive: true });
    await writeFile(join(ws.agents, "chef", "memoire", "MEMORY.md"), "souvenir fictif partagé\n");
    const inst = await instance(join(ws.profils, "A"));
    await expect(prepareAgent({ ws, instanceHome: inst, agentName: "Chef", binary: fake, owner: { companyId: CA, agentId: AG(1) } })).rejects.toThrow(/sans propriétaire enregistré.*aucune adoption automatique.*inventaire de migration/);
    await expect(lstat(join(ws.agents, "chef", OWNER_REL))).rejects.toThrow();
    await expect(lstat(join(inst, "profiles", "chef"))).rejects.toThrow();
    expect(await fakeCalls(fakeDir)).toEqual([]);
  });

  it("liens étrangers refusés : dossier métier lien vers un autre agent, mémoire du profil vers un autre dossier, sous-dossier hors de l'agent", async () => {
    const ws = layout(join(root, "w"));
    const inst = await instance(join(ws.profils, "A"));
    const other = await prepareAgent({ ws, instanceHome: inst, agentName: "Autre", binary: fake, owner: { companyId: CA, agentId: AG(9) } });
    // 1. agents/chef → agents/autre
    await symlink("autre", join(ws.agents, "chef"));
    await expect(prepareAgent({ ws, instanceHome: inst, agentName: "Chef", binary: fake, owner: { companyId: CA, agentId: AG(1) } })).rejects.toThrow(/est un lien/);
    await rm(join(ws.agents, "chef"));
    // 2. profil existant dont memories → mémoire de « autre »
    await mkdir(join(inst, "profiles", "chef"), { recursive: true });
    await writeFile(join(inst, "profiles", "chef", "config.yaml"), "model: {}\n");
    await symlink(join(other.agentDir, "memoire"), join(inst, "profiles", "chef", "memories"));
    await expect(prepareAgent({ ws, instanceHome: inst, agentName: "Chef", binary: fake, owner: { companyId: CA, agentId: AG(1) } })).rejects.toThrow(/pointe vers .*autre\/memoire.*lien étranger/);
    expect(await readlink(join(inst, "profiles", "chef", "memories"))).toBe(join(other.agentDir, "memoire")); // laissé tel quel, pas remplacé
    // 3. sous-dossier memoire du bon agent → dehors
    await rm(join(inst, "profiles", "chef", "memories"));
    await prepareAgent({ ws, instanceHome: inst, agentName: "Chef", binary: fake, owner: { companyId: CA, agentId: AG(1) } });
    await mkdir(join(root, "dehors"));
    await rm(join(ws.agents, "chef", "rapports"), { recursive: true });
    await symlink(join(root, "dehors"), join(ws.agents, "chef", "rapports"));
    await expect(prepareAgent({ ws, instanceHome: inst, agentName: "Chef", binary: fake, owner: { companyId: CA, agentId: AG(1) } })).rejects.toThrow(/hors du dossier de l'agent.*lien étranger/);
  });

  it("T16 avant création (0.6.x) : un nom de profil long sous une racine courte est refusé AVANT tout (ni dossier, ni profil, ni appel à Hermes)", async () => {
    const ws = layout(join(root, "w"));
    const inst = await instance(join(ws.profils, "une-entreprise-au-nom-long"));
    await expect(prepareAgent({ ws, instanceHome: inst, agentName: "Secrétaire de direction", binary: fake, owner: { companyId: CA, agentId: AG(1) } })).rejects.toThrow(/avant toute création.*octets UTF-8 > 100/);
    await expect(lstat(ws.agents)).rejects.toThrow();
    expect(await fakeCalls(fakeDir)).toEqual([]);
  });
});

/* ---------- cible : projection d'alias du pack ---------- */

interface Fix { ws: ReturnType<typeof layout>; p: Record<string, unknown> & { agents: Record<string, unknown>[]; revision: number } }

/** Projection telle que le pack l'écrit (schemaVersion 2), deux entreprises, un « Chef » dans chacune. */
async function projectionFixture(rootDir = join(root, "Equipe")): Promise<Fix> {
  const ws = layout(rootDir);
  await mkdir(join(rootDir, "donnees"), { recursive: true });
  for (const i of ["i00001", "i00002"]) await instance(join(rootDir, "donnees", "h", i));
  const p = {
    schemaVersion: 2, revision: 4, majLe: "2026-10-08T07:00:00.000Z", envelope: { root: rootDir, maxSocketPathBytes: 100 }, compteurs: { e: 2, i: 2, a: 2 },
    companies: [{ companyId: CA, alias: "e00001", name: "Alpha", statut: "actif", vuLe: null }, { companyId: CB, alias: "e00002", name: "Beta", statut: "actif", vuLe: null }],
    instances: [{ alias: "i00001", companyAlias: "e00001", section: "direction", modelAccount: "compte-a" }, { alias: "i00002", companyAlias: "e00002", section: "direction", modelAccount: "compte-b" }],
    agents: [
      { agentId: AG(1), companyAlias: "e00001", profileAlias: "a00001", name: "Chef", statut: "actif", vuLe: null, instanceAlias: "i00001", affecteLe: "2026-10-08T07:00:00.000Z", affectePar: "cli:test" },
      { agentId: AG(2), companyAlias: "e00002", profileAlias: "a00002", name: "Chef", statut: "actif", vuLe: null, instanceAlias: "i00002", affecteLe: "2026-10-08T07:00:00.000Z", affectePar: "cli:test" },
    ],
  };
  await writeFile(identitesFile(ws), JSON.stringify(p, null, 2));
  await writeWorkspaceFile(rootDir);
  await writeRoots();
  const { setHermesBinary } = await import("./assignments.js");
  await setHermesBinary({ binary: fake });
  return { ws, p };
}
const binaryFor = async () => fake;

describe("cible : HC consomme la projection d'alias (identites.json du pack)", () => {
  it("homonymes dans deux entreprises : deux profils et deux mémoires distincts ; B ne lit pas le marqueur de A", async () => {
    const { ws } = await projectionFixture();
    const a = await prepareByIdentity({ ws, companyId: CA, agentId: AG(1), binaryFor });
    const b = await prepareByIdentity({ ws, companyId: CB, agentId: AG(2), binaryFor });
    expect(a.agentDir).toBe(join(ws.root, "donnees/e/e00001/a/a00001"));
    expect(b.agentDir).toBe(join(ws.root, "donnees/e/e00002/a/a00002"));
    expect(a.profileHome).toBe(join(ws.root, "donnees/h/i00001/profiles/a00001"));
    await writeFile(join(a.profileHome, "memories", "fiction-A.txt"), "FICTITIOUS_COMPANY_A");
    expect(await realpath(join(a.profileHome, "memories"))).not.toBe(await realpath(join(b.profileHome, "memories")));
    await expect(readFile(join(b.profileHome, "memories", "fiction-A.txt"), "utf8")).rejects.toThrow();
    expect((await readOwner(a.agentDir)).owner).toMatchObject({ companyId: CA, agentId: AG(1), companyAlias: "e00001", agentAlias: "a00001" });
    // l'exécution résout la même identité, HERMES_HOME sur l'alias
    const r = await resolveAssignment(AG(1), { companyId: CA });
    expect(r.ok?.execution.home).toBe(join(ws.root, "donnees/h/i00001/profiles/a00001"));
    expect(r.ok?.assignedBy).toMatch(/^identites\.json r4/);
  });

  it("renommage dans Paperclip (libellé de la projection) : aucun nouveau dossier, même alias, mémoire conservée", async () => {
    const { ws, p } = await projectionFixture();
    const first = await prepareByIdentity({ ws, companyId: CA, agentId: AG(1), binaryFor });
    await writeFile(join(first.agentDir, "memoire", "souvenir.md"), "fictif\n");
    p.agents[0]!["name"] = "Directeur général";
    p.revision += 1;
    await writeFile(identitesFile(ws), JSON.stringify(p));
    const again = await prepareByIdentity({ ws, companyId: CA, agentId: AG(1), binaryFor });
    expect(again.agentDir).toBe(first.agentDir);
    expect(again.profileHome).toBe(first.profileHome);
    expect(again.created.filter((c) => !c.startsWith(join(first.agentDir, "medias")))).toEqual([]);
    expect(await readdir(join(ws.root, "donnees/e/e00001/a"))).toEqual(["a00001"]);
    expect(await readFile(join(again.profileHome, "memories", "souvenir.md"), "utf8")).toBe("fictif\n");
  });

  it("refus : alias absent, incohérence d'entreprise, agent non affecté ou retiré, projection corrompue — rien n'est créé", async () => {
    const { ws, p } = await projectionFixture();
    await expect(prepareByIdentity({ ws, companyId: CA, agentId: AG(7), binaryFor })).rejects.toThrow(/alias absent/);
    await expect(prepareByIdentity({ ws, companyId: CA, agentId: AG(2), binaryFor })).rejects.toThrow(/incohérence d'entreprise/);
    delete p.agents[1]!["instanceAlias"];
    p.revision += 1; // le pack fait avancer la révision à chaque écriture (HC refuse une même révision au contenu différent)
    await writeFile(identitesFile(ws), JSON.stringify(p));
    await expect(prepareByIdentity({ ws, companyId: CB, agentId: AG(2), binaryFor })).rejects.toThrow(/sans affectation explicite/);
    p.agents[1]!["statut"] = "retire";
    p.revision += 1;
    await writeFile(identitesFile(ws), JSON.stringify(p));
    await expect(prepareByIdentity({ ws, companyId: CB, agentId: AG(2), binaryFor })).rejects.toThrow(/identité inactive.*retiré/);
    p.agents[1]!["profileAlias"] = "a00001"; // alias attribué à deux agents
    p.revision += 1;
    await writeFile(identitesFile(ws), JSON.stringify(p));
    await expect(prepareByIdentity({ ws, companyId: CA, agentId: AG(1), binaryFor })).rejects.toThrow(/projection .* invalide.*a00001 attribué à deux agents/);
    await writeFile(identitesFile(ws), "{ tronqué");
    await expect(prepareByIdentity({ ws, companyId: CA, agentId: AG(1), binaryFor })).rejects.toThrow(/corrompue/);
    expect((await resolveAssignment(AG(1), { companyId: CA })).reason).toMatch(/corrompue/);
    await expect(lstat(join(ws.root, "donnees", "e"))).rejects.toThrow();
    expect(await fakeCalls(fakeDir)).toEqual([]);
  });

  it("pas de registre concurrent : assignments.json qui porte des agents → refus entier ; HC n'écrit aucune affectation", async () => {
    const { ws } = await projectionFixture();
    await expect(assignAgent({ agentId: AG(1), companyId: CA, instanceHome: join(ws.root, "donnees/h/i00001"), profile: "chef", name: "Chef", assignedBy: "test" })).rejects.toThrow(/s'administrent dans le pack/);
    await expect(setCompanyInstances(CA, "Alpha renommée par HC", [join(ws.root, "donnees/h/i00001")])).rejects.toThrow(/s'administrent dans le pack/);
    const t = JSON.parse(await readFile(assignmentsFile(), "utf8"));
    expect(t.agents).toEqual({});
    expect(t.companies).toEqual({});
    t.agents[AG(1)] = { companyId: CA, instanceHome: join(ws.root, "donnees/h/i00001"), profile: "chef", name: "Chef", assignedAt: "x", assignedBy: "main" };
    await writeFile(assignmentsFile(), JSON.stringify(t));
    const r = await readAssignments();
    expect(r.error).toMatch(/registre concurrent/);
    await expect(prepareByIdentity({ ws, companyId: CA, agentId: AG(1), binaryFor })).rejects.toThrow(/registre concurrent/);
  });

  it("liens étrangers : le chemin des données passe par un lien → refus ; un dossier d'alias appartenant à une autre identité → refus", async () => {
    const { ws } = await projectionFixture();
    await mkdir(join(ws.root, "donnees", "e"), { recursive: true });
    await mkdir(join(root, "ailleurs"), { recursive: true });
    await symlink(join(root, "ailleurs"), join(ws.root, "donnees", "e", "e00001"));
    await expect(prepareByIdentity({ ws, companyId: CA, agentId: AG(1), binaryFor })).rejects.toThrow(/lien sur le chemin des données/);
    expect(await readdir(join(root, "ailleurs"))).toEqual([]); // rien n'a été écrit à travers le lien
    await rm(join(ws.root, "donnees", "e", "e00001"));
    // dossier a00002 posé (copié à la main) avec le marqueur de A
    const a = await prepareByIdentity({ ws, companyId: CA, agentId: AG(1), binaryFor });
    await mkdir(join(ws.root, "donnees/e/e00002/a/a00002/.hermes-control"), { recursive: true });
    await writeFile(join(ws.root, "donnees/e/e00002/a/a00002", OWNER_REL), await readFile(join(a.agentDir, OWNER_REL)));
    await expect(prepareByIdentity({ ws, companyId: CB, agentId: AG(2), binaryFor })).rejects.toThrow(/appartient à une autre identité/);
  });

  it("préparations simultanées de 6 agents : 6 dossiers et profils distincts, aucun reste temporaire", async () => {
    const { ws, p } = await projectionFixture();
    for (let k = 3; k <= 8; k++) p.agents.push({ agentId: AG(k), companyAlias: "e00001", profileAlias: `a0000${k}`, name: "Chef", statut: "actif", vuLe: null, instanceAlias: "i00001" });
    (p as unknown as { compteurs: { a: number } }).compteurs.a = 8;
    p.revision += 1;
    await writeFile(identitesFile(ws), JSON.stringify(p));
    const res = await Promise.all([3, 4, 5, 6, 7, 8].map((k) => prepareByIdentity({ ws, companyId: CA, agentId: AG(k), binaryFor })));
    expect(new Set(res.map((r) => r.agentDir)).size).toBe(6);
    expect((await readdir(join(ws.root, "donnees/e/e00001/a"))).sort()).toEqual(["a00003", "a00004", "a00005", "a00006", "a00007", "a00008"]);
  });

  it("reprise après interruption : clone tué à mi-course puis reste de création → la reprise garde le même alias, le même dossier, le même propriétaire", async () => {
    const { ws } = await projectionFixture();
    // 1. reste d'une création interrompue de CETTE identité (dossier temporaire) : nettoyé, la création aboutit
    const parent = join(ws.root, "donnees/e/e00001/a");
    await mkdir(parent, { recursive: true });
    const { createHash } = await import("node:crypto");
    await mkdir(join(parent, `.creation-${createHash("sha256").update(`${CA}/${AG(1)}`).digest("hex").slice(0, 16)}`));
    // 2. clone qui échoue après avoir créé le profil (comme un processus tué) : état « preparing » conservé
    const broken = join(root, "bin2");
    await mkdir(broken);
    await writeFile(join(broken, "hermes"), `#!/usr/bin/python3\nimport os,sys\np=os.path.join(os.environ["HERMES_HOME"],"profiles",sys.argv[3])\nos.makedirs(p,exist_ok=True)\nopen(os.path.join(p,"config.yaml"),"w").write("model: {}\\n")\nopen(os.path.join(p,".env"),"w").write("TELEGRAM_BOT_TOKEN=FAUX\\n")\nsys.exit(1)\n`, { mode: 0o755 });
    await expect(prepareByIdentity({ ws, companyId: CA, agentId: AG(1), binaryFor: async () => join(broken, "hermes") })).rejects.toThrow(/clone du profil « a00001 » en échec/);
    const owner1 = (await readOwner(join(parent, "a00001"))).owner;
    const r = await prepareByIdentity({ ws, companyId: CA, agentId: AG(1), binaryFor });
    expect(r.profile).toBe("a00001");
    expect(r.agentDir).toBe(join(parent, "a00001"));
    expect((await readOwner(r.agentDir)).owner).toEqual(owner1);
    expect(await readdir(parent)).toEqual(["a00001"]);
    expect(await readFile(join(r.profileHome, ".env"), "utf8")).not.toMatch(/TELEGRAM/);
  });

  it("T16 : enveloppe longue refusée AVANT création (ni profil, ni dossier, ni appel Hermes) ; racine d'exécution courte (lien) acceptée — chaîne transmise ≠ destination canonique", async () => {
    expect(budgetSockets("/home/packtest/Equipe/donnees/h/i00001/profiles/a00001").octets).toBe(91);
    expect(budgetSockets("/home/packtest/Equipe-un-dossier-beaucoup-plus-long-pour-les-tests/donnees/h/i00001/profiles/a00001").octets).toBe(136);
    const longRoot = join(root, "Equipe-un-dossier-beaucoup-plus-long-pour-les-tests");
    const { ws } = await projectionFixture(longRoot);
    await expect(prepareByIdentity({ ws, companyId: CA, agentId: AG(1), binaryFor })).rejects.toThrow(/avant toute création.*gateway\.loop-tick\.4194304\.sock = 1\d\d octets UTF-8 > 100/);
    await expect(lstat(join(longRoot, "donnees/h/i00001/profiles"))).rejects.toThrow();
    await expect(lstat(join(longRoot, "donnees/e"))).rejects.toThrow();
    expect(await fakeCalls(fakeDir)).toEqual([]);
    // racine d'exécution administrée courte (lien vers l'instance) : la chaîne passée à bind() tient, la destination reste l'instance
    await symlink(join(longRoot, "donnees/h/i00001"), join(root, "x1"));
    await setExecutionRoot(join(longRoot, "donnees/h/i00001"), join(root, "x1"));
    const r = await prepareByIdentity({ ws, companyId: CA, agentId: AG(1), binaryFor });
    expect(r.executionHome).toBe(join(root, "x1", "profiles", "a00001"));
    expect(budgetSockets(r.executionHome).ok).toBe(true);
    expect(await realpath(r.executionHome)).toBe(join(await realpath(longRoot), "donnees/h/i00001/profiles/a00001"));
  });
});
