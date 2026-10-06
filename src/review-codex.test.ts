// Les six sondes de relecture de Codex (06/10/2026, preuves-codex-hc06-2026-10-06/review.test.ts), reprises UNE PAR UNE avec
// les attentes INVERSÉES : là où la sonde constatait le défaut de la 0.6.0 (f5d4327), ce test exige le refus ou le nettoyage.
// Même montage que les sondes (HOME temporaire, faux clone, lanceurs non exécutables, espion à la place de base.execute).
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestHarness } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import plugin from "./worker.js";
import manifest from "./manifest.js";
import { assignmentsFile, readAssignments, resolveAssignment, setCompanyInstances } from "./assignments.js";
import { agentsMapFile, readProjection } from "./agents-map.js";
import { createServerAdapter } from "../adapter/src/index.js";
import { homeFromLauncherFile } from "./hermes.js";
import { EMPTY_ENV, prepareAgent, preparingFile, profileUsability } from "./prepare.js";
import { checkProfile } from "./health.js";
import { ownerFile, readOwner, withDirLock } from "./lock.js";

let root: string;
let profile: string;
const saved = new Map<string, string | undefined>();
function env(key: string, value: string) { saved.set(key, process.env[key]); process.env[key] = value; }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hc-r-")); // court : le contrôle de socket (≤ 100 octets) doit passer pour le cas positif
  env("HOME", root);
  env("HERMES_CONTROL_ROOTS", join(root, "instances"));
  const fake = join(root, "fake-hermes");
  await writeFile(fake, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  env("HERMES_CONTROL_HERMES_BIN", fake);
  profile = join(root, "instances", "societe-a", "profiles", "assistant");
  await mkdir(profile, { recursive: true });
  await writeFile(join(root, "instances", "societe-a", "config.yaml"), "model: {}\n");
  await writeFile(join(profile, "config.yaml"), "model: {}\n");
});
afterEach(() => { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } saved.clear(); });

it("sonde n°1 inversée : ouvrir la vue de B n'affecte PAS son Assistant au profil de A ; rien n'est écrit ; B ne démarre pas", async () => {
  const h = createTestHarness({ manifest: manifest as never, config: {} });
  await plugin.definition.setup(h.ctx);
  h.seed({ companies: [{ id: "B", name: "Societe B" } as never], agents: [{ id: "agent-B", companyId: "B", name: "Assistant", adapterType: "hermes_local", adapterConfig: {}, status: "idle" } as never] });
  expect((await resolveAssignment("agent-B")).ok).toBeNull();
  const r = await h.getData<{ sync: { assignment: unknown; home: string | null; error: string | null; suggestion: unknown }[] }>("instances", { companyId: "B" });
  expect(r.sync[0]!.assignment).toBeNull();
  expect(r.sync[0]!.home).toBeNull();
  expect(r.sync[0]!.error).toBe("non affecté");
  expect(r.sync[0]!.suggestion).toBeNull(); // l'instance de A n'est pas autorisée pour B : pas même suggérée
  expect((await resolveAssignment("agent-B")).ok).toBeNull();
  await expect(stat(assignmentsFile())).rejects.toThrow();
  await expect(stat(agentsMapFile())).rejects.toThrow();
  // même avec societe-a déclarée pour B (instance autorisée), la vue SUGGÈRE mais n'affecte pas
  await setCompanyInstances("B", "Societe B", [join(root, "instances", "societe-a")]);
  const before = await readFile(assignmentsFile(), "utf8");
  const r2 = await h.getData<{ sync: { assignment: unknown; suggestion: { profile: string } | null }[] }>("instances", { companyId: "B" });
  expect(r2.sync[0]!.assignment).toBeNull();
  expect(r2.sync[0]!.suggestion?.profile).toBe("assistant");
  expect(await readFile(assignmentsFile(), "utf8")).toBe(before);
  expect(Object.keys((await readProjection()).projection?.agents ?? {})).toEqual([]);
  // et l'adaptateur refuse de démarrer B
  const calls: unknown[] = [];
  const real = createServerAdapter();
  const adapter = createServerAdapter({ ...real, execute: async (ctx: unknown) => { calls.push(ctx); return {} as never; } });
  await expect(adapter.execute({ agent: { id: "agent-B", companyId: "B", name: "Assistant", adapterConfig: {} }, config: {}, onLog: async () => {} } as never)).rejects.toThrow(/non affecté/);
  expect(calls).toEqual([]);
});

