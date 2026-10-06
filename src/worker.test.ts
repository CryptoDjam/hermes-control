import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestHarness } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import plugin from "./worker.js";

async function start() {
  const h = createTestHarness({ manifest: manifest as unknown as PaperclipPluginManifestV1, config: {} });
  await plugin.definition.setup(h.ctx);
  return h;
}

describe("worker Hermes Control", () => {
  // HOME isolé : ni le dossier de travail ni les roots réels de la machine ne doivent entrer dans ces tests
  let savedHome: string | undefined;
  beforeEach(async () => { savedHome = process.env["HOME"]; process.env["HOME"] = await mkdtemp(join(tmpdir(), "hc-worker-")); });
  afterEach(() => { if (savedHome) process.env["HOME"] = savedHome; });

  it("le job sync ne fait rien sans instantané d'agents", async () => {
    const h = await start();
    await expect(h.runJob("sync")).resolves.toBeUndefined();
  });

  it("instances : liste vide et aucune synchro sans agent Hermes", async () => {
    const h = await start();
    h.seed({ companies: [{ id: "co", name: "Test" } as never], agents: [] });
    const r = await h.getData<{ instances: unknown[]; sync: unknown[] }>("instances", { companyId: "co" });
    expect(r.sync).toEqual([]);
    expect(Array.isArray(r.instances)).toBe(true);
  });

  it("signale un agent Hermes sans profil correspondant", async () => {
    const h = await start();
    h.seed({ companies: [{ id: "co", name: "Test" } as never], agents: [{ id: "a1", companyId: "co", name: "Inconnu", adapterType: "hermes_local", adapterConfig: { model: "m", provider: "openai-codex" }, status: "idle" } as never] });
    const r = await h.getData<{ sync: { agentName: string; error: string | null }[] }>("instances", { companyId: "co" });
    expect(r.sync[0]?.agentName).toBe("Inconnu");
    expect(r.sync[0]?.error).toContain("aucun profil");
  });
});

