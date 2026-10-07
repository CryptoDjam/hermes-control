// Adaptateur 0.6.1 : EXÉCUTION MAÎTRISÉE. L'adaptateur construit lui-même la commande (binaire administré, HERMES_HOME
// littéral, environnement explicite) ; le hermesCommand de l'agent, un nom nu ou le PATH ne lancent jamais rien ; tout refus
// de configuration est RENDU (errorCode configuration_incomplete), jamais levé, et Hermes n'est pas appelé.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, copyFile, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { createHermesLocalServerAdapter } from "@paperclipai/hermes-paperclip-adapter";
import { assignAgent, assignmentsFile, setCompanyInstances, setExecutionRoot, setHermesBinary } from "../../src/assignments.js";
import { agentsMapFile } from "../../src/agents-map.js";
import { preparingFile } from "../../src/prepare.js";
import { PYTHON, fakeCalls, makeFakeHermes, writeRoots } from "../../src/testkit.js";
import { REFUSAL_ERROR_CODE, createServerAdapter } from "./index.js";

let root: string;
let inst: string;
let hb: string; // dossier du faux point d'entrée administré
let fake: string;
let savedHome: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hc-ad-"));
  savedHome = process.env["HOME"];
  process.env["HOME"] = root; // référence de test : <root>/.config/hermes-control (vitest.setup.ts)
  inst = join(root, "marketing");
  await mkdir(join(inst, "profiles", "apolline-m"), { recursive: true });
  await writeFile(join(inst, "config.yaml"), "model:\n  provider: openai-codex\n  default: gpt-5.6-luna\n");
  await writeFile(join(inst, "profile.yaml"), "description: CMO — directeur marketing\n");
  await writeFile(join(inst, "profiles", "apolline-m", "config.yaml"), "model:\n  provider: openai-codex\n  default: gpt-5.6-luna\n");
  await writeFile(join(inst, "profiles", "apolline-m", "profile.yaml"), "description: Apolline M, influenceuse IA\n");
  await writeFile(join(inst, "provider_models_cache.json"), JSON.stringify({ "openai-codex": { models: ["gpt-5.6-luna", "gpt-6-sol"] }, anthropic: { models: ["claude-x"] } }));
  await writeRoots(root);
  hb = join(root, "hb");
  fake = await makeFakeHermes(hb);
});
afterEach(() => {
  if (savedHome) process.env["HOME"] = savedHome;
});

const HOME_APOLLINE = () => join(root, "marketing", "profiles", "apolline-m");
async function assignApolline(companyId = "c", administer = true) {
  await setCompanyInstances(companyId, "Societe C", [inst]);
  await assignAgent({ agentId: "ok", companyId, instanceHome: inst, profile: "apolline-m", name: "Apolline M", assignedBy: "user:u1" });
  if (administer) await setHermesBinary({ binary: fake });
}

type Cfg = Record<string, unknown>;
function withSpy() {
  const calls: Cfg[] = [];
  const real = createServerAdapter();
  const base = { ...real, execute: async (ctx: { config?: Cfg }) => { calls.push(ctx.config ?? {}); return { exitCode: 0, signal: null, timedOut: false } as never; } } as unknown as Parameters<typeof createServerAdapter>[0];
  return { a: createServerAdapter(base), calls };
}
const ctxFor = (id: string, name: string, logs: string[], config: Cfg = {}, companyId: string | null = "c") => ({ runId: "r", agent: { id, companyId, name, adapterType: "hermes_local", adapterConfig: {} }, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null }, config, context: {}, onLog: async (_s: string, t: string) => { logs.push(t); } }) as never;

type Res = { errorCode?: string; errorMessage?: string; exitCode: number | null; resultJson?: Record<string, unknown> };
async function expectRefused(p: Promise<unknown>, re: RegExp): Promise<Res> {
  const r = (await p) as Res; // un refus est RENDU, jamais levé (une exception deviendrait « adapter_failed », réessayé)
  expect(r.errorCode).toBe(REFUSAL_ERROR_CODE);
  expect(r.errorMessage).toMatch(re);
  expect((r.resultJson?.["configurationIncomplete"] as { reason: string }).reason).toMatch(/^hermes_control_/);
  return r;
}

