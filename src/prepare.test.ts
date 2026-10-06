import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_ENV, prepareAgent, withPrepareLock, writeEmptyEnv } from "./prepare.js";
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
  [ -f "$HERMES_HOME/.env" ] && cp "$HERMES_HOME/.env" "$p/.env"  # comme le vrai --clone : les clés de l'instance suivent
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
  await writeFile(join(ws.profils, "acme", ".env"), "OPENAI_API_KEY=marqueur\nTELEGRAM_BOT_TOKEN=marqueur\n");
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

  it("R02a : le profil préparé a un .env vide (en-tête seul, mode 600), aucune clé héritée de l'instance", async () => {
    const ws = layout(join(root, "ws"));
    const r = await prepareAgent({ ws, instanceHome: join(ws.profils, "acme"), agentName: "Apolline M", binary: fakeHermes });
    const env = await readFile(join(r.profileHome, ".env"), "utf8");
    expect(env).toBe(EMPTY_ENV);
    expect(env).not.toContain("marqueur");
    expect(env).not.toMatch(/OPENAI_API_KEY|TELEGRAM_BOT_TOKEN/);
    expect((await stat(join(r.profileHome, ".env"))).mode & 0o777).toBe(0o600);
    expect(r.created.some((c) => c.endsWith(".env (vide)"))).toBe(true);
    // l'instance garde ses clés : on ne touche qu'au profil
    expect(await readFile(join(ws.profils, "acme", ".env"), "utf8")).toContain("marqueur");
  });

  it("R02a idempotent : marqueurs ; un profil créé par nous mais au .env non vidé est vidé au passage suivant ; un profil fait à la main est laissé", async () => {
    const ws = layout(join(root, "ws"));
    const inst = join(ws.profils, "acme");
    const r = await prepareAgent({ ws, instanceHome: inst, agentName: "Apolline M", binary: fakeHermes });
    expect(await stat(join(r.profileHome, ".hermes-control", "prepared-by-hermes-control"))).toBeTruthy();
    expect(await stat(join(r.profileHome, ".hermes-control", "env-cleaned"))).toBeTruthy();
    // passage interrompu simulé : marqueur de vidage absent, .env avec une clé
    await rm(join(r.profileHome, ".hermes-control", "env-cleaned"));
    await writeFile(join(r.profileHome, ".env"), "OPENAI_API_KEY=marqueur\n");
    const again = await prepareAgent({ ws, instanceHome: inst, agentName: "Apolline M", binary: fakeHermes });
    expect(await readFile(join(r.profileHome, ".env"), "utf8")).toBe(EMPTY_ENV);
    expect(again.created).toEqual([`${join(r.profileHome, ".env")} (vide)`]);
    // profil existant fait à la main (pas de marqueur) : son .env n'est pas touché
    await mkdir(join(inst, "profiles", "manuel"), { recursive: true });
    await writeFile(join(inst, "profiles", "manuel", "config.yaml"), "model: {}\n");
    await writeFile(join(inst, "profiles", "manuel", ".env"), "MA_CLE=gardee\n");
    await prepareAgent({ ws, instanceHome: inst, agentName: "Manuel", binary: fakeHermes });
    expect(await readFile(join(inst, "profiles", "manuel", ".env"), "utf8")).toBe("MA_CLE=gardee\n");
  });

  it("writeEmptyEnv ne suit jamais un lien : le lien est remplacé par un fichier, la cible intacte", async () => {
    const home = join(root, "lien-env");
    await mkdir(home);
    await writeFile(join(root, "cible.env"), "SECRET=x\n");
    await symlink(join(root, "cible.env"), join(home, ".env"));
    await writeEmptyEnv(home);
    expect((await lstat(join(home, ".env"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(home, ".env"), "utf8")).toBe(EMPTY_ENV);
    expect(await readFile(join(root, "cible.env"), "utf8")).toBe("SECRET=x\n");
  });

  it("verrou : deux préparations concurrentes du même agent → une seule passe, l'autre reçoit « déjà en cours », aucun doublon", async () => {
    const ws = layout(join(root, "ws"));
    const inst = join(ws.profils, "acme");
    const run = () => prepareAgent({ ws, instanceHome: inst, agentName: "Chef", binary: fakeHermes });
    const results = await Promise.allSettled([run(), run()]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const ko = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(ko).toHaveLength(1);
    expect(ko[0]!.reason.message).toMatch(/déjà en cours/);
    expect((ok[0] as PromiseFulfilledResult<{ created: string[] }>).value.created.filter((c) => c.startsWith("profil Hermes"))).toHaveLength(1);
    // le verrou est relâché : un troisième passage (idempotent) passe
    expect((await run()).created).toEqual([]);
    await expect(lstat(join(inst, ".hermes-control", "prepare-chef.lock"))).rejects.toThrow();
  });

  it("verrou périmé (plus de 10 min) : repris ; verrou récent : refus", async () => {
    const ws = layout(join(root, "ws"));
    const inst = join(ws.profils, "acme");
    const lock = join(inst, ".hermes-control", "prepare-chef.lock");
    await mkdir(lock, { recursive: true });
    await expect(withPrepareLock(inst, "chef", async () => "x")).rejects.toThrow(/déjà en cours/);
    const old = new Date(Date.now() - 11 * 60 * 1000);
    await utimes(lock, old, old);
    expect(await withPrepareLock(inst, "chef", async () => "x")).toBe("x");
  });

  it("refuse un nom inutilisable", async () => {
    const ws = layout(join(root, "ws"));
    await expect(prepareAgent({ ws, instanceHome: join(ws.profils, "acme"), agentName: "???", binary: fakeHermes })).rejects.toThrow(/inutilisable/);
  });
});
