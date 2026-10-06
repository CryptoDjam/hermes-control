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

describe("homeFromLauncherFile (lecture statique, sans exécution) : { home } ou { error }, jamais une conformité par défaut", () => {
  /** Forme réelle de ~/Projects/ProjetC/hermes/bin/hermes-cmo (relue le 06/10/2026). */
  const REAL_FORM = (home: string) => `#!/bin/bash
# Lanceur de l'agent « cmo » : profil Hermes cmo de l'instance « marketing ». Utilisé par Paperclip (champ hermesCommand).
# Le projet est déduit de l'emplacement du script (PROJETC peut être forcé par l'environnement).
PROJETC="\${PROJETC:-$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)}"
export PROJETC
export HERMES_HOME="${home}"
export HERMES_WRITE_SAFE_ROOT="$PROJETC/agents/cmo:$PROJETC/agents/apolline-m/contenus/brouillons:$PROJETC/agents/creation_contenus:$HOME/Work/site/atelier/test"
# 06/10/2026 : Hermes 0.21.5 (tag v2026.9.24, installé à part) ; repli sur la 0.19 de ~/.local/bin si absent. Forçable : HERMES_BIN=/chemin/vers/hermes
HERMES_BIN="\${HERMES_BIN:-$HOME/.local/share/hermes-0.21/bin/hermes}"
[ -x "$HERMES_BIN" ] || HERMES_BIN="$HOME/.local/bin/hermes"
exec "$HERMES_BIN" "$@"
`;

  it("lanceur conforme de la forme ProjetC/hermes/bin/hermes-cmo (non exécutable) → PROJETC/hermes/profils/marketing", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-launcher-"));
    const bin = join(root, "ProjetC", "hermes", "bin");
    await mkdir(bin, { recursive: true });
    const launcher = join(bin, "hermes-cmo");
    await writeFile(launcher, REAL_FORM("$PROJETC/hermes/profils/marketing"), { mode: 0o644 });
    expect((await stat(launcher)).mode & 0o111).toBe(0); // pas exécutable : la lecture est forcément statique
    const marketing = join(root, "ProjetC", "hermes", "profils", "marketing");
    expect(await homeFromLauncherFile(launcher)).toEqual({ home: marketing, literal: marketing, error: null });
  });

  it("résout $HOME, ${HOME}, ~ et une variable affectée littéralement plus haut", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-launcher-"));
    const a = join(root, "a");
    await writeFile(a, 'BASE="$HOME/.hermes-x"\nexport HERMES_HOME=${BASE}/direction\n');
    expect((await homeFromLauncherFile(a)).home).toBe(join(homedir(), ".hermes-x", "direction"));
    const b = join(root, "b");
    await writeFile(b, "HERMES_HOME=~/.hermes\n");
    expect((await homeFromLauncherFile(b)).home).toBe(join(homedir(), ".hermes"));
    const c = join(root, "c");
    await writeFile(c, 'ROOT=/srv/hermes\nexport HERMES_HOME="${ROOT}/prod"  # commentaire\n');
    expect((await homeFromLauncherFile(c)).home).toBe("/srv/hermes/prod");
  });

  it("apostrophes = littéral (sauf si elles contiennent $ → erreur) ; `VAR=x commande` ignoré ; lanceur relatif refusé ; résultat par realpath", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-launcher-"));
    await writeFile(join(root, "sq"), "export HERMES_HOME='/srv/h$HOME'\n");
    expect((await homeFromLauncherFile(join(root, "sq"))).error).toMatch(/non résolu/);
    await writeFile(join(root, "sq2"), "ROOT='/srv/h'\nexport HERMES_HOME=\"$ROOT/prod\"\n");
    expect((await homeFromLauncherFile(join(root, "sq2"))).home).toBe("/srv/h/prod");
    await writeFile(join(root, "cmd"), "HERMES_HOME=/ailleurs exec hermes \"$@\"\nexport HERMES_HOME=/srv/vrai\n");
    expect((await homeFromLauncherFile(join(root, "cmd"))).home).toBe("/srv/vrai");
    expect((await homeFromLauncherFile("bin/hermes-x")).error).toMatch(/relatif/);
    // le dossier visé est un lien : on renvoie le chemin réel
    await mkdir(join(root, "reel"));
    await symlink(join(root, "reel"), join(root, "lien"));
    await writeFile(join(root, "ln"), `HERMES_HOME=${join(root, "lien")}\n`);
    expect((await homeFromLauncherFile(join(root, "ln"))).home).toBe(join(root, "reel"));
    expect((await homeFromLauncherFile(join(root, "ln"))).literal).toBe(join(root, "lien"));
  });

  it("lien court vers une racine profonde (forme de prod `$HOME/.h/d/profiles/assistant`) : home = chemin réel, literal = chemin tel qu'écrit (sockets)", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-launcher-"));
    const savedHome = process.env["HOME"];
    process.env["HOME"] = root;
    try {
      const deep = join(root, "Projects", "ProjetC", "hermes", "profils", "direction");
      await mkdir(join(deep, "profiles", "assistant"), { recursive: true });
      await mkdir(join(root, ".h"));
      await symlink(deep, join(root, ".h", "d"));
      const launcher = join(root, "hermes-assistant");
      await writeFile(launcher, '#!/bin/bash\nexport HERMES_HOME="$HOME/.h/d/profiles/assistant"\nexec hermes "$@"\n');
      const r = await homeFromLauncherFile(launcher);
      expect(r).toEqual({ home: join(deep, "profiles", "assistant"), literal: join(root, ".h", "d", "profiles", "assistant"), error: null });
      expect(r.home).not.toBe(r.literal);
      // ~ et ./.. sont normalisés, mais le lien n'est jamais suivi dans literal
      await writeFile(launcher, "export HERMES_HOME=~/.h/d/profiles/../profiles/assistant\n");
      expect((await homeFromLauncherFile(launcher)).literal).toBe(join(root, ".h", "d", "profiles", "assistant"));
    } finally {
      process.env["HOME"] = savedHome;
    }
  });

  it("INCERTITUDE = ERREUR : variable non résolue (sonde Codex n°2), deux HERMES_HOME (sonde n°3), pas de HERMES_HOME, sous-shell, absent, trop gros", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-launcher-"));
    await writeFile(join(root, "unknown"), '#!/bin/sh\nexport HERMES_HOME="$UNKNOWN_REVIEW_ROOT/ailleurs"\nexec hermes "$@"\n');
    const unknown = await homeFromLauncherFile(join(root, "unknown"));
    expect(unknown.home).toBeNull();
    expect(unknown.error).toMatch(/non résolu.*ligne 2/);
    await writeFile(join(root, "twice"), `#!/bin/sh\nexport HERMES_HOME="${join(root, "a")}"\nexport HERMES_HOME="${join(root, "b")}"\nexec hermes "$@"\n`);
    const twice = await homeFromLauncherFile(join(root, "twice"));
    expect(twice.home).toBeNull();
    expect(twice.error).toMatch(/plusieurs HERMES_HOME \(lignes 2, 3\)/);
    await writeFile(join(root, "none"), "#!/bin/bash\nexec hermes \"$@\"\n");
    expect((await homeFromLauncherFile(join(root, "none"))).error).toMatch(/aucune affectation HERMES_HOME/);
    await writeFile(join(root, "subshell"), 'HERMES_HOME="$(hermes config path)"\n');
    expect((await homeFromLauncherFile(join(root, "subshell"))).error).toMatch(/non résolu/);
    await writeFile(join(root, "cond"), 'HERMES_HOME="${HERMES_HOME:-/x}"\n');
    expect((await homeFromLauncherFile(join(root, "cond"))).error).toMatch(/non résolu/);
    expect((await homeFromLauncherFile(join(root, "absent"))).error).toMatch(/illisible/);
    await writeFile(join(root, "big"), "#".repeat(70 * 1024) + "\nHERMES_HOME=/x\n");
    expect((await homeFromLauncherFile(join(root, "big"))).error).toMatch(/trop gros/);
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
