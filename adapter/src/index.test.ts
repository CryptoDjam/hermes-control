import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstat, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { rememberAgent } from "../../src/agents-map.js";
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

  it("detectModel ne devine plus à partir du premier profil venu : celui de l'adaptateur de base (null sans ~/.hermes)", async () => {
    const a = createServerAdapter();
    expect(await a.detectModel!()).toBeNull();
  });

  function withSpy() {
    const calls: Record<string, unknown>[] = [];
    const real = createServerAdapter();
    const base = { ...real, execute: async (ctx: { config?: Record<string, unknown> }) => { calls.push(ctx.config ?? {}); return { status: "completed" } as never; } } as unknown as Parameters<typeof createServerAdapter>[0];
    return { a: createServerAdapter(base), calls };
  }
  const ctxFor = (id: string, name: string, logs: string[], config: Record<string, unknown> = {}) => ({ runId: "r", agent: { id, companyId: "c", name, adapterType: "hermes_local", adapterConfig: {} }, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null }, config, onLog: async (_s: string, t: string) => { logs.push(t); } }) as never;

  it("R02b : un agent sans affectation dans agents.json refuse de tourner (base.execute jamais appelé), même si un profil porte son nom", async () => {
    const { a, calls } = withSpy();
    const logs: string[] = [];
    await expect(a.execute(ctxFor("x", "Apolline M", logs))).rejects.toThrow(/non affecté.*prépare l'agent dans Paperclip/);
    expect(calls).toEqual([]);
    expect(logs.join("")).toContain("agents.json");
  });

  it("affecté mais le profil n'a plus de config.yaml → refus ; affecté et présent → HERMES_HOME du profil affecté", async () => {
    const { a, calls } = withSpy();
    await rememberAgent("gone", { name: "Parti", instance: "marketing", profile: "parti", home: join(root, "marketing", "profiles", "parti") });
    await expect(a.execute(ctxFor("gone", "Parti", []))).rejects.toThrow(/config.yaml n'existe plus/);
    expect(calls).toEqual([]);
    const home = join(root, "marketing", "profiles", "apolline-m");
    await rememberAgent("ok", { name: "Apolline M", instance: "marketing", profile: "apolline-m", home });
    const logs: string[] = [];
    await a.execute(ctxFor("ok", "Apolline M", logs));
    expect(calls).toHaveLength(1);
    expect((calls[0]!["env"] as Record<string, string>)["HERMES_HOME"]).toBe(home);
    expect(logs.join("")).toContain("affectation agents.json");
  });

  it("lanceur (hermesCommand) dont le HERMES_HOME diffère de l'affectation → refus ; identique → passe", async () => {
    const { a, calls } = withSpy();
    const home = join(root, "marketing", "profiles", "apolline-m");
    await rememberAgent("ok", { name: "Apolline M", instance: "marketing", profile: "apolline-m", home });
    const bad = join(root, "hermes-bad");
    await writeFile(bad, `#!/bin/bash\nexport HERMES_HOME="${join(root, "marketing")}"\nexec hermes "$@"\n`);
    await expect(a.execute(ctxFor("ok", "Apolline M", [], { hermesCommand: bad }))).rejects.toThrow(/affectation \(agents.json\) ≠ lanceur/);
    expect(calls).toEqual([]);
    const good = join(root, "hermes-good");
    await writeFile(good, `#!/bin/bash\nexport HERMES_HOME="${home}"\nexec hermes "$@"\n`);
    await a.execute(ctxFor("ok", "Apolline M", [], { hermesCommand: good }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!["hermesCommand"]).toBe(good);
  });

  it("profil affecté au config.yaml invalide → refus", async () => {
    const { a, calls } = withSpy();
    const home = join(root, "marketing", "profiles", "casse");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.yaml"), "model: [oops\n");
    await rememberAgent("k", { name: "Casse", instance: "marketing", profile: "casse", home });
    await expect(a.execute(ctxFor("k", "Casse", []))).rejects.toThrow(/config.yaml invalide/);
    expect(calls).toEqual([]);
  });

  it("HERMES_CONTROL_HERMES_BIN est pris avant ~/.local/bin/hermes pour hermesCommand", async () => {
    const { a, calls } = withSpy();
    const home = join(root, "marketing", "profiles", "apolline-m");
    await rememberAgent("ok", { name: "Apolline M", instance: "marketing", profile: "apolline-m", home });
    process.env["HERMES_CONTROL_HERMES_BIN"] = join(root, "mon-hermes");
    try {
      await a.execute(ctxFor("ok", "Apolline M", []));
    } finally {
      delete process.env["HERMES_CONTROL_HERMES_BIN"];
    }
    expect(calls[0]!["hermesCommand"]).toBe(join(root, "mon-hermes"));
  });

  it("listSkills / syncSkills : profil inconnu → avertissement ; profil connu → lien dans <profil>/skills", async () => {
    const a = createServerAdapter();
    const src = join(root, "paperclip-src", "first-task");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "SKILL.md"), "---\nname: first-task\ndescription: d\n---\n");
    const config = {
      paperclipRuntimeSkills: [{ key: "paperclipai/paperclip/first-task", runtimeName: "first-task", source: src }],
      paperclipSkillSync: { desiredSkills: [{ key: "paperclipai/paperclip/first-task", versionId: null }] },
    };
    const ctx = { agentId: "ag-1", companyId: "c", adapterType: "hermes_local", config };
    const unknown = await a.listSkills!(ctx);
    expect(unknown.warnings.join(" ")).toMatch(/profil Hermes inconnu/);

    const home = join(root, "marketing", "profiles", "apolline-m");
    await rememberAgent("ag-1", { name: "Apolline M", instance: "marketing", profile: "apolline-m", home });
    const synced = await a.syncSkills!(ctx, ["paperclipai/paperclip/first-task"]);
    const ft = synced.entries.find((e) => e.runtimeName === "first-task")!;
    expect(ft.state).toBe("configured");
    expect(ft.targetPath).toBe(join(home, "skills", "first-task"));
    expect((await lstat(join(home, "skills", "first-task"))).isSymbolicLink()).toBe(true);
  });
});
