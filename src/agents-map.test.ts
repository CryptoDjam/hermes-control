import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsMapFile, recallAgent, rememberAgent } from "./agents-map.js";

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

describe("carte agentId → profil Hermes", () => {
  it("rend null quand le fichier n'existe pas", async () => {
    expect(await recallAgent("inconnu")).toBeNull();
  });

  it("mémorise puis retrouve un agent, dans ~/.config/hermes-control/agents.json", async () => {
    await rememberAgent("a1", { name: "Chef", instance: "direction", profile: "default", home: join(root, "direction") });
    const got = await recallAgent("a1");
    expect(got?.home).toBe(join(root, "direction"));
    expect(got?.name).toBe("Chef");
    expect(agentsMapFile()).toBe(join(root, ".config", "hermes-control", "agents.json"));
    const raw = JSON.parse(await readFile(agentsMapFile(), "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(["a1"]);
  });

  it("garde les autres agents et met à jour celui qui change", async () => {
    await rememberAgent("a1", { name: "Chef", instance: "direction", profile: "default", home: "/x/direction" });
    await rememberAgent("a2", { name: "CMO", instance: "marketing", profile: "default", home: "/x/marketing" });
    await rememberAgent("a1", { name: "Chef", instance: "direction", profile: "default", home: "/y/direction" });
    expect((await recallAgent("a1"))?.home).toBe("/y/direction");
    expect((await recallAgent("a2"))?.home).toBe("/x/marketing");
  });
});

describe("agents.json corrompu et verrou", () => {
  it("fichier corrompu : rememberAgent refuse et ne touche pas au fichier ; recallAgent rend null", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(agentsMapFile()), { recursive: true });
    await writeFile(agentsMapFile(), "{ pas du json\n");
    await expect(rememberAgent("a1", { name: "Chef", instance: "direction", profile: "default", home: "/x" })).rejects.toThrow(/corrompu.*rien n'est écrit/);
    expect(await readFile(agentsMapFile(), "utf8")).toBe("{ pas du json\n");
    expect(await recallAgent("a1")).toBeNull();
    const { agentsMapError } = await import("./agents-map.js");
    expect(await agentsMapError()).toMatch(/corrompu/);
    await writeFile(agentsMapFile(), "[1,2]\n");
    await expect(rememberAgent("a1", { name: "Chef", instance: "direction", profile: "default", home: "/x" })).rejects.toThrow(/pas un objet/);
    expect(await readFile(agentsMapFile(), "utf8")).toBe("[1,2]\n");
  });

  it("deux rememberAgent concurrents → les deux entrées présentes (verrou agents.json.lock relâché)", async () => {
    await Promise.all([
      rememberAgent("a1", { name: "Chef", instance: "direction", profile: "default", home: "/x/direction" }),
      rememberAgent("a2", { name: "CMO", instance: "marketing", profile: "default", home: "/x/marketing" }),
    ]);
    const raw = JSON.parse(await readFile(agentsMapFile(), "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(["a1", "a2"]);
    const { lstat } = await import("node:fs/promises");
    await expect(lstat(`${agentsMapFile()}.lock`)).rejects.toThrow();
  });
});
