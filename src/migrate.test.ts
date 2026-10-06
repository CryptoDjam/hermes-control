// Migration 0.6.1 : aucun lanceur exécuté ni lu pour autoriser ; fichiers étrangers ignorés ; un lanceur RÉFÉRENCÉ par un
// agent est visible et exige une correspondance explicite, validée contre les instances et profils existants.
import { beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsMapFile } from "./agents-map.js";
import { assignmentsFile, replaceTable, resolveAssignment } from "./assignments.js";
import { parseAgentCommands, parseConfirm, planMigration } from "./migrate.js";
import { makeFakeHermes, writeRoots } from "./testkit.js";

let root: string;
let instA: string;
let bin: string;
let marker: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hc-mig-"));
  process.env["HOME"] = root;
  const profils = join(root, "projet", "hermes", "profils");
  instA = join(profils, "direction");
  await mkdir(join(instA, "profiles", "chef"), { recursive: true });
  await writeFile(join(instA, "config.yaml"), "model: {}\n");
  await writeFile(join(instA, "profiles", "chef", "config.yaml"), "model: {}\n");
  await writeRoots(profils);
  bin = join(root, "projet", "hermes", "bin"); // <racine>/../bin : inventorié par défaut
  await mkdir(bin, { recursive: true });
  marker = join(root, "LANCE");
  // un lanceur (jamais exécuté : il laisserait une trace) et des fichiers étrangers
  await writeFile(join(bin, "hermes-chef"), `#!/bin/bash\necho x > "${marker}"\nexport HERMES_HOME="${join(instA, "profiles", "chef")}"\nexec hermes "$@"\n`);
  await chmod(join(bin, "hermes-chef"), 0o755);
  await writeFile(join(bin, "README.txt"), "notes\n");
  await writeFile(join(bin, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  // ancienne carte plate 0.5
  await mkdir(join(root, ".config", "hermes-control"), { recursive: true });
  await writeFile(agentsMapFile(), JSON.stringify({ "ag-chef": { name: "Chef", instance: "direction", profile: "chef", home: join(instA, "profiles", "chef"), at: "t" } }));
});

describe("planMigration (0.6.1)", () => {
  it("fichiers étrangers ignorés ; lanceurs inventoriés (empreinte) sans être exécutés ; sans export des agents → désaccord explicite", async () => {
    const r = await planMigration({ companyId: "co" });
    expect(r.foreignFiles.map((f) => f.split("/").pop()).sort()).toEqual(["README.txt", "image.png"]);
    expect(r.launchers.map((l) => l.path)).toEqual([join(bin, "hermes-chef")]);
    expect(r.launchers[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.disagreements.join(" ")).toMatch(/1 lanceur\(s\) présent\(s\) mais les hermesCommand des agents sont inconnus/);
    expect(r.disagreements.join(" ")).not.toMatch(/README|image/); // les étrangers ne créent pas de faux désaccord
    await expect(stat(marker)).rejects.toThrow();
  });

  it("lanceur RÉFÉRENCÉ par un agent : visible, bloquant tant qu'il n'y a pas de correspondance explicite ; --confirm validé contre les instances et profils", async () => {
    const commands = parseAgentCommands([{ id: "ag-chef", name: "Chef", adapterConfig: { hermesCommand: join(bin, "hermes-chef") } }]);
    const fake = await makeFakeHermes(join(root, "hb"));
    const r1 = await planMigration({ companyId: "co", agentCommands: commands, hermes: { binary: fake } });
    expect(r1.launchers[0]!.referencedBy).toEqual(["ag-chef"]);
    expect(r1.rows[0]!.launcherReferenced).toBe(true);
    expect(r1.disagreements.join(" ")).toMatch(/lanceur RÉFÉRENCÉ par l'agent .*hermes-chef.*correspondance explicite requise \(--confirm ag-chef=/);
    // correspondance vers un profil inexistant → désaccord
    const bad = await planMigration({ companyId: "co", agentCommands: commands, hermes: { binary: fake }, confirm: { "ag-chef": { instanceHome: instA, profile: "inexistant" } } });
    expect(bad.disagreements.join(" ")).toMatch(/profiles\/inexistant sans config.yaml/);
    // correspondance explicite valide → plus de désaccord, table proposée avec binaire administré
    const ok = await planMigration({ companyId: "co", agentCommands: commands, hermes: { binary: fake }, confirm: { "ag-chef": { instanceHome: instA, profile: "chef" } } });
    expect(ok.disagreements).toEqual([]);
    expect(ok.proposedTable.hermes).toEqual({ binary: fake });
    expect(ok.proposedTable.agents["ag-chef"]).toMatchObject({ instanceHome: instA, profile: "chef", assignedBy: "migration:confirmation" });
    await replaceTable(ok.proposedTable, { roots: ok.knownRoots });
    expect((await resolveAssignment("ag-chef")).ok?.hermes).toEqual({ binary: fake });
    await expect(stat(marker)).rejects.toThrow(); // jamais exécuté
    expect(parseConfirm(`ag=${instA}:chef`)).toEqual({ agentId: "ag", instanceHome: instA, profile: "chef" });
    expect(parseConfirm("ag=rel:chef")).toBeNull();
  });

  it("binaire administré refusé (lanceur shell) → désaccord ; racine d'exécution courte conservée et mesurée ; alias vers une autre instance → désaccord", async () => {
    const r = await planMigration({ companyId: "co", agentCommands: {}, hermes: { binary: join(bin, "hermes-chef") } });
    expect(r.disagreements.join(" ")).toMatch(/binaire Hermes : .*script shell \(bash\)/);
    await mkdir(join(root, ".h"));
    await symlink(instA, join(root, ".h", "d"));
    await symlink(root, join(root, ".h", "x"));
    const fake = await makeFakeHermes(join(root, "hb"));
    const ok = await planMigration({ companyId: "co", agentCommands: {}, hermes: { binary: fake }, executionRoots: { [instA]: "~/.h/d" } });
    expect(ok.rows[0]!.executionHome).toBe(join(root, ".h", "d", "profiles", "chef"));
    expect(ok.proposedTable.instances).toEqual({ [instA]: { executionRoot: "~/.h/d" } });
    expect(ok.disagreements).toEqual([]);
    const alias = await planMigration({ companyId: "co", agentCommands: {}, hermes: { binary: fake }, executionRoots: { [instA]: "~/.h/x" } });
    expect(alias.disagreements.join(" ")).toMatch(/racine d'exécution .*\.h\/x : désigne .*pas l'instance/);
    await expect(stat(assignmentsFile())).rejects.toThrow(); // planMigration n'écrit rien
  });
});
