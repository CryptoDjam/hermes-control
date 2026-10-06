import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desiredFromAdapterConfig, syncProfile } from "./sync.js";

describe("desiredFromAdapterConfig", () => {
  it("lit provider, modèle et thinking (extraArgs --reasoning-effort)", () => {
    expect(desiredFromAdapterConfig({ provider: "openai-codex", model: "gpt-5.6-luna", extraArgs: ["--reasoning-effort", "high"] })).toEqual({ provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" });
    expect(desiredFromAdapterConfig({})).toEqual({ provider: null, model: null, thinking: null });
  });
});

describe("syncProfile", () => {
  it("ne lance rien quand tout est déjà identique", async () => {
    const home = await mkdtemp(join(tmpdir(), "hc-sync-"));
    await writeFile(join(home, "config.yaml"), "model:\n  provider: openai-codex\n  default: gpt-5.6-luna\n");
    const r = await syncProfile(home, { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "auto" }, "/bin/false");
    expect(r.changed).toEqual([]);
    expect(r.skipped).toEqual(["model.provider", "model.default", "reasoning_effort"]);
    expect(r.error).toBeNull();
  });
  it("refuse une valeur dangereuse sans appeler hermes", async () => {
    const home = await mkdtemp(join(tmpdir(), "hc-sync-"));
    await writeFile(join(home, "config.yaml"), "model:\n  default: a\n");
    const r = await syncProfile(home, { provider: null, model: "x; rm -rf /", thinking: null }, "/bin/false");
    expect(r.changed).toEqual([]);
    expect(r.error).toContain("model.default");
  });
  it("signale un échec de hermes sans planter", async () => {
    const home = await mkdtemp(join(tmpdir(), "hc-sync-"));
    await writeFile(join(home, "config.yaml"), "model:\n  default: a\n");
    const r = await syncProfile(home, { provider: null, model: "b", thinking: null }, "/bin/false");
    expect(r.changed).toEqual([]);
    expect(r.error).toContain("model.default");
  });
});

describe("syncProfile : config.yaml corrompu", () => {
  it("refuse d'écrire (aucun hermes config set) et le signale ; le fichier n'est pas touché", async () => {
    const { chmod } = await import("node:fs/promises");
    const home = await mkdtemp(join(tmpdir(), "hc-sync-"));
    await writeFile(join(home, "config.yaml"), "model: [oops\n");
    const marker = join(home, "hermes-called");
    const bin = join(home, "hermes");
    await writeFile(bin, `#!/bin/bash\ntouch "${marker}"\n`);
    await chmod(bin, 0o755);
    const r = await syncProfile(home, { provider: "openai-codex", model: "b", thinking: null }, bin);
    expect(r.changed).toEqual([]);
    expect(r.error).toMatch(/config.yaml invalide.*aucune écriture/);
    const { access } = await import("node:fs/promises");
    await expect(access(marker)).rejects.toThrow();
    expect(await readFile(join(home, "config.yaml"), "utf8")).toBe("model: [oops\n");
  });
});