async function runWithLauncher(contents: string) {
  const launcher = join(root, "launcher");
  await writeFile(launcher, contents); // Pas exécutable : le faux execute ne le lance jamais.
  await setCompanyInstances("c", "Societe", [join(root, "instances", "societe-a")]);
  const { assignAgent } = await import("./assignments.js");
  await assignAgent({ agentId: "agent", companyId: "c", instanceHome: join(root, "instances", "societe-a"), profile: "assistant", name: "Assistant", assignedBy: "user:u1" });
  const calls: unknown[] = [];
  const real = createServerAdapter();
  const adapter = createServerAdapter({ ...real, execute: async (ctx: unknown) => { calls.push(ctx); return {} as never; } });
  const run = adapter.execute({ agent: { id: "agent", companyId: "c", name: "Assistant", adapterConfig: {} }, config: { hermesCommand: launcher, cwd: root }, onLog: async () => {} } as never);
  return { calls, launcher, run };
}

it("sonde n°2 inversée : un lanceur au home non résolu N'EST PAS transmis à execute (refus explicite)", async () => {
  const { calls, launcher, run } = await runWithLauncher('#!/bin/sh\nexport HERMES_HOME="$UNKNOWN_REVIEW_ROOT/ailleurs"\nexec hermes "$@"\n');
  expect((await homeFromLauncherFile(launcher)).error).toMatch(/non résolu/);
  await expect(run).rejects.toThrow(/lanceur incertain, refus/);
  expect(calls).toHaveLength(0);
});

it("sonde n°3 inversée : un second export HERMES_HOME divergent est REFUSÉ (pas de premier export retenu)", async () => {
  const { calls, launcher, run } = await runWithLauncher(`#!/bin/sh\nexport HERMES_HOME="${profile}"\nexport HERMES_HOME="${join(root, "autre-profil")}"\nexec hermes "$@"\n`);
  const parsed = await homeFromLauncherFile(launcher);
  expect(parsed.home).toBeNull();
  expect(parsed.error).toMatch(/plusieurs HERMES_HOME/);
  await expect(run).rejects.toThrow(/plusieurs HERMES_HOME/);
  expect(calls).toHaveLength(0);
});

it("sonde n°3 bis (cas positif) : un seul HERMES_HOME identique à l'affectation → transmis à execute", async () => {
  const { calls, run } = await runWithLauncher(`#!/bin/sh\nexport HERMES_HOME="${profile}"\nexec hermes "$@"\n`);
  await run;
  expect(calls).toHaveLength(1);
});

