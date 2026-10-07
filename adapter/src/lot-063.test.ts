// 0.6.3, points 1 et 3 côté adaptateur : copies corrigées (voie 1) réellement chargées, HOME du compte dans le PROCESSUS
// FILS réel, fabrication des copies (base vérifiée, échec explicite si elle ne correspond plus).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHermesLocalServerAdapter } from "@paperclipai/hermes-paperclip-adapter";
import { assignAgent, setCompanyInstances, setHermesBinary } from "../../src/assignments.js";
import { fakeCalls, makeFakeHermes, writeRoots } from "../../src/testkit.js";
import { createServerAdapter } from "./index.js";

const ADAPTER = join(dirname(fileURLToPath(import.meta.url)), "..");
const HPA = join(ADAPTER, "node_modules", "@paperclipai", "hermes-paperclip-adapter");
const FINAL_ENV = join(HPA, "dist", "server", "final-env.js");
const NODE = process.execPath;
let root: string;
let hb: string;
let savedHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hc-063a-"));
  savedHome = process.env["HOME"];
  process.env["HOME"] = root;
  const inst = join(root, "ia");
  await mkdir(join(inst, "profiles", "chef"), { recursive: true });
  await writeFile(join(inst, "config.yaml"), "model:\n  provider: openai-codex\n  default: m\n");
  await writeFile(join(inst, "profiles", "chef", "config.yaml"), "model:\n  provider: openai-codex\n  default: m\n");
  await writeRoots(root);
  hb = join(root, "hb");
  await setHermesBinary({ binary: await makeFakeHermes(hb) });
  await setCompanyInstances("A", "A", [inst]);
  await assignAgent({ agentId: "chef-a", companyId: "A", instanceHome: inst, profile: "chef", name: "Chef", assignedBy: "u" });
});
afterEach(() => {
  if (savedHome) process.env["HOME"] = savedHome;
});

const ctx = (config: Record<string, unknown>, logs: string[] = []) => ({ runId: "r", agent: { id: "chef-a", companyId: "A", name: "Chef", adapterType: "hermes_local", adapterConfig: {} }, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null }, config: { cwd: root, timeoutSec: 30, ...config }, context: {}, onLog: async (_s: string, t: string) => { logs.push(t); } }) as never;

