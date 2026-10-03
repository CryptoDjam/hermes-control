import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerAdapter } from "./index.js";

let root: string;
let savedHome: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hc-adapter-"));
  // Isoler le test de la machine : pas de ~/.hermes ni de ~/.config/hermes-control/roots réels.
  savedHome = process.env["HOME"];
  process.env["HOME"] = root;
  const inst = join(root, "marketing");
  await mkdir(join(inst, "profiles", "apolline-m"), { recursive: true });
  await writeFile(join(inst, "config.yaml"), "model:\n  provider: openai-codex\n  default: gpt-5.6-luna\n");
  await writeFile(join(inst, "profile.yaml"), "description: CMO — directeur marketing\n");
  await writeFile(join(inst, "profiles", "apolline-m", "config.yaml"), "model:\n  provider: openai-codex\n  default: gpt-5.6-luna\n");
  await writeFile(join(inst, "profiles", "apolline-m", "profile.yaml"), "description: Apolline M, influenceuse IA\n");
  await writeFile(join(inst, "provider_models_cache.json"), JSON.stringify({ "openai-codex": { models: ["gpt-5.6-luna", "gpt-6-sol"] }, anthropic: { models: ["claude-x"] } }));
  process.env["HERMES_CONTROL_ROOTS"] = root;
});
afterEach(() => {
  delete process.env["HERMES_CONTROL_ROOTS"];
  if (savedHome) process.env["HOME"] = savedHome;
});

describe("adaptateur Hermes Control", () => {
  it("garde le type hermes_local et les fonctions de base", () => {
    const a = createServerAdapter();
    expect(a.type).toBe("hermes_local");
    expect(typeof a.execute).toBe("function");
    expect(typeof a.sessionCodec).toBe("object");
  });

  it("liste les modèles de Hermes pour les providers configurés", async () => {
    const a = createServerAdapter();
    const models = await a.refreshModels!();
    expect(models.map((m) => m.id)).toEqual(["gpt-5.6-luna", "gpt-6-sol"]);
  });

  it("propose les providers de Hermes dans le menu Provider", async () => {
    const a = createServerAdapter();
    const schema = await a.getConfigSchema!();
    const provider = schema.fields.find((f) => f.key === "provider")!;
    expect(provider.options?.map((o) => o.value)).toEqual(["auto", "openai-codex"]);
    expect(provider.default).toBe("openai-codex");
  });

  it("détecte le modèle par défaut de Hermes", async () => {
    const a = createServerAdapter();
    const d = await a.detectModel!();
    expect(d?.model).toBe("gpt-5.6-luna");
    expect(d?.provider).toBe("openai-codex");
  });

  it("refuse un agent sans profil correspondant, avec un message utile", async () => {
    const a = createServerAdapter();
    const logs: string[] = [];
    const ctx = { runId: "r", agent: { id: "x", companyId: "c", name: "Inconnu", adapterType: "hermes_local", adapterConfig: {} }, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null }, config: {}, onLog: async (_s: string, t: string) => { logs.push(t); } };
    await expect(a.execute(ctx as never)).rejects.toThrow(/Inconnu/);
    expect(logs.join("")).toContain("marketing/apolline-m");
  });
});
