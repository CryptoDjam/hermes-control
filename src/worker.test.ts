import { describe, expect, it } from "vitest";
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
