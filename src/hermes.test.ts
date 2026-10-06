import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeName, homeFromLauncherFile, parseAuthStatus, parseConfig, readConfigStrict, readInstance } from "./hermes.js";

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

describe("homeFromLauncherFile (lecture statique, sans exécution)", () => {

  it("lanceur de la forme ProjetC/hermes/bin/hermes-cmo (non exécutable) → PROJETC/hermes/profils/marketing", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-launcher-"));
    const bin = join(root, "ProjetC", "hermes", "bin");
    await mkdir(bin, { recursive: true });
    const launcher = join(bin, "hermes-cmo");
    await writeFile(launcher, `#!/bin/bash
# Lanceur de l'agent « cmo » : profil Hermes cmo de l'instance « marketing ».
PROJETC="\${PROJETC:-$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)}"
export PROJETC
export HERMES_HOME="$PROJETC/hermes/profils/marketing"
export HERMES_WRITE_SAFE_ROOT="$PROJETC/agents/cmo:$HOME/Work/site"
HERMES_BIN="\${HERMES_BIN:-$HOME/.local/share/hermes-0.21/bin/hermes}"
[ -x "$HERMES_BIN" ] || HERMES_BIN="$HOME/.local/bin/hermes"
exec "$HERMES_BIN" "$@"
`, { mode: 0o644 });
    expect((await stat(launcher)).mode & 0o111).toBe(0); // pas exécutable : la lecture est forcément statique
    expect(await homeFromLauncherFile(launcher)).toBe(join(root, "ProjetC", "hermes", "profils", "marketing"));
  });

  it("résout $HOME, ${HOME}, ~ et une variable affectée littéralement plus haut", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-launcher-"));
    const a = join(root, "a");
    await writeFile(a, 'BASE="$HOME/.hermes-x"\nexport HERMES_HOME=${BASE}/direction\n');
    expect(await homeFromLauncherFile(a)).toBe(join(homedir(), ".hermes-x", "direction"));
    const b = join(root, "b");
    await writeFile(b, "HERMES_HOME=~/.hermes\n");
    expect(await homeFromLauncherFile(b)).toBe(join(homedir(), ".hermes"));
    const c = join(root, "c");
    await writeFile(c, 'ROOT=/srv/hermes\nexport HERMES_HOME="${ROOT}/prod"  # commentaire\n');
    expect(await homeFromLauncherFile(c)).toBe("/srv/hermes/prod");
  });

  it("apostrophes = littéral (sauf si elles contiennent $) ; `VAR=x commande` ignoré ; lanceur relatif refusé ; résultat par realpath", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-launcher-"));
    await writeFile(join(root, "sq"), "export HERMES_HOME='/srv/h$HOME'\n");
    expect(await homeFromLauncherFile(join(root, "sq"))).toBeNull();
    await writeFile(join(root, "sq2"), "ROOT='/srv/h'\nexport HERMES_HOME=\"$ROOT/prod\"\n");
    expect(await homeFromLauncherFile(join(root, "sq2"))).toBe("/srv/h/prod");
    await writeFile(join(root, "cmd"), "HERMES_HOME=/ailleurs exec hermes \"$@\"\nexport HERMES_HOME=/srv/vrai\n");
    expect(await homeFromLauncherFile(join(root, "cmd"))).toBe("/srv/vrai");
    expect(await homeFromLauncherFile("bin/hermes-x")).toBeNull();
    // le dossier visé est un lien : on renvoie le chemin réel
    await mkdir(join(root, "reel"));
    await symlink(join(root, "reel"), join(root, "lien"));
    await writeFile(join(root, "ln"), `HERMES_HOME=${join(root, "lien")}\n`);
    expect(await homeFromLauncherFile(join(root, "ln"))).toBe(join(root, "reel"));
  });

  it("null si pas de HERMES_HOME, variable inconnue, sous-shell, fichier absent ou trop gros", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-launcher-"));
    await writeFile(join(root, "none"), "#!/bin/bash\nexec hermes \"$@\"\n");
    expect(await homeFromLauncherFile(join(root, "none"))).toBeNull();
    await writeFile(join(root, "unknown"), "HERMES_HOME=$MYSTERE/x\n");
    expect(await homeFromLauncherFile(join(root, "unknown"))).toBeNull();
    await writeFile(join(root, "subshell"), 'HERMES_HOME="$(hermes config path)"\n');
    expect(await homeFromLauncherFile(join(root, "subshell"))).toBeNull();
    expect(await homeFromLauncherFile(join(root, "absent"))).toBeNull();
    await writeFile(join(root, "big"), "#".repeat(70 * 1024) + "\nHERMES_HOME=/x\n");
    expect(await homeFromLauncherFile(join(root, "big"))).toBeNull();
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
