import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareAgent } from "./prepare.js";
import { layout } from "./workspace.js";

let root: string;
let fakeHermes: string;
let savedHome: string | undefined;

/** Faux binaire hermes : `profile create <nom>` crée profiles/<nom>/{config.yaml,SOUL.md,skills/} dans $HERMES_HOME. */
async function makeFakeHermes(dir: string): Promise<string> {
  const bin = join(dir, "hermes");
  await writeFile(bin, `#!/bin/bash
set -e
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  p="$HERMES_HOME/profiles/$3"; mkdir -p "$p/skills" "$p/memories"
  cp "$HERMES_HOME/config.yaml" "$p/config.yaml"; echo "# soul instance" > "$p/SOUL.md"; echo "x" > "$p/memories/MEMORY.md"
  echo "created $3"; exit 0
fi
echo "fake hermes: $*" >&2; exit 1
`);
  await chmod(bin, 0o755);
  return bin;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hc-prepare-"));
  savedHome = process.env["HOME"];
  process.env["HOME"] = root;
  fakeHermes = await makeFakeHermes(root);
  const ws = layout(join(root, "ws"));
  await mkdir(join(ws.profils, "acme"), { recursive: true });
  await writeFile(join(ws.profils, "acme", "config.yaml"), "model:\n  provider: openai-codex\n  default: gpt-5.6-luna\n");
  await mkdir(join(ws.skills, "rapport"), { recursive: true });
  await writeFile(join(ws.skills, "rapport", "SKILL.md"), "---\nname: rapport\n---\n");
  await mkdir(ws.modeles, { recursive: true });
  await writeFile(join(ws.modeles, "SOUL.md"), "# SOUL {{nom}} / {{slug}} / {{entreprise}}\n{{skills}}\n");
});
afterEach(() => {
  if (savedHome) process.env["HOME"] = savedHome;
});

describe("prepareAgent", () => {
  it("crée le profil, les dossiers, les gabarits et les liens", async () => {
    const ws = layout(join(root, "ws"));
    const r = await prepareAgent({ ws, instanceHome: join(ws.profils, "acme"), agentName: "Apolline M", title: "Influenceuse", binary: fakeHermes, entreprise: "ACME" });
    expect(r.profile).toBe("apolline-m");
    expect(r.profileHome).toBe(join(ws.profils, "acme", "profiles", "apolline-m"));
    expect(r.agentDir).toBe(join(ws.agents, "apolline-m"));
    const soul = await readFile(join(r.profileHome, "SOUL.md"), "utf8");
    expect(soul).toContain("# SOUL Apolline M / apolline-m / ACME");
    expect(soul).toContain("- `rapport`");
    // mémoire : le memories/ créé par hermes devient un lien vers agents/apolline-m/memoire, contenu déplacé
    expect((await lstat(join(r.profileHome, "memories"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(r.profileHome, "memories"))).toBe("../../../../../agents/apolline-m/memoire");
    expect(await readFile(join(r.agentDir, "memoire", "MEMORY.md"), "utf8")).toBe("x\n"); // le fichier existant est gardé
    expect(await readFile(join(r.agentDir, "memoire", "USER.md"), "utf8")).toContain("interlocuteur");
    expect((await lstat(join(r.agentDir, "journal"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(r.profileHome, "skills", "rapport"))).toBe("../../../../../skills/rapport");
    expect(await readFile(join(r.agentDir, "fiche.md"), "utf8")).toContain("nom: apolline-m");
    for (const d of ["medias/brouillons", "medias/valides", "medias/publies", "rapports"]) expect((await lstat(join(r.agentDir, d))).isDirectory()).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("est idempotent : un second passage ne crée rien et ne casse rien", async () => {
    const ws = layout(join(root, "ws"));
    const inst = join(ws.profils, "acme");
    const a = await prepareAgent({ ws, instanceHome: inst, agentName: "Chef", binary: fakeHermes });
    await writeFile(join(a.agentDir, "memoire", "MEMORY.md"), "ma mémoire\n");
    const b = await prepareAgent({ ws, instanceHome: inst, agentName: "Chef", binary: fakeHermes });
    expect(b.created).toEqual([]);
    expect(await readFile(join(a.agentDir, "memoire", "MEMORY.md"), "utf8")).toBe("ma mémoire\n");
  });

  it("remplace un lien de skill mort copié par le clone, garde un lien vivant vers ailleurs", async () => {
    const ws = layout(join(root, "ws"));
    const inst = join(ws.profils, "acme");
    // le clone copie les liens relatifs de l'instance tels quels : depuis profiles/<agent>/skills ils sont morts
    await mkdir(join(inst, "profiles", "chef", "skills"), { recursive: true });
    await writeFile(join(inst, "profiles", "chef", "config.yaml"), "model: {}\n");
    await symlink("../../../skills/rapport", join(inst, "profiles", "chef", "skills", "rapport"));
    await mkdir(join(root, "autre"), { recursive: true });
    await writeFile(join(root, "autre", "SKILL.md"), "x");
    await mkdir(join(ws.skills, "wiki"), { recursive: true });
    await writeFile(join(ws.skills, "wiki", "SKILL.md"), "---\nname: wiki\n---\n");
    await symlink(join(root, "autre"), join(inst, "profiles", "chef", "skills", "wiki"));
    const r = await prepareAgent({ ws, instanceHome: inst, agentName: "Chef", binary: fakeHermes });
    expect(await readlink(join(r.profileHome, "skills", "rapport"))).toBe("../../../../../skills/rapport");
    expect(await readlink(join(r.profileHome, "skills", "wiki"))).toBe(join(root, "autre"));
    expect(r.warnings.join(" ")).toMatch(/wiki.*ailleurs/);
  });

  it("accepte un lien de skill qui résout vers la même cible par un autre chemin (via le lien de l'instance), sans avertir", async () => {
    const ws = layout(join(root, "ws"));
    const inst = join(ws.profils, "acme");
    await mkdir(join(inst, "skills"), { recursive: true });
    await symlink("../../../skills/rapport", join(inst, "skills", "rapport")); // lien de l'instance
    await mkdir(join(inst, "profiles", "cmo", "skills"), { recursive: true });
    await writeFile(join(inst, "profiles", "cmo", "config.yaml"), "model: {}\n");
    await symlink("../../../skills/rapport", join(inst, "profiles", "cmo", "skills", "rapport")); // copié par le clone : résout vers le lien de l'instance
    const r = await prepareAgent({ ws, instanceHome: inst, agentName: "CMO", binary: fakeHermes });
    expect(r.warnings).toEqual([]);
    expect(await readlink(join(r.profileHome, "skills", "rapport"))).toBe("../../../skills/rapport");
  });

  it("refuse un nom inutilisable", async () => {
    const ws = layout(join(root, "ws"));
    await expect(prepareAgent({ ws, instanceHome: join(ws.profils, "acme"), agentName: "???", binary: fakeHermes })).rejects.toThrow(/inutilisable/);
  });
});