describe("adaptateur Hermes Control : menus et fonctions de base", () => {
  it("garde le type hermes_local et les fonctions de base", () => {
    const a = createServerAdapter();
    expect(a.type).toBe("hermes_local");
    expect(typeof a.execute).toBe("function");
    expect(typeof a.sessionCodec).toBe("object");
  });

  it("liste les modèles de Hermes pour les providers configurés (racines de la référence, sans variable)", async () => {
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
});

describe("affectation contrôlée avant tout passage (refus rendus, Hermes jamais appelé)", () => {
  it("R02b : un agent sans affectation explicite refuse de tourner, même si un profil porte son nom ; projection ancienne ignorée", async () => {
    const { a, calls } = withSpy();
    const logs: string[] = [];
    await expectRefused(a.execute(ctxFor("x", "Apolline M", logs)), /non affecté.*aucune affectation explicite/);
    expect(calls).toEqual([]);
    expect(logs.join("")).toContain("assignments.json");
    await mkdir(dirname(agentsMapFile()), { recursive: true });
    await writeFile(agentsMapFile(), JSON.stringify({ x: { name: "Apolline M", instance: "marketing", profile: "apolline-m", home: HOME_APOLLINE(), at: "t" } }));
    await expectRefused(a.execute(ctxFor("x", "Apolline M", [])), /non affecté.*projection ancienne/);
    expect(calls).toEqual([]);
  });

  it("affecté et présent → passe ; affecté mais sans config.yaml → refus", async () => {
    const { a, calls } = withSpy();
    await assignApolline();
    await assignAgent({ agentId: "gone", companyId: "c", instanceHome: inst, profile: "parti", name: "Parti", assignedBy: "u" });
    await expectRefused(a.execute(ctxFor("gone", "Parti", [])), /config.yaml n'existe pas.*à préparer/);
    expect(calls).toEqual([]);
    const logs: string[] = [];
    await a.execute(ctxFor("ok", "Apolline M", logs));
    expect(calls).toHaveLength(1);
    expect((calls[0]!["env"] as Cfg)["HERMES_HOME"]).toBe(HOME_APOLLINE());
    expect(logs.join("")).toMatch(/affectation explicite, table, par user:u1/);
    expect(logs.join("")).toMatch(/binaire .*hb\/hermes · sha256 [0-9a-f]{16}… · Python · interpréteur \/usr\/bin\/python3/);
  });

  it("l'affectation est contrôlée pour l'ENTREPRISE de l'agent : autre entreprise → refus", async () => {
    const { a, calls } = withSpy();
    await assignApolline("c");
    await expectRefused(a.execute(ctxFor("ok", "Apolline M", [], {}, "autre")), /pour l'entreprise c, pas pour autre/);
    expect(calls).toEqual([]);
    await a.execute(ctxFor("ok", "Apolline M", [], {}, null));
    expect(calls).toHaveLength(1);
  });

  it("instance plus autorisée (table éditée) → refus ; profil revendiqué deux fois → refus ; table corrompue → refus « table »", async () => {
    const { a, calls } = withSpy();
    await assignApolline();
    const t = JSON.parse(await readFile(assignmentsFile(), "utf8")) as { companies: Record<string, { instances: string[] }>; agents: Record<string, unknown> };
    t.companies["c"]!.instances = [];
    await writeFile(assignmentsFile(), JSON.stringify(t));
    await expectRefused(a.execute(ctxFor("ok", "Apolline M", [])), /affectation invalide.*non autorisée pour l'entreprise/);
    t.companies["c"]!.instances = [inst];
    t.agents["dup"] = { companyId: "c", instanceHome: inst, profile: "apolline-m", name: "Doublon", assignedAt: "t", assignedBy: "m" };
    await writeFile(assignmentsFile(), JSON.stringify(t));
    await expectRefused(a.execute(ctxFor("ok", "Apolline M", [])), /revendiqué par 2 agents/);
    await writeFile(assignmentsFile(), "{ cassé");
    const r = await expectRefused(a.execute(ctxFor("ok", "Apolline M", [])), /corrompu/);
    expect((r.resultJson!["hermesControl"] as { kind: string }).kind).toBe("table");
    expect(calls).toEqual([]);
  });

  it("profil au config.yaml invalide → refus ; préparation interrompue ou .env non nettoyé → refus ; nettoyé → passe", async () => {
    const { a, calls } = withSpy();
    await assignApolline();
    const home = join(inst, "profiles", "casse");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.yaml"), "model: [oops\n");
    await assignAgent({ agentId: "k", companyId: "c", instanceHome: inst, profile: "casse", name: "Casse", assignedBy: "u" });
    await expectRefused(a.execute(ctxFor("k", "Casse", [])), /config.yaml invalide/);
    await mkdir(join(inst, ".hermes-control"), { recursive: true });
    await writeFile(preparingFile(inst, "apolline-m"), JSON.stringify({ startedAt: "t", pid: 4194303, stage: "cloning" }));
    await expectRefused(a.execute(ctxFor("ok", "Apolline M", [])), /préparation du profil « apolline-m » interrompue.*inutilisable/);
    await rm(preparingFile(inst, "apolline-m"));
    await mkdir(join(HOME_APOLLINE(), ".hermes-control"), { recursive: true });
    await writeFile(join(HOME_APOLLINE(), ".hermes-control", "prepared-by-hermes-control"), "t\n");
    await expectRefused(a.execute(ctxFor("ok", "Apolline M", [])), /sans \.env nettoyé/);
    expect(calls).toEqual([]);
    await writeFile(join(HOME_APOLLINE(), ".hermes-control", "env-cleaned"), "t\n");
    await a.execute(ctxFor("ok", "Apolline M", []));
    expect(calls).toHaveLength(1);
  });

  it("une ancienne variable HERMES_CONTROL_* encore posée → refus explicite (pas de repli silencieux sur le dossier du compte)", async () => {
    const { a, calls } = withSpy();
    await assignApolline();
    process.env["HERMES_CONTROL_ASSIGNMENTS"] = "/srv/autre/assignments.json";
    try {
      const r = await expectRefused(a.execute(ctxFor("ok", "Apolline M", [])), /HERMES_CONTROL_ASSIGNMENTS.*ne sont plus lues.*référence unique est .*\.config\/hermes-control/);
      expect((r.resultJson!["hermesControl"] as { kind: string }).kind).toBe("reference");
    } finally {
      delete process.env["HERMES_CONTROL_ASSIGNMENTS"];
    }
    expect(calls).toEqual([]);
  });
});

// Les cinq variantes de lanceur de la recette T-f3 (06/10/2026, …/recette06/lanceurs/), réécrites sur les chemins du test :
// chacune déclare A puis bascule vers B par un moyen que la lecture statique de la 0.6.0 ne voyait pas.
function launcherVariants(a: string, b: string, bin: string, extra: string): Record<string, string> {
  return {
    envcmd: `#!/bin/bash\nexport HERMES_HOME="${a}"\nexec env HERMES_HOME="${b}" "${bin}" "$@"\n`,
    declare: `#!/bin/bash\nexport HERMES_HOME="${a}"\ndeclare -x HERMES_HOME="${b}"\nexec "${bin}" "$@"\n`,
    append: `#!/bin/bash\nexport HERMES_HOME="${a}"\nexport HERMES_HOME+="/../../../b/profiles/chef"\nexec "${bin}" "$@"\n`,
    source: `#!/bin/bash\nexport HERMES_HOME="${a}"\ncd /tmp; source ${extra}\nexec "${bin}" "$@"\n`,
    unexport: `#!/bin/bash\nexport HERMES_HOME="${a}"\nexport -n HERMES_HOME; HERMES_HOME=x\nexec "${bin}" "$@"\n`,
  };
}

describe("exécution maîtrisée : seul le binaire ADMINISTRÉ est lancé, avec la commande et l'environnement construits ici", () => {
  async function writeVariants() {
    const dir = join(root, "lanceurs");
    await mkdir(dir, { recursive: true });
    const extra = join(dir, "extra.sh");
    await writeFile(extra, `export HERMES_HOME="${join(root, "b", "profiles", "chef")}"\n`);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(launcherVariants(HOME_APOLLINE(), join(root, "b", "profiles", "chef"), fake, extra))) {
      out[k] = join(dir, k);
      await writeFile(out[k]!, v);
      await chmod(out[k]!, 0o755);
    }
    return out;
  }

  it("T-f3 : les 5 variantes en hermesCommand de l'agent sont IGNORÉES — la commande transmise est le binaire administré, HERMES_HOME celui de l'affectation", async () => {
    const { a, calls } = withSpy();
    await assignApolline();
    const variants = await writeVariants();
    for (const [name, path] of Object.entries(variants)) {
      const logs: string[] = [];
      await a.execute(ctxFor("ok", "Apolline M", logs, { hermesCommand: path, command: path }));
      const cfg = calls[calls.length - 1]!;
      expect(cfg["hermesCommand"], name).toBe(fake);
      expect(cfg["command"], name).toBeUndefined();
      expect((cfg["env"] as Cfg)["HERMES_HOME"], name).toBe(HOME_APOLLINE());
      expect(logs.join(""), name).toContain(`commande de l'agent ignorée (${path}`);
    }
    expect(calls).toHaveLength(5);
  });

  it("T-f3 : les 5 variantes ADMINISTRÉES comme binaire (table écrite à la main) → refus « script shell », jamais lancées", async () => {
    const { a, calls } = withSpy();
    await assignApolline();
    for (const [name, path] of Object.entries(await writeVariants())) {
      await expect(setHermesBinary({ binary: path }), name).rejects.toThrow(/script shell \(bash\)/);
      const t = JSON.parse(await readFile(assignmentsFile(), "utf8")) as Cfg;
      t["hermes"] = { binary: path };
      await writeFile(assignmentsFile(), JSON.stringify(t));
      const r = await expectRefused(a.execute(ctxFor("ok", "Apolline M", [])), /script shell \(bash\), pas un point d'entrée Hermes/);
      expect((r.resultJson!["hermesControl"] as { kind: string }).kind, name).toBe("binary");
    }
    expect(calls).toEqual([]);
  });

  it("binaire administré refusé : `bash` (nom nu), nom inconnu, chemin relatif, /bin/bash (shell, root), lien vers un autre binaire, fichier modifiable par le groupe, empreinte différente", async () => {
    const { a, calls } = withSpy();
    await assignApolline(); // binaire valide d'abord
    const set = async (hermes: Cfg) => {
      const t = JSON.parse(await readFile(assignmentsFile(), "utf8")) as Cfg;
      t["hermes"] = hermes;
      await writeFile(assignmentsFile(), JSON.stringify(t));
    };
    // un nom nu ou relatif n'entre même pas dans la table (schéma)
    for (const b of ["bash", "commande-inconnue", "bin/hermes", "./hermes"]) {
      await set({ binary: b });
      await expectRefused(a.execute(ctxFor("ok", "Apolline M", [])), /assignments\.json invalide : hermes\.binary doit être un chemin absolu/);
    }
    await expect(setHermesBinary({ binary: "bash" })).rejects.toThrow(/non absolu/);
    // shell système (et propriétaire root)
    await set({ binary: "/bin/bash" });
    await expectRefused(a.execute(ctxFor("ok", "Apolline M", [])), /binaire Hermes \/(usr\/)?bin\/bash : propriétaire uid 0/);
    // lien vers un AUTRE binaire (un second faux) sans cible notée → refus ; cible notée ≠ → refus ; notée = → passe
    const other = await makeFakeHermes(join(root, "autre"), "pas-hermes");
    const link = join(hb, "hermes-lien");
    await symlink(other, link);
    await set({ binary: link });
    await expectRefused(a.execute(ctxFor("ok", "Apolline M", [])), /lien symbolique vers .*pas-hermes.*refusé tant que sa cible n'est pas notée/);
    await set({ binary: link, linkTarget: fake });
    await expectRefused(a.execute(ctxFor("ok", "Apolline M", [])), /lien vers .*pas-hermes, différent de la cible notée/);
    expect(calls).toEqual([]);
    await set({ binary: link, linkTarget: other });
    await a.execute(ctxFor("ok", "Apolline M", []));
    expect(calls[0]!["hermesCommand"]).toBe(link); // la cible est notée et autorisée explicitement
    // modifiable par le groupe → refus
    const loose = join(hb, "hermes-lache");
    await copyFile(fake, loose);
    await chmod(loose, 0o775);
    await set({ binary: loose });
    await expectRefused(a.execute(ctxFor("ok", "Apolline M", [])), /modifiable par le groupe ou les autres/);
    // empreinte notée différente → refus
    await set({ binary: fake, sha256: "0".repeat(64) });
    await expectRefused(a.execute(ctxFor("ok", "Apolline M", [])), /empreinte .* ≠ empreinte notée/);
    // aucun binaire administré → refus
    await set(undefined as never);
    const t = JSON.parse(await readFile(assignmentsFile(), "utf8")) as Cfg;
    delete t["hermes"];
    await writeFile(assignmentsFile(), JSON.stringify(t));
    await expectRefused(a.execute(ctxFor("ok", "Apolline M", [])), /aucun binaire Hermes administré/);
    expect(calls).toHaveLength(1);
  });

  it("config.env ne peut écraser ni HERMES_HOME, ni PATH, ni PYTHON*/LD_*, ni HOME/USER/LOGNAME : retirés ici ; HERMES_HOME administré ; les autres clés vont à la liste blanche du correctif (0.6.3)", async () => {
    const { a, calls } = withSpy();
    await assignApolline();
    const logs: string[] = [];
    await a.execute(ctxFor("ok", "Apolline M", logs, { env: { HERMES_HOME: join(root, "b"), PATH: "/evil", PYTHONPATH: "/evil", LD_PRELOAD: "/evil.so", HOME: "/tmp/hostile", CUSTOM_KEY: "garde" } }));
    const env = calls[0]!["env"] as Record<string, string>;
    expect(env["HERMES_HOME"]).toBe(HOME_APOLLINE());
    expect(env).not.toHaveProperty("PATH");
    expect(env).not.toHaveProperty("PYTHONPATH");
    expect(env).not.toHaveProperty("LD_PRELOAD");
    expect(env).not.toHaveProperty("HOME");
    expect(env["CUSTOM_KEY"]).toBe("garde"); // décidé ensuite par la liste blanche du correctif
    expect(logs.join("")).toMatch(/env de l'agent : HERMES_HOME, PATH, PYTHONPATH, LD_PRELOAD, HOME ignoré/);
    expect(logs.join("")).toMatch(/voie 1 : hermes-control-voie1\/hermes-paperclip-adapter@2026\.1001\.0\/2 ; adapter-utils chargé/);
  });

  it("extraArgs avec -p / --profile → refus (Hermes changerait de profil après le contrôle)", async () => {
    const { a, calls } = withSpy();
    await assignApolline();
    await expectRefused(a.execute(ctxFor("ok", "Apolline M", [], { extraArgs: ["--reasoning-effort", "high", "-p", "autre"] })), /extraArgs contient -p/);
    await expectRefused(a.execute(ctxFor("ok", "Apolline M", [], { extraArgs: ["--profile=autre"] })), /--profile=autre/);
    expect(calls).toEqual([]);
  });

  it("PREUVE D'EXÉCUTION (adaptateur de base OFFICIEL, vrai processus) : un faux `hermes` en tête du PATH et un hermesCommand vers un ancien lanceur ne sont JAMAIS lancés ; le binaire administré reçoit HERMES_HOME et PATH construits ici", async () => {
    await assignApolline();
    // faux hermes en tête du PATH du serveur, et ancien lanceur dans hermesCommand : chacun laisse une trace s'il est lancé
    const evil = join(root, "evil");
    await mkdir(evil, { recursive: true });
    const marker = join(root, "LANCE-A-TORT");
    await writeFile(join(evil, "hermes"), `#!/bin/sh\necho "$0" >> "${marker}"\n`);
    await chmod(join(evil, "hermes"), 0o755);
    const old = join(evil, "hermes-chef-a");
    await writeFile(old, `#!/bin/bash\necho "$0" >> "${marker}"\nexport HERMES_HOME="${join(root, "b")}"\nexec hermes "$@"\n`);
    await chmod(old, 0o755);
    const savedPath = process.env["PATH"];
    process.env["PATH"] = `${evil}:${savedPath ?? ""}`;
    try {
      const a = createServerAdapter(createHermesLocalServerAdapter()); // la vraie base : runChildProcess
      const logs: string[] = [];
      const r = (await a.execute(ctxFor("ok", "Apolline M", logs, { hermesCommand: old, cwd: root, env: { HERMES_HOME: join(root, "b"), CUSTOM_KEY: "v" }, timeoutSec: 30 }))) as Res;
      expect(r.exitCode).toBe(0);
      const calls = await fakeCalls(hb);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.exe).toBe(fake);
      expect(calls[0]!.argv[0]).toBe("chat");
      expect(calls[0]!.argv).toContain("--yolo");
      expect(calls[0]!.HERMES_HOME).toBe(HOME_APOLLINE());
      // 0.6.3 (voie 1) : PATH FIXÉ = dossier du binaire administré + chemin système ; rien du PATH du serveur
      expect(calls[0]!.PATH).toBe(`${dirname(fake)}:/usr/local/bin:/usr/bin:/bin`);
      expect(calls[0]!.PATH).not.toContain(evil);
      // HOME du compte (getpwuid), pas le HOME du processus (temporaire des tests)
      expect(calls[0]!.env["HOME"]).toBe(userInfo().homedir);
      expect(calls[0]!.env["HOME"]).not.toBe(process.env["HOME"]);
      // CUSTOM_KEY hors liste blanche : refusé (nom seulement dans le journal)
      expect(calls[0]!.env).not.toHaveProperty("CUSTOM_KEY");
      expect(logs.join("")).toMatch(/refusées depuis config\.env : .*CUSTOM_KEY \(hors liste blanche\)/);
      expect(calls[0]!.env["PAPERCLIP_AGENT_ID"]).toBe("ok");
      expect(existsSync(marker)).toBe(false); // ni le faux hermes du PATH, ni l'ancien lanceur
    } finally {
      process.env["PATH"] = savedPath;
    }
  }, 30_000);
});

describe("HERMES_HOME littéral : racines courtes, alias, profils nommé et default, sockets", () => {
  async function deepInstance() {
    const deepInst = join(root, "p".repeat(Math.max(1, 70 - root.length - 1)));
    const prof = "x".repeat(20);
    await mkdir(join(deepInst, "profiles", prof), { recursive: true });
    await writeFile(join(deepInst, "config.yaml"), "model: {}\n");
    await writeFile(join(deepInst, "profiles", prof, "config.yaml"), "model: {}\n");
    return { deepInst, prof };
  }

  it("racine longue sans racine d'exécution → refus socket AVANT tout démarrage ; racine courte (~/.h/d → même instance) → passe, HERMES_HOME transmis = chaîne courte", async () => {
    const { a, calls } = withSpy();
    const { deepInst, prof } = await deepInstance();
    await setCompanyInstances("c", "Societe C", [deepInst]);
    await assignAgent({ agentId: "deep", companyId: "c", instanceHome: deepInst, profile: prof, name: "Deep", assignedBy: "u" });
    await setHermesBinary({ binary: fake });
    await expectRefused(a.execute(ctxFor("deep", "Deep", [])), /chemin de socket trop long.*gateway\.loop-tick\.4194304\.sock.*mesuré sur HERMES_HOME transmis/);
    expect(calls).toEqual([]);
    await mkdir(join(root, ".h"));
    await symlink(deepInst, join(root, ".h", "d"));
    await setExecutionRoot(deepInst, "~/.h/d");
    const logs: string[] = [];
    await a.execute(ctxFor("deep", "Deep", logs));
    expect(calls).toHaveLength(1);
    expect((calls[0]!["env"] as Cfg)["HERMES_HOME"]).toBe(`${root}/.h/d/profiles/${prof}`); // littéral, pas le realpath
    expect(logs.join("")).toContain(`HERMES_HOME=${root}/.h/d/profiles/${prof} (= ${join(deepInst, "profiles", prof)})`);
  });

  it("alias vers une AUTRE instance (table écrite à la main) → refus ; profiles/<p> lien vers ailleurs → refus", async () => {
    const { a, calls } = withSpy();
    await assignApolline();
    const other = join(root, "autre-inst");
    await mkdir(join(other, "profiles", "apolline-m"), { recursive: true });
    await writeFile(join(other, "config.yaml"), "model: {}\n");
    await writeFile(join(other, "profiles", "apolline-m", "config.yaml"), "model: {}\n");
    await mkdir(join(root, ".h"));
    await symlink(other, join(root, ".h", "m"));
    await expect(setExecutionRoot(inst, "~/.h/m")).rejects.toThrow(/désigne .*autre-inst, pas l'instance/);
    const t = JSON.parse(await readFile(assignmentsFile(), "utf8")) as Cfg;
    t["instances"] = { [inst]: { executionRoot: "~/.h/m" } };
    await writeFile(assignmentsFile(), JSON.stringify(t));
    await expectRefused(a.execute(ctxFor("ok", "Apolline M", [])), /racine d'exécution .*\.h\/m : désigne .*autre-inst/);
    // profil dont le dossier est un lien vers le profil d'une autre instance
    delete t["instances"];
    await writeFile(assignmentsFile(), JSON.stringify(t));
    await mkdir(join(inst, "profiles", "piege"), { recursive: true });
    await rm(join(inst, "profiles", "piege"), { recursive: true });
    await symlink(join(other, "profiles", "apolline-m"), join(inst, "profiles", "piege"));
    await assignAgent({ agentId: "p", companyId: "c", instanceHome: inst, profile: "piege", name: "Piege", assignedBy: "u" });
    await expectRefused(a.execute(ctxFor("p", "Piege", [])), /HERMES_HOME .*profiles\/piege désigne .*autre-inst.*pas le profil affecté/);
    expect(calls).toEqual([]);
  });

  it("profil NOMMÉ → <racine>/profiles/<p> ; profil DEFAULT → la racine elle-même (comme profileHome) ; active_profile qui redirigerait → refus", async () => {
    const { a, calls } = withSpy();
    await assignApolline();
    await assignAgent({ agentId: "root", companyId: "c", instanceHome: inst, profile: "default", name: "CMO", assignedBy: "u" });
    await mkdir(join(root, ".h"));
    await symlink(inst, join(root, ".h", "m"));
    await setExecutionRoot(inst, "~/.h/m");
    await a.execute(ctxFor("ok", "Apolline M", []));
    await a.execute(ctxFor("root", "CMO", []));
    expect((calls[0]!["env"] as Cfg)["HERMES_HOME"]).toBe(`${root}/.h/m/profiles/apolline-m`);
    expect((calls[1]!["env"] as Cfg)["HERMES_HOME"]).toBe(`${root}/.h/m`);
    await writeFile(join(inst, "active_profile"), "apolline-m\n");
    await expectRefused(a.execute(ctxFor("root", "CMO", [])), /active_profile vaut « apolline-m »/);
    await a.execute(ctxFor("ok", "Apolline M", [])); // un profil nommé n'est pas concerné (Hermes ne lit pas active_profile)
    expect(calls).toHaveLength(3);
  });
});

describe("refus NON réessayés par Paperclip 2026.1001.0", () => {
  // Classement réel du serveur : on importe le code installé de Paperclip 2026.1001.0 s'il est présent sur la machine.
  const services = join(dirname(dirname(process.execPath)), "lib", "node_modules", "paperclipai", "node_modules", "@paperclipai", "server", "dist", "services");
  const serverPkg = join(services, "..", "..", "package.json");
  const available = existsSync(join(services, "recovery", "service.js")) && existsSync(serverPkg) && (JSON.parse(readFileSync(serverPkg, "utf8")) as { version: string }).version === "2026.1001.0";

  it("un refus est RENDU (pas levé) avec errorCode configuration_incomplete et resultJson.configurationIncomplete ; une panne inattendue est LEVÉE (réessayable)", async () => {
    const { a } = withSpy();
    const r = await expectRefused(a.execute(ctxFor("x", "Apolline M", [])), /non affecté/);
    expect(r.exitCode).toBeNull();
    expect((r.resultJson!["configurationIncomplete"] as { fingerprint: string }).fingerprint).toBe("hermes_control:not_assigned:x");
    expect(r).not.toHaveProperty("executionRecovery"); // aucune « preuve de reprise » offerte au serveur
    // une erreur temporaire de la base d'exécution (après les contrôles) n'est PAS transformée en refus
    await assignApolline();
    const real = createServerAdapter();
    const flaky = createServerAdapter({ ...real, execute: async () => { throw new Error("ECONNRESET temporaire"); } } as never);
    await expect(flaky.execute(ctxFor("ok", "Apolline M", []))).rejects.toThrow(/ECONNRESET/);
  });

  it.skipIf(!available)("classement par le code serveur installé (recovery/service.js 2026.1001.0) : refus → configuration_incomplete (ticket bloqué, aucune reprise) ; exception → adapter_failed → transient_infra (reprise)", async () => {
    const recovery = (await import(join(services, "recovery", "service.js"))) as {
      classifyAdapterFailureForRecovery: (run: unknown) => { kind: string } | null;
      classifyContinuationFailure: (run: unknown) => { kind: string };
    };
    const { a } = withSpy();
    const r = (await a.execute(ctxFor("x", "Apolline M", []))) as Res;
    // ce que heartbeat.js enregistre pour un résultat d'échec : errorCode = adapterResult.errorCode, error = errorMessage
    const refusedRun = { status: "failed", errorCode: r.errorCode, error: r.errorMessage, resultJson: r.resultJson };
    expect(recovery.classifyAdapterFailureForRecovery(refusedRun)).toEqual({ kind: "configuration_incomplete" });
    // ce que heartbeat.js enregistre pour une exception levée par execute : errorCode « adapter_failed »
    const thrownRun = { status: "failed", errorCode: "adapter_failed", error: "[hermes-control] refus", resultJson: {} };
    expect(recovery.classifyAdapterFailureForRecovery(thrownRun)).toBeNull();
    expect(recovery.classifyContinuationFailure(thrownRun).kind).toBe("transient_infra");
  }, 60_000);
});

describe("skills", () => {
  it("listSkills / syncSkills : profil inconnu → avertissement ; profil affecté → lien dans <profil canonique>/skills", async () => {
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
    expect(unknown.warnings.join(" ")).toMatch(/profil Hermes inconnu.*affecté explicitement/);
    await setCompanyInstances("c", "Societe C", [inst]);
    await assignAgent({ agentId: "ag-1", companyId: "c", instanceHome: inst, profile: "apolline-m", name: "Apolline M", assignedBy: "u" });
    const synced = await a.syncSkills!(ctx, ["paperclipai/paperclip/first-task"]);
    const ft = synced.entries.find((e) => e.runtimeName === "first-task")!;
    expect(ft.state).toBe("configured");
    expect(ft.targetPath).toBe(join(HOME_APOLLINE(), "skills", "first-task"));
    expect((await lstat(join(HOME_APOLLINE(), "skills", "first-task"))).isSymbolicLink()).toBe(true);
  });
});
