// 0.6.2 (adaptateur) — diagnostic sans exécution, skills limités au profil affecté sur les deux chemins, classe
// d'échec « authentification du modèle » non réessayée.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHermesLocalServerAdapter } from "@paperclipai/hermes-paperclip-adapter";
import { assignAgent, setCompanyInstances, setHermesBinary } from "../../src/assignments.js";
import { fakeCalls, makeFakeHermes, writeRoots } from "../../src/testkit.js";
import { classifyFailure } from "./failure.js";
import { REFUSAL_ERROR_CODE, createServerAdapter } from "./index.js";

let root: string;
let instA: string;
let instB: string;
let hb: string;
let fake: string;
let savedHome: string | undefined;
let savedPath: string | undefined;
const exists = (p: string) => lstat(p).then(() => true, () => false);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hc-b6-"));
  savedHome = process.env["HOME"];
  savedPath = process.env["PATH"];
  process.env["HOME"] = root;
  instA = join(root, "ia");
  instB = join(root, "ib");
  for (const i of [instA, instB]) {
    await mkdir(join(i, "profiles", "chef"), { recursive: true });
    await writeFile(join(i, "config.yaml"), "model:\n  provider: openai-codex\n  default: m\n");
    await writeFile(join(i, "profiles", "chef", "config.yaml"), "model:\n  provider: openai-codex\n  default: m\n");
  }
  await writeRoots(root);
  hb = join(root, "hb");
  fake = await makeFakeHermes(hb);
  await setHermesBinary({ binary: fake });
  await setCompanyInstances("A", "A", [instA]);
  await setCompanyInstances("B", "B", [instB]);
  await assignAgent({ agentId: "chef-a", companyId: "A", instanceHome: instA, profile: "chef", name: "Chef", assignedBy: "u" });
});
afterEach(() => {
  if (savedHome) process.env["HOME"] = savedHome;
  if (savedPath) process.env["PATH"] = savedPath;
});

/** Pièges : `hermes` et `python3` en tête du PATH, et un hermesCommand vers un lanceur ; chacun laisse une trace s'il est lancé. */
async function traps(): Promise<{ marker: string; launcher: string }> {
  const evil = join(root, "evil");
  await mkdir(evil, { recursive: true });
  const marker = join(root, "LANCE-A-TORT");
  for (const n of ["hermes", "python3", "lanceur"]) {
    await writeFile(join(evil, n), `#!/bin/sh\necho "$0 $*" >> "${marker}"\necho "Python 3.12.0"\n`);
    await chmod(join(evil, n), 0o755);
  }
  process.env["PATH"] = `${evil}:${savedPath ?? ""}`;
  return { marker, launcher: join(evil, "lanceur") };
}

