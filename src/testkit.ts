// Outils de test (jamais embarqués : aucun point d'entrée esbuild ne les importe). La référence est calculée depuis le
// dossier du compte, que vitest.setup.ts redirige vers $HOME (temporaire) : on écrit donc roots / workspace sous
// $HOME/.config/hermes-control, comme l'administrateur le ferait, sans aucune variable d'environnement.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { controlDir } from "./paths.js";

export async function writeRoots(...roots: string[]): Promise<void> {
  await mkdir(controlDir(), { recursive: true });
  await writeFile(join(controlDir(), "roots"), roots.join("\n") + "\n");
}

export async function writeWorkspaceFile(ws: string): Promise<void> {
  await mkdir(controlDir(), { recursive: true });
  await writeFile(join(controlDir(), "workspace"), ws + "\n");
}

/** Interpréteur Python du système (shebang absolu), pour un faux point d'entrée Hermes accepté par verifyHermesBinary. */
export const PYTHON = "/usr/bin/python3";

/**
 * Faux point d'entrée Hermes en Python (comme le vrai `.venv/bin/hermes`) : journalise argv, HERMES_HOME, PATH et quelques
 * variables dans <dossier>/calls.jsonl ; `profile create` clone l'instance (config.yaml, .env) ; `config set` laisse une trace
 * dans $HOME/hermes-config-set ; `chat` répond « ok » et un session_id.
 */
export async function makeFakeHermes(dir: string, name = "hermes"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(
    path,
    `#!${PYTHON}
import os, sys, json, shutil
home = os.environ.get("HERMES_HOME", "")
here = os.path.dirname(os.path.abspath(__file__))
keep = ("HERMES", "PYTHON", "LD_", "PAPERCLIP_AGENT", "CUSTOM_", "VIRTUAL_ENV", "BASH_ENV")
with open(os.path.join(here, "calls.jsonl"), "a") as f:
    f.write(json.dumps({"exe": os.path.abspath(__file__), "argv": sys.argv[1:], "HERMES_HOME": home, "PATH": os.environ.get("PATH", ""), "env": {k: v for k, v in os.environ.items() if k.startswith(keep)}}) + "\\n")
a = sys.argv[1:]
if a[:2] == ["profile", "create"]:
    p = os.path.join(home, "profiles", a[2])
    os.makedirs(os.path.join(p, "skills"), exist_ok=True)
    shutil.copy(os.path.join(home, "config.yaml"), os.path.join(p, "config.yaml"))
    if os.path.exists(os.path.join(home, ".env")):
        shutil.copy(os.path.join(home, ".env"), os.path.join(p, ".env"))
    desc = a[a.index("--description") + 1] if "--description" in a else ""
    with open(os.path.join(p, "profile.yaml"), "w") as f:
        f.write("description: %s\\n" % desc)
elif a[:2] == ["config", "set"]:
    with open(os.path.join(os.environ.get("HOME", "/nonexistent"), "hermes-config-set"), "a") as f:
        f.write("%s %s=%s\\n" % (home, a[2], a[3]))
elif a[:1] == ["chat"]:
    print("ok")
    print("session_id: fake-session-0001")
sys.exit(0)
`,
  );
  await chmod(path, 0o755);
  return path;
}

/** Lit le journal des appels du faux Hermes. */
export async function fakeCalls(dir: string): Promise<{ exe: string; argv: string[]; HERMES_HOME: string; PATH: string; env: Record<string, string> }[]> {
  const { readFile } = await import("node:fs/promises");
  try {
    return (await readFile(join(dir, "calls.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Table minimale qui administre le binaire (global). */
export async function administerBinary(binary: string): Promise<void> {
  const { setHermesBinary } = await import("./assignments.js");
  await setHermesBinary({ binary });
}
