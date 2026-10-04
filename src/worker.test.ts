import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
exit 0
`);
    await chmod(join(bin, "hermes"), 0o755);
    process.env["PATH"] = `${bin}:${savedPath ?? ""}`;
    const ws = join(root, "ws");
    await mkdir(join(ws, "hermes", "profils", "acme"), { recursive: true });
    await writeFile(join(ws, "hermes", "profils", "acme", "config.yaml"), "model:\n  provider: openai-codex\n  default: gpt-5.6-luna\n");
    await mkdir(join(root, ".config", "hermes-control"), { recursive: true });
    await writeFile(join(root, ".config", "hermes-control", "workspace"), ws + "\n");
    await writeFile(join(root, ".config", "hermes-control", "roots"), join(ws, "hermes", "profils") + "\n");
  });
  afterEach(() => { if (savedHome) process.env["HOME"] = savedHome; if (savedPath) process.env["PATH"] = savedPath; });

  it("un agent Hermes sans profil est préparé dans l'instance de l'entreprise, puis relié", async () => {
    const h = await start();
    h.seed({ companies: [{ id: "co", name: "ACME" } as never], agents: [{ id: "a1", companyId: "co", name: "Test Un", title: "Testeur", adapterType: "hermes_local", adapterConfig: { model: "gpt-5.6-luna", provider: "openai-codex" }, status: "idle" } as never] });
    const r = await h.getData<{ sync: { agentName: string; instance: string | null; profile: string | null; prepared: string[] | null; error: string | null }[]; workspace: { root: string } | null }>("instances", { companyId: "co" });
    expect(r.workspace?.root).toBe(join(root, "ws"));
    const s = r.sync[0]!;
    expect(s.instance).toBe("acme");
    expect(s.profile).toBe("test-un");
    expect(s.prepared?.length).toBeGreaterThan(3);
    expect(s.error).toBeNull();
  });

  it("set-telegram refuse un chemin qui n'est pas un profil connu", async () => {
    const h = await start();
    h.seed({ companies: [{ id: "co", name: "ACME" } as never], agents: [] });
    await h.getData("instances", { companyId: "co" });
    await expect(h.performAction("set-telegram", { home: join(root, "ailleurs"), token: "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789abc" }, { actor: { type: "user", userId: "u1" } })).rejects.toThrow(/inconnu/);
  });
});