describe("1. « Test environment » : même contrôle qu'un passage, rien n'est exécuté", () => {
  it("vrai adaptateur officiel en base : ni hermesCommand, ni `hermes` / `python3` du PATH, ni le binaire administré ne sont lancés ; la base n'est pas appelée", async () => {
    const { marker, launcher } = await traps();
    let baseCalled = 0;
    const real = createHermesLocalServerAdapter();
    const a = createServerAdapter({ ...real, testEnvironment: async (ctx) => { baseCalled++; return real.testEnvironment(ctx); } });
    const r = await a.testEnvironment({ companyId: "A", adapterType: "hermes_local", config: { hermesCommand: launcher, env: { HERMES_HOME: "/x", PATH: "/y", CUSTOM: "v" } } } as never);
    expect(baseCalled).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(await fakeCalls(hb)).toEqual([]);
    const codes = r.checks.map((c) => c.code);
    expect(codes).toContain("hermes_control.static");
    expect(r.checks.find((c) => c.code === "hermes_control.command_ignored")?.message).toContain(launcher);
    expect(r.checks.find((c) => c.code === "hermes_control.env_dropped")?.message).toMatch(/HERMES_HOME, PATH/);
    expect(r.checks.find((c) => c.code === "hermes_control.binary")).toMatchObject({ level: "info" });
    expect(r.checks.find((c) => c.code === "hermes_control.instances")?.detail).toBe(instA); // les instances de l'entreprise seulement
    expect(r.status).toBe("warn");
  });

  it("binaire administré refusé (shell) → échec du diagnostic, toujours sans rien lancer ; entreprise sans instance → avertissement ; -p dans extraArgs → erreur", async () => {
    const { marker } = await traps();
    const a = createServerAdapter();
    await setHermesBinary(null);
    const t = JSON.parse(readFileSync(join(root, ".config", "hermes-control", "assignments.json"), "utf8"));
    t.hermes = { binary: "/bin/sh" };
    await writeFile(join(root, ".config", "hermes-control", "assignments.json"), JSON.stringify(t));
    const r = await a.testEnvironment({ companyId: "A", adapterType: "hermes_local", config: { extraArgs: ["-p", "autre"] } } as never);
    expect(r.status).toBe("fail");
    expect(r.checks.find((c) => c.code === "hermes_control.binary")?.level).toBe("error");
    expect(r.checks.find((c) => c.code === "hermes_control.arguments")?.level).toBe("error");
    const z = await a.testEnvironment({ companyId: "Z", adapterType: "hermes_local", config: {} } as never);
    expect(z.checks.find((c) => c.code === "hermes_control.instances")?.level).toBe("warn");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("6. skills : profil résolu d'abord, écriture seulement dans ce profil, sur les deux chemins", () => {
  async function inventory() {
    const src = join(root, "pc-src", "first-task");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "SKILL.md"), "---\nname: first-task\ndescription: d\n---\n");
    return {
      paperclipRuntimeSkills: [{ key: "paperclipai/paperclip/first-task", runtimeName: "first-task", source: src }],
      paperclipSkillSync: { desiredSkills: [{ key: "paperclipai/paperclip/first-task", versionId: null }] },
    };
  }
  const globalSkills = () => join(root, ".hermes", "skills");
  const otherHome = () => join(root, "autre-home");
  const ctxRun = (id: string, companyId: string, config: Record<string, unknown>, logs: string[] = []) => ({ runId: "r", agent: { id, companyId, name: "Chef", adapterType: "hermes_local", adapterConfig: {} }, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null }, config, context: {}, onLog: async (_s: string, t: string) => { logs.push(t); } }) as never;

  it("execute avec paperclipRuntimeSkills (VRAIE base officielle, vrai processus) : lien dans le profil affecté seulement ; rien dans le global ni dans un HOME venu de config.env ni chez B", async () => {
    const inv = await inventory();
    const a = createServerAdapter(createHermesLocalServerAdapter());
    const r = (await a.execute(ctxRun("chef-a", "A", { ...inv, cwd: root, env: { HOME: otherHome() }, timeoutSec: 30 }))) as { exitCode: number };
    expect(r.exitCode).toBe(0);
    expect((await lstat(join(instA, "profiles", "chef", "skills", "first-task"))).isSymbolicLink()).toBe(true);
    expect(await exists(globalSkills())).toBe(false);
    expect(await exists(join(otherHome(), ".hermes"))).toBe(false);
    expect(await exists(join(instB, "profiles", "chef", "skills"))).toBe(false);
    expect((await fakeCalls(hb)).filter((c) => c.argv[0] === "chat")).toHaveLength(1);
  }, 30_000);

  it("la base reçoit la configuration SANS l'inventaire (elle ne peut plus réconcilier dans le global)", async () => {
    const inv = await inventory();
    const seen: Record<string, unknown>[] = [];
    const real = createServerAdapter();
    const a = createServerAdapter({ ...real, execute: async (ctx: { config?: Record<string, unknown> }) => { seen.push(ctx.config ?? {}); return { exitCode: 0, signal: null, timedOut: false } as never; } } as never);
    await a.execute(ctxRun("chef-a", "A", { ...inv }));
    expect(seen).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(seen[0], "paperclipRuntimeSkills")).toBe(false);
  });

  it("agent NON affecté (ou affecté pour une autre entreprise) : execute refusé, syncSkills / listSkills sans aucune écriture", async () => {
    const inv = await inventory();
    const a = createServerAdapter();
    const r = (await a.execute(ctxRun("chef-b", "B", { ...inv }))) as { errorCode: string; errorMessage: string };
    expect(r.errorCode).toBe(REFUSAL_ERROR_CODE);
    expect(r.errorMessage).toMatch(/NON AFFECTÉ.*pas un secret manquant/);
    const r2 = (await a.execute(ctxRun("chef-a", "B", { ...inv }))) as { errorCode: string };
    expect(r2.errorCode).toBe(REFUSAL_ERROR_CODE);
    const s = await a.syncSkills!({ agentId: "chef-b", companyId: "B", adapterType: "hermes_local", config: inv } as never, ["paperclipai/paperclip/first-task"]);
    expect(s.warnings.join(" ")).toMatch(/Aucun lien n'a été posé/);
    const l = await a.listSkills!({ agentId: "chef-a", companyId: "B", adapterType: "hermes_local", config: inv } as never);
    expect(l.warnings.join(" ")).toMatch(/profil Hermes inconnu/);
    expect(await exists(globalSkills())).toBe(false);
    expect(await exists(join(instB, "profiles", "chef", "skills"))).toBe(false);
    expect(await exists(join(instA, "profiles", "chef", "skills"))).toBe(false);
    expect(await fakeCalls(hb)).toEqual([]);
  });

  it("listSkills ne lit plus le global : un skill du global n'apparaît pas ; syncSkills écrit dans le profil affecté seulement", async () => {
    const inv = await inventory();
    await mkdir(join(globalSkills(), "perso", "secret-global"), { recursive: true });
    await writeFile(join(globalSkills(), "perso", "secret-global", "SKILL.md"), "---\nname: g\n---\n");
    const before = await readdir(globalSkills());
    const a = createServerAdapter();
    const l = await a.listSkills!({ agentId: "chef-a", companyId: "A", adapterType: "hermes_local", config: inv } as never);
    expect(l.entries.map((e) => e.key)).not.toContain("secret-global");
    const s = await a.syncSkills!({ agentId: "chef-a", companyId: "A", adapterType: "hermes_local", config: inv } as never, ["paperclipai/paperclip/first-task"]);
    expect(s.entries.find((e) => e.runtimeName === "first-task")?.state).toBe("configured");
    expect(await readdir(globalSkills())).toEqual(before);
  });

  it("<profil>/skills qui est un LIEN vers le profil d'une autre entreprise (ou le global) → refus sans écriture, sur les deux chemins", async () => {
    const inv = await inventory();
    await mkdir(join(instB, "profiles", "chef", "skills"), { recursive: true });
    await symlink(join(instB, "profiles", "chef", "skills"), join(instA, "profiles", "chef", "skills"));
    const a = createServerAdapter();
    const s = await a.syncSkills!({ agentId: "chef-a", companyId: "A", adapterType: "hermes_local", config: inv } as never, ["paperclipai/paperclip/first-task"]);
    expect(s.warnings.join(" ")).toMatch(/est un lien.*hors du profil.*aucun lien n'a été posé/);
    const r = (await a.execute(ctxRun("chef-a", "A", { ...inv }))) as { errorCode: string; errorMessage: string };
    expect(r.errorCode).toBe(REFUSAL_ERROR_CODE);
    expect(r.errorMessage).toMatch(/skills : .*est un lien/);
    expect(await readdir(join(instB, "profiles", "chef", "skills"))).toEqual([]);
    expect(await fakeCalls(hb)).toEqual([]);
  });
});

describe("11. authentification du modèle manquante / expirée : classe séparée, pas de relance", () => {
  it("classifyFailure : messages de Hermes v2026.9.24 (auth) ≠ messages transitoires ; quota « credentials are still valid » reste transitoire", () => {
    const f = (t: string, exitCode: number | null = 1) => classifyFailure(t, { exitCode, timedOut: false }).cls;
    expect(f("No Codex credentials stored. Run `hermes auth add openai-codex --type oauth` to authenticate. Run `hermes model` to re-authenticate.")).toBe("model_auth");
    expect(f("Codex token refresh failed with status 401. Run `hermes model` to re-authenticate.")).toBe("model_auth");
    expect(f("OpenAI Codex rejected your sign-in, so the model can't be reached. Sign in again: `hermes auth add openai-codex`.\n\nProvider said: 401")).toBe("model_auth");
    expect(f("\n⚠️  No API key found for provider 'anthropic'.")).toBe("model_auth");
    expect(f("OpenAI rate-limited every one of 3 attempts — it looks temporarily unavailable.")).toBe("transient");
    expect(f("OpenAI returned a server error on all 3 attempts — it looks temporarily unavailable.")).toBe("transient");
    expect(f("Codex provider quota exhausted (429); retry after 30s. Credentials are still valid.")).toBe("transient");
    expect(f("Traceback: something else")).toBe("unknown");
    expect(f("No Codex credentials stored", 0)).toBe("unknown"); // un passage réussi n'est jamais reclassé
    expect(classifyFailure("No Codex credentials stored", { exitCode: null, timedOut: true }).cls).toBe("transient");
  });

  async function fakeProvider(kind: "auth" | "transient") {
    // faux Hermes : imite la sortie de Hermes en mode -Q quand le fournisseur (fictif) refuse la connexion ou est indisponible
    const dir = join(root, "hp-" + kind);
    await mkdir(dir, { recursive: true });
    const p = join(dir, "hermes");
    const out = kind === "auth" ? "OpenAI Codex rejected your sign-in, so the model can't be reached. Sign in again: `hermes auth add openai-codex --type oauth`.\\n\\nProvider said: HTTP 401 invalid_token (fournisseur fictif)" : "OpenAI Codex returned a server error on all 3 attempts — it looks temporarily unavailable. Wait a minute and send /retry.\\n\\nProvider said: HTTP 503 (fournisseur fictif)";
    await writeFile(p, `#!/usr/bin/python3\nimport sys\nprint("${out}")\nsys.stderr.write("\\nsession_id: s-${kind}\\n")\nsys.exit(1)\n`);
    await chmod(p, 0o755);
    await setHermesBinary({ binary: p });
  }
  const ctxRun = (logs: string[] = []) => ({ runId: "r", agent: { id: "chef-a", companyId: "A", name: "Chef", adapterType: "hermes_local", adapterConfig: {} }, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null }, config: { cwd: root, timeoutSec: 30 }, context: {}, onLog: async (_s: string, t: string) => { logs.push(t); } }) as never;

  // classement réel du serveur Paperclip 2026.1001.0 installé (comme dans index.test.ts)
  const services = join(dirname(dirname(process.execPath)), "lib", "node_modules", "paperclipai", "node_modules", "@paperclipai", "server", "dist", "services");
  const serverPkg = join(services, "..", "..", "package.json");
  const available = existsSync(join(services, "recovery", "service.js")) && existsSync(serverPkg) && (JSON.parse(readFileSync(serverPkg, "utf8")) as { version: string }).version === "2026.1001.0";

  it("VRAIE base officielle : réponse « connexion refusée » du fournisseur fictif → configuration_incomplete (model_auth) ; panne 503 → résultat inchangé (transitoire)", async () => {
    await fakeProvider("auth");
    const a = createServerAdapter(createHermesLocalServerAdapter());
    const logs: string[] = [];
    const r = (await a.execute(ctxRun(logs))) as { exitCode: number; errorCode?: string; errorMessage?: string; resultJson: Record<string, Record<string, unknown>> };
    expect(r.exitCode).toBe(1);
    expect(r.errorCode).toBe(REFUSAL_ERROR_CODE);
    expect(r.errorMessage).toMatch(/authentification du MODÈLE manquante ou expirée.*pas de relance automatique/);
    expect(r.resultJson["configurationIncomplete"]).toMatchObject({ reason: "hermes_control_model_auth", fingerprint: "hermes_control:model_auth:chef-a" });
    expect(r.resultJson["hermesControl"]).toMatchObject({ failureClass: "model_auth" });
    await fakeProvider("transient");
    const t = (await a.execute(ctxRun())) as { exitCode: number; errorCode?: string; resultJson: Record<string, Record<string, unknown>> };
    expect(t.exitCode).toBe(1);
    expect(t.errorCode).toBeUndefined();
    expect(t.resultJson["hermesControl"]).toMatchObject({ failureClass: "transient" });
    expect(t.resultJson["configurationIncomplete"]).toBeUndefined();
  }, 30_000);

  it.skipIf(!available)("classement par le code serveur installé (recovery/service.js 2026.1001.0) : model_auth → configuration_incomplete (bloqué) ; transitoire → adapter_failed → transient_infra (reprise bornée)", async () => {
    const recovery = (await import(join(services, "recovery", "service.js"))) as {
      classifyAdapterFailureForRecovery: (run: unknown) => { kind: string } | null;
      classifyContinuationFailure: (run: unknown) => { kind: string };
    };
    const a = createServerAdapter(createHermesLocalServerAdapter());
    await fakeProvider("auth");
    const r = (await a.execute(ctxRun())) as { errorCode?: string; errorMessage?: string; resultJson: unknown };
    expect(recovery.classifyAdapterFailureForRecovery({ status: "failed", errorCode: r.errorCode, error: r.errorMessage, resultJson: r.resultJson })).toEqual({ kind: "configuration_incomplete" });
    await fakeProvider("transient");
    const t = (await a.execute(ctxRun())) as { errorCode?: string; errorMessage?: string; resultJson: unknown };
    const run = { status: "failed", errorCode: t.errorCode ?? "adapter_failed", error: t.errorMessage, resultJson: t.resultJson };
    expect(recovery.classifyAdapterFailureForRecovery(run)).toBeNull();
    expect(recovery.classifyContinuationFailure(run).kind).toBe("transient_infra");
  }, 60_000);
});

describe("annulation (constat de recette 0.6.2) : signal du serveur → groupe de processus de Hermes arrêté", () => {
  it("VRAIE base officielle : Hermes lent avec un descendant ; abandon du signal → execute rend la main, Hermes et son descendant sont arrêtés ; inscription onCancellationReady faite avant le lancement", async () => {
    const dir = join(root, "lent");
    await mkdir(dir, { recursive: true });
    const pids = join(root, "pids");
    const p = join(dir, "hermes");
    await writeFile(p, `#!/usr/bin/python3\nimport subprocess, time, os\nc = subprocess.Popen(["/usr/bin/sleep", "300"])\nopen("${pids}", "w").write("%d %d" % (os.getpid(), c.pid))\nprint("lent", flush=True)\ntime.sleep(300)\n`);
    await chmod(p, 0o755);
    await setHermesBinary({ binary: p });
    const ac = new AbortController();
    const order: string[] = [];
    const spawned: number[] = [];
    const a = createServerAdapter(createHermesLocalServerAdapter());
    const ctx = { runId: "r-cancel", agent: { id: "chef-a", companyId: "A", name: "Chef", adapterType: "hermes_local", adapterConfig: {} }, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null }, config: { cwd: root, timeoutSec: 120, graceSec: 2 }, context: {}, onLog: async () => {}, signal: ac.signal, onCancellationReady: async () => { order.push("ready"); }, onSpawn: async (m: { pid: number }) => { order.push("spawn"); spawned.push(m.pid); } } as never;
    const run = a.execute(ctx);
    for (let i = 0; i < 100 && !existsSync(pids); i++) await new Promise((r) => setTimeout(r, 50));
    const [hp, cp] = readFileSync(pids, "utf8").split(" ").map(Number) as [number, number];
    expect(order).toEqual(["ready", "spawn"]);
    expect(spawned).toEqual([hp]);
    ac.abort(new Error("Cancelled by control plane"));
    const r = (await run) as { exitCode: number | null; signal: string | null; resultJson?: Record<string, { state?: string; proof?: string }> };
    expect(r.signal ?? r.exitCode).toBeTruthy();
    // arrêt acquitté seulement parce que le groupe est vérifié vide (Paperclip l'exige pour confirmer l'annulation)
    expect(r.resultJson?.["executionCancellation"]).toMatchObject({ state: "acknowledged", proof: "hermes_control_process_group_empty" });
    await new Promise((res) => setTimeout(res, 300));
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(alive(hp)).toBe(false);
    expect(alive(cp)).toBe(false);
  }, 30_000);

  it("abandon AVANT le lancement : Hermes n'est pas lancé ; sans signal (ancien serveur) : comportement inchangé", async () => {
    const ac = new AbortController();
    ac.abort();
    const a = createServerAdapter(createHermesLocalServerAdapter());
    const ctx = (extra: Record<string, unknown>) => ({ runId: "r", agent: { id: "chef-a", companyId: "A", name: "Chef", adapterType: "hermes_local", adapterConfig: {} }, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null }, config: { cwd: root, timeoutSec: 30 }, context: {}, onLog: async () => {}, ...extra }) as never;
    const r = (await a.execute(ctx({ signal: ac.signal, onCancellationReady: async () => {} }))) as { errorMessage?: string };
    expect(r.errorMessage).toMatch(/annulé avant le lancement/);
    expect(await fakeCalls(hb)).toEqual([]);
    const ok = (await a.execute(ctx({}))) as { exitCode: number };
    expect(ok.exitCode).toBe(0);
    expect((await fakeCalls(hb)).length).toBe(1);
  }, 30_000);
});
