import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignAgent, assignmentsFile, setCompanyInstances } from "../../src/assignments.js";
import { agentsMapFile } from "../../src/agents-map.js";
import { preparingFile } from "../../src/prepare.js";
import { createServerAdapter } from "./index.js";

let root: string;
let inst: string;
let savedHome: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hc-adapter-"));
  // Isoler le test de la machine : pas de ~/.hermes ni de ~/.config/hermes-control/roots réels.
  savedHome = process.env["HOME"];
  process.env["HOME"] = root;
  inst = join(root, "marketing");
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

const HOME_APOLLINE = () => join(root, "marketing", "profiles", "apolline-m");
async function assignApolline(companyId = "c") {
  await setCompanyInstances(companyId, "Societe C", [inst]);
  await assignAgent({ agentId: "ok", companyId, instanceHome: inst, profile: "apolline-m", name: "Apolline M", assignedBy: "user:u1" });
}

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
  const ctxFor = (id: string, name: string, logs: string[], config: Record<string, unknown> = {}, companyId: string | null = "c") => ({ runId: "r", agent: { id, companyId, name, adapterType: "hermes_local", adapterConfig: {} }, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null }, config, onLog: async (_s: string, t: string) => { logs.push(t); } }) as never;

  it("R02b : un agent sans affectation explicite refuse de tourner (base.execute jamais appelé), même si un profil porte son nom", async () => {
    const { a, calls } = withSpy();
    const logs: string[] = [];
    await expect(a.execute(ctxFor("x", "Apolline M", logs))).rejects.toThrow(/non affecté.*aucune affectation explicite/);
    expect(calls).toEqual([]);
    expect(logs.join("")).toContain("assignments.json");
    // une projection agents.json ANCIENNE (format plat 0.6.0, produite par le nom) ne vaut pas affectation
    await mkdir(join(root, ".config", "hermes-control"), { recursive: true });
    await writeFile(agentsMapFile(), JSON.stringify({ x: { name: "Apolline M", instance: "marketing", profile: "apolline-m", home: HOME_APOLLINE(), at: "t" } }));
    await expect(a.execute(ctxFor("x", "Apolline M", []))).rejects.toThrow(/non affecté.*projection ancienne/);
    expect(calls).toEqual([]);
  });

  it("affecté et présent → HERMES_HOME du profil affecté ; affecté mais le profil n'a pas de config.yaml → refus", async () => {
    const { a, calls } = withSpy();
    await setCompanyInstances("c", "Societe C", [inst]);
    await assignAgent({ agentId: "gone", companyId: "c", instanceHome: inst, profile: "parti", name: "Parti", assignedBy: "u" });
    await expect(a.execute(ctxFor("gone", "Parti", []))).rejects.toThrow(/config.yaml n'existe pas.*à préparer/);
    expect(calls).toEqual([]);
    await assignAgent({ agentId: "ok", companyId: "c", instanceHome: inst, profile: "apolline-m", name: "Apolline M", assignedBy: "user:u1" });
    const logs: string[] = [];
    await a.execute(ctxFor("ok", "Apolline M", logs));
    expect(calls).toHaveLength(1);
    expect((calls[0]!["env"] as Record<string, string>)["HERMES_HOME"]).toBe(HOME_APOLLINE());
    expect(logs.join("")).toMatch(/affectation explicite, table, par user:u1/);
  });

  it("l'affectation est contrôlée pour l'ENTREPRISE de l'agent (ctx.agent.companyId) : autre entreprise → refus, même « connecté »", async () => {
    const { a, calls } = withSpy();
    await assignApolline("c");
    await expect(a.execute(ctxFor("ok", "Apolline M", [], {}, "autre"))).rejects.toThrow(/pour l'entreprise c, pas pour autre/);
    expect(calls).toEqual([]);
    await a.execute(ctxFor("ok", "Apolline M", [], {}, null)); // sans companyId dans le contexte : la table fait foi
    expect(calls).toHaveLength(1);
  });

  it("instance plus autorisée pour l'entreprise (table éditée) → refus ; profil revendiqué par deux agents → refus", async () => {
    const { a, calls } = withSpy();
    await assignApolline();
    const t = JSON.parse(await readFile(assignmentsFile(), "utf8")) as { companies: Record<string, { instances: string[] }>; agents: Record<string, unknown> };
    t.companies["c"]!.instances = [];
    await writeFile(assignmentsFile(), JSON.stringify(t));
    await expect(a.execute(ctxFor("ok", "Apolline M", []))).rejects.toThrow(/affectation invalide.*non autorisée pour l'entreprise/);
    t.companies["c"]!.instances = [inst];
    t.agents["dup"] = { companyId: "c", instanceHome: inst, profile: "apolline-m", name: "Doublon", assignedAt: "t", assignedBy: "m" };
    await writeFile(assignmentsFile(), JSON.stringify(t));
    await expect(a.execute(ctxFor("ok", "Apolline M", []))).rejects.toThrow(/revendiqué par 2 agents/);
    expect(calls).toEqual([]);
  });

  it("NON-RÉGRESSION (sonde Codex n°2) : lanceur-script au HERMES_HOME non résolu → REFUS (jamais transmis à execute)", async () => {
    const { a, calls } = withSpy();
    await assignApolline();
    const launcher = join(root, "launcher");
    await writeFile(launcher, '#!/bin/sh\nexport HERMES_HOME="$UNKNOWN_REVIEW_ROOT/ailleurs"\nexec hermes "$@"\n'); // pas exécutable : jamais lancé
    const logs: string[] = [];
    await expect(a.execute(ctxFor("ok", "Apolline M", logs, { hermesCommand: launcher, cwd: root }))).rejects.toThrow(/lanceur incertain, refus.*non résolu/);
    expect(calls).toEqual([]);
    expect(logs.join("")).toMatch(/approvedBinaries/);
  });

  it("NON-RÉGRESSION (sonde Codex n°3) : lanceur-script avec un second export HERMES_HOME divergent → REFUS (pas de « premier export »)", async () => {
    const { a, calls } = withSpy();
    await assignApolline();
    const launcher = join(root, "launcher");
    await writeFile(launcher, `#!/bin/sh\nexport HERMES_HOME="${HOME_APOLLINE()}"\nexport HERMES_HOME="${join(root, "autre-profil")}"\nexec hermes "$@"\n`);
    await expect(a.execute(ctxFor("ok", "Apolline M", [], { hermesCommand: launcher, cwd: root }))).rejects.toThrow(/plusieurs HERMES_HOME \(lignes 2, 3\)/);
    expect(calls).toEqual([]);
  });

  it("lanceur-script dont le HERMES_HOME diffère de l'affectation → refus ; identique → passe ; conforme à la forme réelle de ProjetC → passe", async () => {
    const { a, calls } = withSpy();
    await assignApolline();
    const bad = join(root, "hermes-bad");
    await writeFile(bad, `#!/bin/bash\nexport HERMES_HOME="${inst}"\nexec hermes "$@"\n`);
    await expect(a.execute(ctxFor("ok", "Apolline M", [], { hermesCommand: bad }))).rejects.toThrow(/affectation \(table\) ≠ lanceur/);
    expect(calls).toEqual([]);
    const good = join(root, "hermes-good");
    await writeFile(good, `#!/bin/bash\nexport HERMES_HOME="${HOME_APOLLINE()}"\nexec hermes "$@"\n`);
    await a.execute(ctxFor("ok", "Apolline M", [], { hermesCommand: good }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!["hermesCommand"]).toBe(good);
    // forme réelle de ~/Projects/ProjetC/hermes/bin/hermes-cmo (relue le 06/10/2026) : PROJETC = <lanceur>/../.., HERMES_HOME = l'instance marketing (profil default)
    const short = await mkdtemp(join(tmpdir(), "h-")); // racine courte : la copie du chemin réel de ProjetC dépasserait 100 octets de socket
    const projetc = join(short, "ProjetC");
    await mkdir(join(projetc, "hermes", "bin"), { recursive: true });
    await mkdir(join(projetc, "hermes", "profils", "marketing"), { recursive: true });
    await writeFile(join(projetc, "hermes", "profils", "marketing", "config.yaml"), "model: {}\n");
    const real = join(projetc, "hermes", "bin", "hermes-cmo");
    await writeFile(real, `#!/bin/bash
# Lanceur de l'agent « cmo » : profil Hermes cmo de l'instance « marketing ». Utilisé par Paperclip (champ hermesCommand).
# Le projet est déduit de l'emplacement du script (PROJETC peut être forcé par l'environnement).
PROJETC="\${PROJETC:-$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)}"
export PROJETC
export HERMES_HOME="$PROJETC/hermes/profils/marketing"
export HERMES_WRITE_SAFE_ROOT="$PROJETC/agents/cmo:$PROJETC/agents/apolline-m/contenus/brouillons:$PROJETC/agents/creation_contenus:$HOME/Work/site/atelier/test"
# 06/10/2026 : Hermes 0.21.5 (tag v2026.9.24, installé à part) ; repli sur la 0.19 de ~/.local/bin si absent. Forçable : HERMES_BIN=/chemin/vers/hermes
HERMES_BIN="\${HERMES_BIN:-$HOME/.local/share/hermes-0.21/bin/hermes}"
[ -x "$HERMES_BIN" ] || HERMES_BIN="$HOME/.local/bin/hermes"
exec "$HERMES_BIN" "$@"
`, { mode: 0o644 });
    process.env["HERMES_CONTROL_ROOTS"] = `${root}:${join(projetc, "hermes", "profils")}`;
    await setCompanyInstances("c", "Societe C", [inst, join(projetc, "hermes", "profils", "marketing")]);
    await assignAgent({ agentId: "real", companyId: "c", instanceHome: join(projetc, "hermes", "profils", "marketing"), profile: "default", name: "CMO", assignedBy: "u" });
    await a.execute(ctxFor("real", "CMO", [], { hermesCommand: real }));
    expect(calls).toHaveLength(2);
    expect(calls[1]!["hermesCommand"]).toBe(real);
    expect((calls[1]!["env"] as Record<string, string>)["HERMES_HOME"]).toBe(join(projetc, "hermes", "profils", "marketing"));
  });

  it("binaire Hermes APPROUVÉ (HERMES_CONTROL_HERMES_BIN, approvedBinaries de la table, ou nom nu) : accepté sans lecture de script ; pris pour hermesCommand par défaut", async () => {
    const { a, calls } = withSpy();
    await assignApolline();
    const bin = join(root, "mon-hermes");
    await writeFile(bin, "\0ELF binaire\n"); // illisible comme script : seul le statut « approuvé » le laisse passer
    // 1. un chemin de binaire NON approuvé est traité comme un script → refus (incertain)
    await expect(a.execute(ctxFor("ok", "Apolline M", [], { hermesCommand: bin }))).rejects.toThrow(/lanceur incertain.*binaire/);
    // 2. approuvé par HERMES_CONTROL_HERMES_BIN
    process.env["HERMES_CONTROL_HERMES_BIN"] = bin;
    try {
      await a.execute(ctxFor("ok", "Apolline M", [], { hermesCommand: bin }));
      await a.execute(ctxFor("ok", "Apolline M", [])); // sans hermesCommand : le binaire explicite est pris
    } finally {
      delete process.env["HERMES_CONTROL_HERMES_BIN"];
    }
    expect(calls).toHaveLength(2);
    expect(calls[1]!["hermesCommand"]).toBe(bin);
    // 3. approuvé par la table
    const t = JSON.parse(await readFile(assignmentsFile(), "utf8")) as Record<string, unknown>;
    t["approvedBinaries"] = [bin];
    await writeFile(assignmentsFile(), JSON.stringify(t));
    await a.execute(ctxFor("ok", "Apolline M", [], { hermesCommand: bin }));
    // 4. nom nu (PATH de Paperclip)
    await a.execute(ctxFor("ok", "Apolline M", [], { hermesCommand: "hermes" }));
    expect(calls).toHaveLength(4);
    expect(calls[3]!["hermesCommand"]).toBe("hermes");
  });

  it("profil affecté au config.yaml invalide → refus", async () => {
    const { a, calls } = withSpy();
    const home = join(root, "marketing", "profiles", "casse");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.yaml"), "model: [oops\n");
    await setCompanyInstances("c", "Societe C", [inst]);
    await assignAgent({ agentId: "k", companyId: "c", instanceHome: inst, profile: "casse", name: "Casse", assignedBy: "u" });
    await expect(a.execute(ctxFor("k", "Casse", []))).rejects.toThrow(/config.yaml invalide/);
    expect(calls).toEqual([]);
  });

  it("préparation interrompue (preparing-*.json présent) ou profil créé par Hermes Control sans env-cleaned → refus ; nettoyé → passe", async () => {
    const { a, calls } = withSpy();
    await assignApolline();
    await mkdir(join(inst, ".hermes-control"), { recursive: true });
    await writeFile(preparingFile(inst, "apolline-m"), JSON.stringify({ startedAt: "t", pid: 4194303, stage: "cloning" }));
    await expect(a.execute(ctxFor("ok", "Apolline M", []))).rejects.toThrow(/préparation du profil « apolline-m » interrompue.*inutilisable/);
    await rm(preparingFile(inst, "apolline-m"));
    await mkdir(join(HOME_APOLLINE(), ".hermes-control"), { recursive: true });
    await writeFile(join(HOME_APOLLINE(), ".hermes-control", "prepared-by-hermes-control"), "t\n");
    await expect(a.execute(ctxFor("ok", "Apolline M", []))).rejects.toThrow(/sans \.env nettoyé/);
    expect(calls).toEqual([]);
    await writeFile(join(HOME_APOLLINE(), ".hermes-control", "env-cleaned"), "t\n");
    await a.execute(ctxFor("ok", "Apolline M", []));
    expect(calls).toHaveLength(1);
  });

  it("chemin de socket du watchdog trop long (> 100 octets) → refus AVANT tout démarrage, sans socket existant", async () => {
    const { a, calls } = withSpy();
    const deepInst = join(root, "p".repeat(Math.max(1, 70 - root.length - 1)));
    const profile = join(deepInst, "profiles", "x".repeat(20));
    await mkdir(profile, { recursive: true });
    await writeFile(join(deepInst, "config.yaml"), "model: {}\n");
    await writeFile(join(profile, "config.yaml"), "model: {}\n");
    await setCompanyInstances("c", "Societe C", [deepInst]);
    await assignAgent({ agentId: "deep", companyId: "c", instanceHome: deepInst, profile: "x".repeat(20), name: "Deep", assignedBy: "u" });
    await expect(a.execute(ctxFor("deep", "Deep", []))).rejects.toThrow(/chemin de socket trop long.*gateway\.loop-tick\.4194304\.sock.*aucun passage/);
    expect(calls).toEqual([]);
  });

  it("listSkills / syncSkills : profil inconnu → avertissement ; profil affecté → lien dans <profil>/skills", async () => {
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