it("sonde n°4 inversée : un clone partiel en échec NE LAISSE PAS le marqueur factice dans .env ; le profil est inutilisable jusqu'à la reprise", async () => {
  const inst = join(root, "clone-instance");
  await mkdir(inst, { recursive: true });
  const fake = join(root, "fake-partial-clone");
  await writeFile(fake, '#!/bin/sh\np="$HERMES_HOME/profiles/$3"\nmkdir -p "$p"\nprintf "model: {}\\n" > "$p/config.yaml"\nprintf "REVIEW_FAKE_TOKEN=not-a-secret\\n" > "$p/.env"\nexit 1\n', { mode: 0o700 });
  const ws = { root, agents: join(root, "agents"), profils: join(root, "instances"), skills: join(root, "skills"), modeles: join(root, "modeles") };
  await expect(prepareAgent({ ws: ws as never, instanceHome: inst, agentName: "Test", title: null, entreprise: "Test", binary: fake })).rejects.toThrow(/clone du profil « test » en échec/);
  const home = join(inst, "profiles", "test");
  expect(await readFile(join(home, ".env"), "utf8")).not.toContain("REVIEW_FAKE_TOKEN");
  expect(await readFile(join(home, ".env"), "utf8")).toBe(EMPTY_ENV);
  expect(await stat(join(home, ".hermes-control", "prepared-by-hermes-control"))).toBeTruthy();
  expect(await stat(join(home, ".hermes-control", "env-cleaned"))).toBeTruthy();
  expect(await stat(preparingFile(inst, "test"))).toBeTruthy(); // état conservé : inutilisable
  expect(await profileUsability(inst, "test")).toMatch(/inutilisable/);
  // reprise : le clone n'est plus nécessaire (config.yaml présent) → nettoyage terminé, utilisable
  await prepareAgent({ ws: ws as never, instanceHome: inst, agentName: "Test", binary: "/bin/false" });
  expect(await profileUsability(inst, "test")).toBeNull();
  await expect(stat(preparingFile(inst, "test"))).rejects.toThrow();
});

it("sonde n°5 inversée : le diagnostic est ROUGE avec un chemin watchdog de plus de 108 octets, sans socket créé", async () => {
  const home = join(root, "x".repeat(80 - Buffer.byteLength(root) - 1));
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.yaml"), "model: {}\n");
  const result = await checkProfile(home);
  expect(result.socketPathOk).toBe(false);
  expect(result.sockets).toEqual([]);
  expect(Buffer.byteLength(join(home, "state", "gateway.loop-tick.123456.sock"))).toBeGreaterThan(108);
  expect(result.longest).toBe(join(home, "state", "gateway.loop-tick.4194304.sock"));
});

it("sonde n°6 inversée : un ancien détenteur NE LIBÈRE PAS le verrou de son successeur ; un propriétaire vivant vieilli n'est pas repris", async () => {
  const lock = join(root, "operation.lock");
  const opts = { waitMs: 0, staleMs: 30_000, busy: "occupe", renewMs: 3_600_000 };
  let enterA!: () => void, releaseA!: () => void, enterB!: () => void, releaseB!: () => void;
  const enteredA = new Promise<void>((r) => { enterA = r; });
  const finishA = new Promise<void>((r) => { releaseA = r; });
  const enteredB = new Promise<void>((r) => { enterB = r; });
  const finishB = new Promise<void>((r) => { releaseB = r; });
  const a = withDirLock(lock, opts, async () => { enterA(); await finishA; });
  await enteredA;
  // Vieillir le dossier d'un propriétaire VIVANT : B ne doit PAS le reprendre
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  await expect(withDirLock(lock, opts, async () => "x")).rejects.toThrow(/occupe/);
  // Simuler l'ABANDON réel de A (pid mort, bail périmé) : B reprend ; A, en terminant, ne touche pas au verrou de B
  const ownerA = (await readOwner(lock))!;
  await writeFile(ownerFile(lock), JSON.stringify({ ...ownerA, pid: 4194303, renewedAt: old.toISOString() }));
  const b = withDirLock(lock, opts, async () => { enterB(); await finishB; });
  await enteredB;
  releaseA(); await a;
  try {
    expect((await stat(lock)).isDirectory()).toBe(true); // B travaille toujours, son verrou est intact
    expect((await readOwner(lock))?.token).not.toBe(ownerA.token);
    let cEntered = false;
    await expect(withDirLock(lock, opts, async () => { cEntered = true; })).rejects.toThrow(/occupe/);
    expect(cEntered).toBe(false);
  } finally { releaseB(); await b; }
  await expect(stat(lock)).rejects.toThrow();
  expect((await readAssignments()).exists).toBe(false); // rien d'autre n'a été écrit
});
