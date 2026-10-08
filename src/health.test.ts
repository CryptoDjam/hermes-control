import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOCKET_PATH_MAX, WORST_CASE_PID, agentState, checkProfile, checkSkillHeader, checkSocketPaths, expectedSocketPaths } from "./health.js";

describe("checkProfile", () => {
  it("mesure gateway.sock, le socket du watchdog (state/gateway.loop-tick.<pid 7 chiffres>.sock) et les *.sock présents (home et state/)", async () => {
    const short = await mkdtemp(join(tmpdir(), "hc-h-"));
    const ok = await checkProfile(short);
    expect(expectedSocketPaths(short)).toEqual([join(short, "gateway.sock"), join(short, "state", `gateway.loop-tick.${WORST_CASE_PID}.sock`), join(short, "bot-desktop", "rfb.sock")]);
    expect(WORST_CASE_PID).toBe("4194304");
    expect(ok.longest).toBe(join(short, "state", "gateway.loop-tick.4194304.sock"));
    expect(ok.socketPathBytes).toBe(Buffer.byteLength(ok.longest));
    expect(ok.socketPathOk).toBe(true);
    expect(ok.alerts).toEqual([]);
    const deep = join(short, "a".repeat(SOCKET_PATH_MAX));
    await mkdir(join(deep, "state"), { recursive: true });
    await writeFile(join(deep, "x.sock"), "");
    await writeFile(join(deep, "state", "gateway.loop-tick.12.sock"), "");
    const ko = await checkProfile(deep);
    expect(ko.sockets).toEqual(["x.sock", "state/gateway.loop-tick.12.sock"]);
    expect(ko.socketPathOk).toBe(false);
    expect(ko.alerts.join(" ")).toMatch(/socket trop long/);
  });

  it("NON-RÉGRESSION (sonde Codex n°5) : racine de 80 octets, aucun socket encore créé → socketPathOk FAUX (le chemin du watchdog dépasse 108)", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-h-"));
    const home = join(root, "x".repeat(80 - Buffer.byteLength(root) - 1));
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.yaml"), "model: {}\n");
    expect(Buffer.byteLength(home)).toBe(80);
    const result = await checkProfile(home);
    expect(result.socketPathOk).toBe(false);
    expect(result.sockets).toEqual([]); // vérifié AVANT tout démarrage
    expect(Buffer.byteLength(join(home, "state", "gateway.loop-tick.123456.sock"))).toBeGreaterThan(108);
    expect(result.socketPathBytes).toBe(80 + "/state/gateway.loop-tick.4194304.sock".length);
    expect(result.alerts[0]).toMatch(/gateway\.loop-tick\.4194304\.sock/);
    expect((await checkSocketPaths(home)).socketPathOk).toBe(false);
    // la limite : 100 octets au total → une racine de 63 octets passe encore
    const limit = join(root, "y".repeat(100 - "/state/gateway.loop-tick.4194304.sock".length - Buffer.byteLength(root) - 1));
    await mkdir(limit, { recursive: true });
    expect((await checkSocketPaths(limit)).socketPathBytes).toBe(100);
    expect((await checkSocketPaths(limit)).socketPathOk).toBe(true);
  });

  it("socketBase : lien court vers une racine profonde → mesuré sur le lien (OK) ; le même profil mesuré sur son chemin long → refus", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-h-"));
    const deep = join(root, "x".repeat(80 - Buffer.byteLength(root) - 1));
    await mkdir(join(deep, "state"), { recursive: true });
    await writeFile(join(deep, "state", "gateway.loop-tick.12.sock"), "");
    const short = join(root, "d");
    await symlink(deep, short);
    const viaLink = await checkProfile(deep, short);
    expect(viaLink.socketBase).toBe(short);
    expect(viaLink.socketPathOk).toBe(true);
    expect(viaLink.longest).toBe(join(short, "state", "gateway.loop-tick.4194304.sock"));
    expect(viaLink.sockets).toEqual(["state/gateway.loop-tick.12.sock"]); // les sockets présents se lisent à travers le lien
    expect(viaLink.alerts).toEqual([]);
    const direct = await checkProfile(deep);
    expect(direct.socketBase).toBe(deep);
    expect(direct.socketPathOk).toBe(false);
    expect(direct.alerts.join(" ")).toMatch(/socket trop long/);
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

  it("checkSkillHeader sans en-tête → yamlOk faux ; clés dupliquées tolérées (safe_load)", () => {
    expect(checkSkillHeader("x", "# pas d'en-tête\n")).toEqual({ name: "x", yamlOk: false, hiddenByPlatforms: false });
    expect(checkSkillHeader("d", "---\nname: d\nname: d2\nplatforms: [telegram]\n---\n")).toEqual({ name: "d", yamlOk: true, hiddenByPlatforms: false });
  });
});

describe("agentState (trois états)", () => {
  it("installé sans connexion ; connecté si logged_in ; « connecté et synchronisé » si connecté et synchro sans erreur (jamais « autorisé »)", async () => {
    const { STATE_LABEL } = await import("./health.js");
    expect(agentState({ error: null }, { authStatus: "logged_out" })).toBe("installed");
    expect(agentState({ error: null }, { authStatus: "unknown" })).toBe("installed");
    expect(agentState({ error: "x" }, { authStatus: "logged_in" })).toBe("connected");
    expect(agentState({ error: null }, { authStatus: "logged_in" })).toBe("synced");
    expect(STATE_LABEL.synced).toBe("connecté et synchronisé");
    expect(Object.values(STATE_LABEL)).not.toContain("autorisé");
  });
});
