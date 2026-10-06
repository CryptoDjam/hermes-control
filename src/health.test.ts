import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOCKET_PATH_MAX, agentState, checkProfile, checkSkillHeader } from "./health.js";

describe("checkProfile", () => {
  it("mesure gateway.sock et les *.sock présents, signale un chemin trop long", async () => {
    const short = await mkdtemp(join(tmpdir(), "hc-h-"));
    const ok = await checkProfile(short);
    expect(ok.socketPathBytes).toBe(Buffer.byteLength(join(short, "gateway.sock")));
    expect(ok.socketPathOk).toBe(true);
    expect(ok.alerts).toEqual([]);
    const deep = join(short, "a".repeat(SOCKET_PATH_MAX));
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, "x.sock"), "");
    const ko = await checkProfile(deep);
    expect(ko.sockets).toEqual(["x.sock"]);
    expect(ko.socketPathOk).toBe(false);
    expect(ko.alerts.join(" ")).toMatch(/socket trop long/);
  });

  it("en-tête YAML des skills : valide, invalide, caché par `platforms:` ; config.yaml illisible", async () => {
    const home = await mkdtemp(join(tmpdir(), "hc-h-"));
    await mkdir(join(home, "skills", "bonne"), { recursive: true });
    await writeFile(join(home, "skills", "bonne", "SKILL.md"), "---\nname: bonne\ndescription: ok\n---\n# bonne\n");
    await mkdir(join(home, "skills", "cachee"), { recursive: true });
    await writeFile(join(home, "skills", "cachee", "SKILL.md"), "---\nname: cachee\ndescription: a: b: c\nplatforms: [telegram\n---\n");
    await mkdir(join(home, "skills", "cassee"), { recursive: true });
    await writeFile(join(home, "skills", "cassee", "SKILL.md"), "---\nname: [oops\n---\n");
    await writeFile(join(home, "config.yaml"), "model: [oops\n");
    const h = await checkProfile(home);
    expect(h.skills).toEqual([
      { name: "bonne", yamlOk: true, hiddenByPlatforms: false },
      { name: "cachee", yamlOk: false, hiddenByPlatforms: true },
      { name: "cassee", yamlOk: false, hiddenByPlatforms: false },
    ]);
    expect(h.configError).toMatch(/invalide/);
    expect(h.alerts).toHaveLength(3);
    expect(h.alerts.join("\n")).toMatch(/« cachee » cachée/);
  });

  it("checkSkillHeader sans en-tête → yamlOk faux", () => {
    expect(checkSkillHeader("x", "# pas d'en-tête\n")).toEqual({ name: "x", yamlOk: false, hiddenByPlatforms: false });
  });
});

describe("agentState (trois états)", () => {
  it("installé sans connexion ; connecté si logged_in ; autorisé si connecté et synchro sans erreur", () => {
    expect(agentState({ error: null }, { authStatus: "logged_out" })).toBe("installed");
    expect(agentState({ error: null }, { authStatus: "unknown" })).toBe("installed");
    expect(agentState({ error: "x" }, { authStatus: "logged_in" })).toBe("connected");
    expect(agentState({ error: null }, { authStatus: "logged_in" })).toBe("authorized");
  });
});
