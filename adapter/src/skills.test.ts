import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import { reconcileIntoProfile, scanProfileSkills, snapshotForProfile } from "./skills.js";

let root: string;
let savedHome: string | undefined;
let profile: string;
let srcA: string;
let srcB: string;
let inventory: Record<string, unknown>;

async function skill(dir: string, name: string, desc = "desc") {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`);
}
const exists = (p: string) => lstat(p).then(() => true, () => false);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hc-skills-"));
  savedHome = process.env["HOME"];
  process.env["HOME"] = root;
  profile = join(root, "direction");
  await mkdir(profile, { recursive: true });
  srcA = join(root, "paperclip-src", "paperclip");
  srcB = join(root, "paperclip-src", "first-task");
  await skill(srcA, "paperclip", "API Paperclip");
  await skill(srcB, "first-task", "Première tâche");
  inventory = {
    paperclipRuntimeSkills: [
      { key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source: srcA },
      { key: "paperclipai/paperclip/first-task", runtimeName: "first-task", source: srcB },
    ],
    paperclipSkillSync: { desiredSkills: [{ key: "paperclipai/paperclip/first-task", versionId: null }] },
  };
});
afterEach(() => {
  if (savedHome) process.env["HOME"] = savedHome;
});

describe("reconcileIntoProfile", () => {
  it("pose les liens des skills désirés dans <profil>/skills (paperclip toujours inclus)", async () => {
    const r = await reconcileIntoProfile(inventory, profile);
    expect(r.skillsDir).toBe(join(profile, "skills"));
    expect(r.linked.sort()).toEqual(["first-task", "paperclip"]);
    expect(await readlink(join(profile, "skills", "first-task"))).toBe(srcB);
    expect(r.warnings).toEqual([]);
  });

  it("accepte un lien existant qui résout vers la même source (lien via ~/.hermes/skills)", async () => {
    const hub = join(root, ".hermes", "skills");
    await mkdir(hub, { recursive: true });
    await symlink(srcA, join(hub, "paperclip"));
    await mkdir(join(profile, "skills"), { recursive: true });
    await symlink(join(hub, "paperclip"), join(profile, "skills", "paperclip"));
    const r = await reconcileIntoProfile(inventory, profile);
    expect(r.linked).toContain("paperclip");
    expect(await readlink(join(profile, "skills", "paperclip"))).toBe(join(hub, "paperclip")); // inchangé
    expect(r.warnings).toEqual([]);
  });

  it("remplace un lien mort", async () => {
    await mkdir(join(profile, "skills"), { recursive: true });
    await symlink(join(root, "nulle-part"), join(profile, "skills", "first-task"));
    const r = await reconcileIntoProfile(inventory, profile);
    expect(r.linked).toContain("first-task");
    expect(await readlink(join(profile, "skills", "first-task"))).toBe(srcB);
  });

  it("n'écrase pas un lien vivant vers autre chose : avertissement", async () => {
    const other = join(root, "autre", "first-task");
    await skill(other, "first-task", "autre");
    await mkdir(join(profile, "skills"), { recursive: true });
    await symlink(other, join(profile, "skills", "first-task"));
    const r = await reconcileIntoProfile(inventory, profile);
    expect(r.linked).not.toContain("first-task");
    expect(r.warnings.join(" ")).toMatch(/occupé/);
    expect(await readlink(join(profile, "skills", "first-task"))).toBe(other);
  });

  it("retire un skill décoché, mais jamais un lien vers une source non Paperclip", async () => {
    await reconcileIntoProfile(inventory, profile);
    const mine = join(root, "hermes-skills", "comfyui");
    await skill(mine, "comfyui");
    await symlink(mine, join(profile, "skills", "comfyui"));
    // décoché : plus de first-task dans la liste passée par syncSkills
    const r = await reconcileIntoProfile(inventory, profile, []);
    expect(r.removed).toEqual(["first-task"]);
    expect(await exists(join(profile, "skills", "first-task"))).toBe(false);
    expect(await exists(join(profile, "skills", "paperclip"))).toBe(true);
    expect(await exists(join(profile, "skills", "comfyui"))).toBe(true);
  });

  it("inventaire vide : ne touche à rien", async () => {
    const r = await reconcileIntoProfile({ paperclipRuntimeSkills: [] }, profile);
    expect(r.linked).toEqual([]);
    expect(await exists(join(profile, "skills"))).toBe(false);
  });
});

describe("snapshotForProfile", () => {
  it("montre le lien du profil pour les skills gérés et ajoute les skills propres au profil", async () => {
    await reconcileIntoProfile(inventory, profile);
    const mine = join(root, "hermes-skills", "comfyui");
    await skill(mine, "comfyui", "Images ComfyUI");
    await symlink(mine, join(profile, "skills", "comfyui"));
    const base = {
      adapterType: "hermes_local", supported: true, mode: "persistent", desiredSkills: [], warnings: [],
      entries: [
        { key: "paperclipai/paperclip/first-task", runtimeName: "first-task", desired: true, managed: true, state: "configured", sourcePath: srcB, targetPath: null, detail: "x" },
        { key: "paperclipai/paperclip/paperclip-board", runtimeName: "paperclip-board", desired: false, managed: true, state: "available", sourcePath: null, targetPath: null, detail: null },
        { key: "omarchy", runtimeName: "omarchy", desired: true, managed: false, state: "installed", origin: "user_installed", readOnly: true, locationLabel: "~/.hermes/skills/omarchy" },
      ],
    } as AdapterSkillSnapshot;
    const out = await snapshotForProfile(base, profile, "direction/default");
    const ft = out.entries.find((e) => e.runtimeName === "first-task")!;
    expect(ft.state).toBe("configured");
    expect(ft.targetPath).toBe(join(profile, "skills", "first-task"));
    expect(ft.detail).toMatch(/direction\/default/);
    expect(out.entries.find((e) => e.runtimeName === "omarchy")).toBeUndefined(); // ~/.hermes/skills : pas lu par ce profil
    const cf = out.entries.find((e) => e.runtimeName === "comfyui")!;
    expect(cf.readOnly).toBe(true);
    expect(cf.detail).toBe("Images ComfyUI");
    expect(out.entries.find((e) => e.runtimeName === "paperclip-board")!.state).toBe("available");
  });

  it("skill désiré mais pas encore lié → missing avec explication", async () => {
    const base = { adapterType: "hermes_local", supported: true, mode: "persistent", desiredSkills: [], warnings: [], entries: [{ key: "k", runtimeName: "first-task", desired: true, managed: true, state: "configured", sourcePath: srcB }] } as AdapterSkillSnapshot;
    const out = await snapshotForProfile(base, profile, "direction/default");
    expect(out.entries[0]!.state).toBe("missing");
    expect(out.entries[0]!.detail).toMatch(/prochain passage/);
  });

  it("scanProfileSkills ignore les fichiers cachés et les dossiers sans SKILL.md", async () => {
    await mkdir(join(profile, "skills", ".hub"), { recursive: true });
    await mkdir(join(profile, "skills", "vide"), { recursive: true });
    await skill(join(profile, "skills", "rapport"), "rapport", "Compte rendu");
    expect((await scanProfileSkills(profile)).map((s) => s.name)).toEqual(["rapport"]);
  });
});