describe("préparation automatique d'un agent (dossier de travail)", () => {
  let root: string;
  let savedHome: string | undefined;
  let savedPath: string | undefined;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hc-worker-ws-"));
    savedHome = process.env["HOME"]; savedPath = process.env["PATH"];
    process.env["HOME"] = root;
    // faux hermes en tête de PATH : « profile create » clone l'instance ; tout le reste répond vide
    const bin = join(root, "bin"); await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "hermes"), `#!/bin/bash
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then p="$HERMES_HOME/profiles/$3"; mkdir -p "$p/skills"; cp "$HERMES_HOME/config.yaml" "$p/config.yaml"; printf 'description: %s\n' "$6" > "$p/profile.yaml"; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "get" ]; then echo ""; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "set" ]; then touch "$HERMES_CONTROL_TEST_ROOT/hermes-config-set"; exit 0; fi
exit 0
`);
    await chmod(join(bin, "hermes"), 0o755);
    process.env["PATH"] = `${bin}:${savedPath ?? ""}`;
    process.env["HERMES_CONTROL_TEST_ROOT"] = root;
    const ws = join(root, "ws");
    await mkdir(join(ws, "hermes", "profils", "acme"), { recursive: true });
    await writeFile(join(ws, "hermes", "profils", "acme", "config.yaml"), "model:\n  provider: openai-codex\n  default: gpt-5.6-luna\n");
    await mkdir(join(root, ".config", "hermes-control"), { recursive: true });
    await writeFile(join(root, ".config", "hermes-control", "workspace"), ws + "\n");
    await writeFile(join(root, ".config", "hermes-control", "roots"), join(ws, "hermes", "profils") + "\n");
  });
  afterEach(() => { if (savedHome) process.env["HOME"] = savedHome; if (savedPath) process.env["PATH"] = savedPath; });

  type Rec = { agentId: string; agentName: string; instance: string | null; profile: string | null; home: string | null; prepared: string[] | null; error: string | null };
  type Data = { sync: Rec[]; workspace: { root: string } | null; states: Record<string, string>; health: Record<string, { alerts: string[] }> };
  const agent = (name: string, id = "a1") => ({ id, companyId: "co", name, title: "Testeur", adapterType: "hermes_local", adapterConfig: { model: "gpt-5.6-luna", provider: "openai-codex" }, status: "idle" }) as never;

  it("ouvrir la vue ne prépare JAMAIS ; agent.created prépare dans l'instance de l'entreprise, puis la vue le montre relié", async () => {
    const h = await start();
    h.seed({ companies: [{ id: "co", name: "ACME" } as never], agents: [agent("Test Un")] });
    const before = await h.getData<Data>("instances", { companyId: "co" });
    expect(before.workspace?.root).toBe(join(root, "ws"));
    expect(before.sync[0]!.instance).toBeNull();
    expect(before.sync[0]!.prepared).toBeNull();
    expect(before.sync[0]!.error).toContain("aucun profil");
    await expect(stat(join(root, "ws", "hermes", "profils", "acme", "profiles", "test-un"))).rejects.toThrow();

    await h.emit("agent.created", { agentId: "a1" }, { companyId: "co" });
    const after = await h.getData<Data>("instances", { companyId: "co" });
    const s = after.sync[0]!;
    expect(s.instance).toBe("acme");
    expect(s.profile).toBe("test-un");
    expect(s.error).toBeNull();
    expect(after.states["a1"]).toBe("installed"); // profil présent, connexion inconnue (lecture légère)
    expect(after.health[s.home!]?.alerts).toEqual([]);
    expect(await readFile(join(s.home!, ".env"), "utf8")).not.toMatch(/=/); // .env vide (R02a)
    const map = JSON.parse(await readFile(join(root, ".config", "hermes-control", "agents.json"), "utf8")) as Record<string, { home: string }>;
    expect(map["a1"]?.home).toBe(s.home); // affectation écrite pour l'adaptateur
  });

  it("entreprise sans instance de son nom : la préparation échoue en listant les instances présentes (aucun repli)", async () => {
    const h = await start();
    h.seed({ companies: [{ id: "co", name: "Autre Société" } as never], agents: [agent("Test Deux")] });
    await h.emit("agent.created", { agentId: "a1" }, { companyId: "co" });
    const r = await h.getData<Data>("instances", { companyId: "co" });
    expect(r.sync[0]!.instance).toBeNull();
    await expect(h.performAction("prepare-agent", { agentId: "a1", companyId: "co" }, { actor: { type: "user", userId: "u1" } })).rejects.toThrow(/« autre-societe ».*présentes : acme/);
    await expect(stat(join(root, "ws", "hermes", "profils", "acme", "profiles", "test-deux"))).rejects.toThrow();
  });

  it("profil au config.yaml corrompu : jamais synchronisé (aucun hermes config set), erreur « aucune écriture », fichier intact", async () => {
    const inst = join(root, "ws", "hermes", "profils", "acme");
    await mkdir(join(inst, "profiles", "casse"), { recursive: true });
    await writeFile(join(inst, "profiles", "casse", "config.yaml"), "model: [oops\n");
    const h = await start();
    h.seed({ companies: [{ id: "co", name: "ACME" } as never], agents: [agent("Casse")] });
    const r = await h.getData<Data>("instances", { companyId: "co" });
    expect(r.sync[0]!.profile).toBe("casse");
    expect(r.sync[0]!.error).toMatch(/config.yaml invalide.*aucune écriture/);
    await expect(stat(join(root, "hermes-config-set"))).rejects.toThrow();
    expect(await readFile(join(inst, "profiles", "casse", "config.yaml"), "utf8")).toBe("model: [oops\n");
    expect(r.health[join(inst, "profiles", "casse")]?.alerts.join(" ")).toMatch(/invalide/);
  });

  it("lanceur d'agent lu statiquement : un lanceur de profil ramène à son instance ; le cache suit le mtime du fichier", async () => {
    const { utimes } = await import("node:fs/promises");
    const other = join(root, "autre-racine", "beta");
    await mkdir(join(other, "profiles", "p1"), { recursive: true });
    await writeFile(join(other, "config.yaml"), "model: {}\n");
    await writeFile(join(other, "profiles", "p1", "config.yaml"), "model: {}\n");
    const gamma = join(root, "autre-racine", "gamma");
    await mkdir(gamma, { recursive: true });
    await writeFile(join(gamma, "config.yaml"), "model: {}\n");
    const launcher = join(root, "bin", "hermes-p1");
    await writeFile(launcher, `#!/bin/bash\nexport HERMES_HOME="${join(other, "profiles", "p1")}"\nexec hermes "$@"\n`, { mode: 0o644 });
    const h = await start();
    h.seed({ companies: [{ id: "co", name: "ACME" } as never], agents: [{ id: "a1", companyId: "co", name: "P1", adapterType: "hermes_local", adapterConfig: { hermesCommand: launcher }, status: "idle" } as never] });
    const r1 = await h.getData<{ instances: { name: string }[] }>("instances", { companyId: "co" });
    expect(r1.instances.map((i) => i.name).sort()).toEqual(["acme", "beta"]); // beta = instance du profil p1, pas p1
    await writeFile(launcher, `#!/bin/bash\nexport HERMES_HOME="${gamma}"\n`, { mode: 0o644 });
    const later = new Date(Date.now() + 5_000);
    await utimes(launcher, later, later);
    const r2 = await h.getData<{ instances: { name: string }[] }>("instances", { companyId: "co" });
    expect(r2.instances.map((i) => i.name).sort()).toEqual(["acme", "gamma"]);
  });

  it("set-telegram refuse quand une unité de passerelle existe pour un autre profil", async () => {
    const units = join(root, ".config", "systemd", "user");
    await mkdir(units, { recursive: true });
    await writeFile(join(units, "hermes-gateway-x.service"), `[Service]\nEnvironment="HERMES_HOME=${join(root, "ailleurs", "x")}"\n`);
    const h = await start();
    h.seed({ companies: [{ id: "co", name: "ACME" } as never], agents: [] });
    await h.getData("instances", { companyId: "co" });
    const acme = join(root, "ws", "hermes", "profils", "acme");
    await expect(h.performAction("set-telegram", { home: acme, token: "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789abc" }, { actor: { type: "user", userId: "u1" } })).rejects.toThrow(/tient déjà la passerelle.*hermes-gateway-x\.service/);
    await expect(stat(join(acme, ".env"))).rejects.toThrow();
  });

  it("set-telegram refuse un chemin qui n'est pas un profil connu", async () => {
    const h = await start();
    h.seed({ companies: [{ id: "co", name: "ACME" } as never], agents: [] });
    await h.getData("instances", { companyId: "co" });
    await expect(h.performAction("set-telegram", { home: join(root, "ailleurs"), token: "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789abc" }, { actor: { type: "user", userId: "u1" } })).rejects.toThrow(/inconnu/);
  });
});