/** Pilote dans un bwrap (base des comptes FICTIVE) ; `script` reçoit /m/final-env.js et /m/hpa (paquet corrigé, lecture seule). */
function inSandbox(uid: number, passwd: string[], script: string): Record<string, unknown> {
  const pw = join(root, `passwd-${uid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(pw, passwd.join("\n") + "\n");
  const drv = join(root, `pilote-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(drv, script);
  const r = spawnSync("/usr/bin/bwrap", ["--unshare-all", "--die-with-parent", "--uid", String(uid), "--gid", String(uid),
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib", "/lib64",
    "--ro-bind", pw, "/etc/passwd", "--ro-bind", "/etc/nsswitch.conf", "/etc/nsswitch.conf", "--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--ro-bind", dirname(dirname(NODE)), dirname(dirname(NODE)),
    "--ro-bind", join(ADAPTER, "node_modules"), "/m/node_modules", "--ro-bind", drv, "/m/pilote.mjs",
    "--clearenv", "--setenv", "PATH", "/usr/bin", "--setenv", "HOME", "/tmp/home-mensonger", NODE, "/m/pilote.mjs"], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}
const BUILD_AND_SPAWN = `
import { spawnSync } from "node:child_process";
const m = await import("/m/node_modules/@paperclipai/hermes-paperclip-adapter/dist/server/final-env.js");
const ctx = { runId: "r", agent: { id: "a", companyId: "c" }, context: {}, authToken: "t" };
let b; try { b = m.buildFinalEnv({ ctx, configEnv: JSON.parse(process.argv[2] ?? "{}"), apiUrl: "http://127.0.0.1:1/api" }); }
catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); process.exit(0); }
const out = spawnSync("/usr/bin/env", [], { env: b.env, encoding: "utf8" }).stdout;
const env = Object.fromEntries(out.trim().split("\\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
console.log(JSON.stringify({ ok: true, HOME: env.HOME, USER: env.USER, rejected: b.rejected.map((x) => x.name) }));
`;

describe("point 1 : HOME dans la copie RÉELLEMENT embarquée (node_modules de l'adaptateur, issue de voie1/paquets)", () => {
  it("la copie embarquée de final-env.js est celle du correctif (octet pour octet)", async () => {
    const patch = await readFile(join(ADAPTER, "voie1", "patches", "hermes-paperclip-adapter-2026.1001.0.patch"), "utf8");
    const part = patch.split(/^diff -ruN /m).find((p) => p.startsWith("a/hermes-paperclip-adapter/dist/server/final-env.js"))!;
    const added = part.split("\n").slice(3).filter((l) => l.startsWith("+")).map((l) => l.slice(1));
    const copy = readFileSync(FINAL_ENV, "utf8");
    expect(copy.replace(/\n$/, "")).toBe(added.join("\n").replace(/\n$/, ""));
    expect(copy).toMatch(/os\.userInfo\(\)/);
    expect(copy).not.toMatch(/os\.homedir\(\)\s*[,;)]/);
  });

  it("bwrap, base des comptes fictive : HOME hérité mensonger → fils = compte ; HOME hostile de config.env → refusé ; uid inconnu, vide, relatif → refus sans repli", () => {
    const pw = ["compte:x:1234:1234::/home/compte-recette:/bin/sh"];
    expect(inSandbox(1234, pw, BUILD_AND_SPAWN)).toMatchObject({ ok: true, HOME: "/home/compte-recette", USER: "compte" });
    const hostile = inSandbox(1234, pw, BUILD_AND_SPAWN.replace('process.argv[2] ?? "{}"', `'{"HOME":"/tmp/home-hostile","USER":"root"}'`));
    expect(hostile).toMatchObject({ ok: true, HOME: "/home/compte-recette", USER: "compte" });
    expect(hostile["rejected"]).toEqual(expect.arrayContaining(["HOME", "USER"]));
    expect(inSandbox(4242, ["autre:x:1234:1234::/home/autre:/bin/sh"], BUILD_AND_SPAWN)).toMatchObject({ ok: false, error: expect.stringMatching(/introuvable.*aucun repli/) });
    expect(inSandbox(1234, ["compte:x:1234:1234:::/bin/sh"], BUILD_AND_SPAWN)).toMatchObject({ ok: false, error: expect.stringMatching(/invalide.*aucun repli/) });
    expect(inSandbox(1234, ["compte:x:1234:1234::home/relatif:/bin/sh"], BUILD_AND_SPAWN)).toMatchObject({ ok: false, error: expect.stringMatching(/invalide/) });
  }, 30_000);

  it("bwrap : l'execute CORRIGÉ avec un compte introuvable REFUSE et ne lance rien (pas de repli vers $HOME)", () => {
    const marker = "/tmp/LANCE";
    const script = `
import { writeFileSync, chmodSync, existsSync } from "node:fs";
writeFileSync("/tmp/hermes", "#!/bin/sh\\ntouch ${marker}\\n"); chmodSync("/tmp/hermes", 0o755);
const { execute } = await import("/m/node_modules/@paperclipai/hermes-paperclip-adapter/dist/server/index.js");
let error = null;
try { await execute({ runId: "r", agent: { id: "a", companyId: "c", name: "X", adapterConfig: {} }, runtime: {}, config: { hermesCommand: "/tmp/hermes", cwd: "/tmp", timeoutSec: 5 }, context: {}, onLog: async () => {} }); }
catch (e) { error = e.message; }
console.log(JSON.stringify({ error, launched: existsSync("${marker}") }));
`;
    const r = inSandbox(4242, ["autre:x:1234:1234::/home/autre:/bin/sh"], script);
    expect(r["error"]).toMatch(/compte d'exécution introuvable.*aucun repli/);
    expect(r["launched"]).toBe(false);
  }, 30_000);

  it("PROCESSUS FILS réel par l'adaptateur Hermes Control complet : HOME/USER/LOGNAME du compte malgré un HOME de processus mensonger et un config.env hostile", async () => {
    const a = createServerAdapter(createHermesLocalServerAdapter());
    const logs: string[] = [];
    process.env["HOME"] = root; // HOME du processus (≠ compte)
    const r = (await a.execute(ctx({ env: { HOME: "/tmp/home-hostile", USER: "root", LOGNAME: "root" } }, logs))) as { exitCode: number };
    expect(r.exitCode).toBe(0);
    const [c] = await fakeCalls(hb);
    expect(c!.env["HOME"]).toBe(userInfo().homedir);
    expect(c!.env["USER"]).toBe(userInfo().username);
    expect(c!.env["LOGNAME"]).toBe(userInfo().username);
    expect(logs.join("")).toMatch(/env de l'agent : HOME, USER, LOGNAME ignoré/);
  });
});

describe("point 3 : copies corrigées — fabrication et chargement", () => {
  it("les paquets installés sont les copies corrigées (version hc063, provenance) et l'adaptateur officiel importe CETTE copie d'adapter-utils", async () => {
    const hpa = JSON.parse(await readFile(join(HPA, "package.json"), "utf8"));
    const au = JSON.parse(await readFile(join(ADAPTER, "node_modules", "@paperclipai", "adapter-utils", "package.json"), "utf8"));
    expect(hpa.version).toBe("2026.1001.0-hc063.1");
    expect(au.version).toBe("2026.1001.0-hc063.1");
    expect(hpa.hermesControlPatch.base).toBe("@paperclipai/hermes-paperclip-adapter@2026.1001.0");
    expect(existsSync(join(HPA, "node_modules", "@paperclipai", "adapter-utils"))).toBe(false); // aucune copie imbriquée
    const server = (await import("@paperclipai/hermes-paperclip-adapter/server")) as Record<string, unknown>;
    expect(server["HERMES_FINAL_ENV_PATCH"]).toBe("hermes-control-voie1/hermes-paperclip-adapter@2026.1001.0/2");
    expect((server["HERMES_FINAL_ENV_ADAPTER_UTILS"] as { patch: string }).patch).toBe("hermes-control-voie1/adapter-utils@2026.1001.0/2");
  });

  it("fabriquer.sh --verifier : les archives se reconstruisent à l'identique depuis les archives publiées + correctifs", () => {
    const r = spawnSync("bash", [join(ADAPTER, "voie1", "fabriquer.sh"), "--verifier"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/identiques/);
  }, 120_000);

  it("ÉCHEC EXPLICITE si la base ne correspond plus (empreinte) ou si un correctif ne s'applique plus exactement ; rien n'est écrit", async () => {
    for (const [what, mutate, code, msg] of [
      ["empreinte", async (d: string) => { const f = join(d, "origine", "SHA256SUMS-2026.1001.0"); await writeFile(f, (await readFile(f, "utf8")).replace(/^[0-9a-f]{8}/, "00000000")); }, 4, /la base ne correspond plus/],
      ["correctif", async (d: string) => { const f = join(d, "patches", "adapter-utils-2026.1001.0.patch"); await writeFile(f, (await readFile(f, "utf8")).replace("    const inheritEnv = opts.inheritEnv !== false;", "    const inheritEnv = opts.inheritEnv !== false;").replace(/^ export async function runChildProcess/m, " export async function runChildProcessX")); }, 5, /ne s'applique pas/],
      ["intégrité", async (d: string) => { const f = join(d, "origine", "INTEGRITE-2026.1001.0"); await writeFile(f, (await readFile(f, "utf8")).replace("sha512-ELFd", "sha512-XXXX")); }, 3, /intégrité/],
    ] as const) {
      const d = join(root, `voie1-${what}`);
      await cp(join(ADAPTER, "voie1"), d, { recursive: true });
      await mutate(d);
      const r = spawnSync("bash", [join(d, "fabriquer.sh"), "--verifier"], { encoding: "utf8" });
      expect(r.status, `${what} : ${r.stderr}`).toBe(code);
      expect(r.stderr).toMatch(msg);
    }
  }, 180_000);
});
