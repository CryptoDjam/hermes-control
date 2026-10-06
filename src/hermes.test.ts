import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeName, hermes, hermesCallEnv, parseAuthStatus, parseConfig, readConfigStrict, readInstance } from "./hermes.js";

describe("parseConfig", () => {
  it("lit le modèle et le fournisseur", () => {
    const cfg = parseConfig("model:\n  provider: openai-codex\n  default: gpt-5.6-luna\ntoolsets: [file, productivity]\napprovals:\n  mode: manual\n");
    expect((cfg["model"] as Record<string, string>)["default"]).toBe("gpt-5.6-luna");
    expect(cfg["toolsets"]).toEqual(["file", "productivity"]);
    expect((cfg["approvals"] as Record<string, string>)["mode"]).toBe("manual");
  });
  it("ne plante pas sur un fichier cassé", () => {
    expect(parseConfig("model: [oops")).toEqual({});
  });
});

describe("parseAuthStatus", () => {
  it("reconnaît les états de hermes auth status", () => {
    expect(parseAuthStatus("openai-codex: logged in")).toBe("logged_in");
    expect(parseAuthStatus("openai-codex: logged out (No Codex credentials stored. Run `hermes auth`)")).toBe("logged_out");
    expect(parseAuthStatus("???")).toBe("unknown");
  });
  it("les négations passent avant les mots positifs", () => {
    expect(parseAuthStatus("openai-codex: not logged in")).toBe("logged_out");
    expect(parseAuthStatus("anthropic: invalid credentials")).toBe("logged_out");
    expect(parseAuthStatus("token expired, run hermes auth")).toBe("logged_out");
    expect(parseAuthStatus("not authenticated")).toBe("logged_out");
    expect(parseAuthStatus("No API credentials stored")).toBe("logged_out");
    expect(parseAuthStatus("Logged in as x (valid)")).toBe("logged_in");
  });
});

describe("assertSafeName", () => {
  it("accepte les noms de profils simples et refuse le reste", () => {
    expect(assertSafeName("apolline-m")).toBe("apolline-m");
    expect(() => assertSafeName("../x")).toThrow();
    expect(() => assertSafeName("a b")).toThrow();
  });
});

describe("aucun lanceur n'est plus lu (0.6.1)", () => {
  it("homeFromLauncherFile et resolveHomeFromLauncher n'existent plus ; hermes() refuse sans binaire administré et n'utilise jamais un nom cherché dans le PATH", async () => {
    const mod = (await import("./hermes.js")) as Record<string, unknown>;
    expect(mod["homeFromLauncherFile"]).toBeUndefined();
    expect(mod["resolveHomeFromLauncher"]).toBeUndefined();
    await expect(hermes("/tmp", ["--version"], null)).rejects.toThrow(/aucun binaire Hermes administré/);
    await expect(hermes("/tmp", ["--version"], "hermes")).rejects.toThrow(/aucun binaire Hermes administré/); // nom nu : refusé
  });

  it("environnement EXPLICITE des appels du plugin : PATH = dossier de l'interpréteur d'abord, HOME = dossier du compte, HERMES_HOME ; rien d'autre n'est hérité", async () => {
    const saved = process.env["SECRET_DU_SERVICE"];
    process.env["SECRET_DU_SERVICE"] = "x";
    try {
      const env = hermesCallEnv("/srv/h/profiles/p", { path: "/opt/venv/bin/hermes", pathPrefix: ["/opt/venv/bin"] });
      expect(env["HERMES_HOME"]).toBe("/srv/h/profiles/p");
      expect(env["PATH"]!.split(":")[0]).toBe("/opt/venv/bin");
      expect(env["HOME"]).toBe(process.env["HOME"]); // tests : le dossier du compte est redirigé vers $HOME temporaire
      expect(env["SECRET_DU_SERVICE"]).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env["SECRET_DU_SERVICE"];
      else process.env["SECRET_DU_SERVICE"] = saved;
    }
  });
});

describe("readConfigStrict", () => {

  it("absent → {} sans erreur ; valide → objet ; invalide ou pas un objet → error, fichier intact", async () => {
    const home = await mkdtemp(join(tmpdir(), "hc-cfg-"));
    expect(await readConfigStrict(home)).toEqual({ cfg: {}, error: null });
    await writeFile(join(home, "config.yaml"), "model:\n  default: a\n");
    expect((await readConfigStrict(home)).cfg).toEqual({ model: { default: "a" } });
    await writeFile(join(home, "config.yaml"), "model: [oops\n");
    const bad = await readConfigStrict(home);
    expect(bad.error).toMatch(/config.yaml invalide/);
    expect(bad.cfg).toEqual({});
    await writeFile(join(home, "config.yaml"), "- a\n- b\n");
    expect((await readConfigStrict(home)).error).toMatch(/pas un objet/);
    expect(await readFile(join(home, "config.yaml"), "utf8")).toBe("- a\n- b\n"); // jamais réécrit
  });

  it("clés dupliquées tolérées (comme safe_load Python)", async () => {
    const home = await mkdtemp(join(tmpdir(), "hc-cfg-"));
    await writeFile(join(home, "config.yaml"), "model:\n  default: a\nmodel:\n  default: b\n");
    const r = await readConfigStrict(home);
    expect(r.error).toBeNull();
    expect(r.cfg).toEqual({ model: { default: "b" } });
  });

  it("readInstance porte configError sur le profil illisible", async () => {
    const home = await mkdtemp(join(tmpdir(), "hc-cfg-"));
    await writeFile(join(home, "config.yaml"), "model: [oops\n");
    const inst = await readInstance("x", home, null, "/bin/false", null, { light: true });
    expect(inst.profiles[0]!.configError).toMatch(/invalide/);
  });
});
