// Lot B, correction du lecteur (revue finale Codex du 08/10, « Identités et conservation des fonctions ») : un agent ne
// tourne que si l'entreprise ET l'agent sont « actif » dans la projection du pack. « absent » est préservé (alias, dossiers,
// mémoire, affectation) mais ne tourne pas ; « retire » ne tourne plus ; un statut hors liste rend la projection invalide ;
// une projection périmée (révision plus basse, même révision au contenu différent, compteurs en recul) est refusée.
// Refus vérifiés dans TOUS les chemins réels : bouton « Préparer » (action du worker), exécution et reprise (adaptateur),
// skills de l'adaptateur. Données FICTIVES ; faux Hermes ; aucun serveur, aucun modèle.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink as unlinkF, writeFile } from "node:fs/promises";
import { REFUS_MAX_OCTETS, journaliserRefus, refusJournalFile } from "../../src/refus-journal.js";
const rmF = (f: string) => rm(f, { recursive: true, force: true });
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestHarness } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import manifest from "../../src/manifest.js";
import plugin from "../../src/worker.js";
import { readAssignments, resolveAssignment, setHermesBinary } from "../../src/assignments.js";
import { identitesFile, readIdentites, resolveIdentity } from "../../src/identites.js";
import { freshnessFile } from "../../src/identites-fraicheur.js";
import { prepareByIdentity } from "../../src/prepare-identite.js";
import { amorcerPourTest, fakeCalls, makeFakeHermes, writeRoots, writeWorkspaceFile } from "../../src/testkit.js";
import { layout } from "../../src/workspace.js";
import { REFUSAL_ERROR_CODE, createServerAdapter } from "./index.js";

/* ---------- 1. les huit cas de Codex (verifier-identites.cjs), attendus du CONTRAT ---------- */

describe("cas Codex (même fixture, readIdentites + resolveIdentity) : attendus du contrat « actif seulement »", () => {
  const companyId = "11111111-1111-4111-8111-111111111111";
  const agentId = "22222222-2222-4222-8222-222222222222";
  let wsRoot: string;
  beforeEach(async () => {
    wsRoot = await mkdtemp(join(tmpdir(), "codex-identites-"));
    await mkdir(join(wsRoot, "donnees"));
  });
  const base = () => ({ schemaVersion: 2, revision: 1, envelope: { root: wsRoot, maxSocketPathBytes: 100 }, compteurs: { e: 1, i: 1, a: 1 }, companies: [{ companyId, alias: "e00001", name: "Fictive", statut: "actif" }], instances: [{ alias: "i00001", companyAlias: "e00001", section: "Direction", modelAccount: "fictif" }], agents: [{ agentId, companyAlias: "e00001", profileAlias: "a00001", name: "Agent fictif", statut: "actif", instanceAlias: "i00001" } as Record<string, unknown>] });
  async function run(modify: (p: ReturnType<typeof base>) => void): Promise<{ accepted: boolean; readError: string | null; reason: string | null }> {
    const p = base();
    modify(p);
    await writeFile(join(wsRoot, "donnees/identites.json"), JSON.stringify(p));
    const read = await readIdentites({ root: wsRoot });
    const r = read.projection ? resolveIdentity({ root: wsRoot }, read.projection, { companyId, agentId }) : null;
    return { accepted: !!r?.ok, readError: read.error, reason: r?.reason ?? null };
  }
  const cases: [string, (p: ReturnType<typeof base>) => void, boolean, RegExp | null][] = [
    ["témoin actif accepté", () => {}, true, null],
    ["agent absent refusé (préservé, ne tourne pas)", (p) => { p.agents[0]!["statut"] = "absent"; }, false, /identité inactive : agent .* absent de la dernière liste Paperclip ; préservé/],
    ["entreprise absente refusée", (p) => { p.companies[0]!.statut = "absent"; }, false, /identité inactive : entreprise 1111.* absente de la dernière liste Paperclip/],
    ["statut entreprise inconnu refusé (projection invalide)", (p) => { p.companies[0]!.statut = "invalide"; }, false, /statut "invalide" inconnu \(attendus : actif, absent, retire\)/],
    ["entreprise retirée refusée (message sur l'entreprise)", (p) => { p.companies[0]!.statut = "retire"; }, false, /identité inactive : entreprise 1111.* retirée/],
    ["agent retiré encore affecté refusé", (p) => { p.agents[0]!["statut"] = "retire"; }, false, /agent retiré .* encore affecté/],
    ["agent sans affectation refusé", (p) => { delete p.agents[0]!["instanceAlias"]; }, false, /sans affectation explicite/],
    ["agent autre entreprise refusé", (p) => { p.companies[0]!.companyId = "33333333-3333-4333-8333-333333333333"; }, false, /incohérence d'entreprise/],
  ];
  for (const [name, modify, expected, re] of cases) {
    it(name, async () => {
      const r = await run(modify);
      expect(r.accepted).toBe(expected);
      if (re) expect(r.readError ?? r.reason).toMatch(re);
    });
  }
  it("compléments : statut d'agent inconnu → projection invalide ; agent absent affecté → projection VALIDE (préservé) mais refusé ; agent retiré non affecté → refusé", async () => {
    expect((await run((p) => { p.agents[0]!["statut"] = "suspendu"; })).readError).toMatch(/agent 2222.* statut "suspendu" inconnu/);
    const absent = await run((p) => { p.agents[0]!["statut"] = "absent"; });
    expect(absent.readError).toBeNull();
    expect(absent.accepted).toBe(false);
    const retired = await run((p) => { p.agents[0]!["statut"] = "retire"; delete p.agents[0]!["instanceAlias"]; });
    expect(retired.readError).toBeNull();
    expect(retired.reason).toMatch(/identité inactive : agent .* retiré ; son alias n'est jamais réattribué/);
    expect((await run((p) => { p.companies[0]!.statut = "absent"; p.agents[0]!["statut"] = "absent"; })).reason).toMatch(/identité inactive : entreprise/);
  });
});

/* ---------- 2. tous les chemins réels ---------- */

const CA = "11111111-1111-4111-8111-111111111111";
const CB = "22222222-2222-4222-8222-222222222222";
const AG1 = "00000000-0000-4000-8000-000000000001";
const AG2 = "00000000-0000-4000-8000-000000000002";

let root: string;
let saved: string | undefined;
let fake: string;
let fakeDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ls-")); // court : T16
  saved = process.env["HOME"];
  process.env["HOME"] = root;
  fakeDir = join(root, "bin");
  fake = await makeFakeHermes(fakeDir);
});
afterEach(() => {
  if (saved) process.env["HOME"] = saved;
});

type P = { revision: number; compteurs: { e: number; i: number; a: number }; companies: Record<string, unknown>[]; agents: Record<string, unknown>[] } & Record<string, unknown>;
async function fixture(): Promise<{ ws: ReturnType<typeof layout>; p: P; write: (mod?: (p: P) => void, bump?: number) => Promise<void> }> {
  const rootDir = join(root, "Equipe");
  const ws = layout(rootDir);
  for (const i of ["i00001", "i00002"]) {
    const d = join(rootDir, "donnees", "h", i);
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "config.yaml"), "model: {}\n");
    await writeFile(join(d, ".env"), "");
  }
  const p: P = {
    schemaVersion: 2, revision: 4, majLe: "2026-10-08T07:00:00.000Z", envelope: { root: rootDir, maxSocketPathBytes: 100 }, compteurs: { e: 2, i: 2, a: 2 },
    companies: [{ companyId: CA, alias: "e00001", name: "Alpha", statut: "actif" }, { companyId: CB, alias: "e00002", name: "Beta", statut: "actif" }],
    instances: [{ alias: "i00001", companyAlias: "e00001", section: "direction", modelAccount: "compte-a" }, { alias: "i00002", companyAlias: "e00002", section: "direction", modelAccount: "compte-b" }],
    agents: [
      { agentId: AG1, companyAlias: "e00001", profileAlias: "a00001", name: "Chef", statut: "actif", instanceAlias: "i00001", affecteLe: "2026-10-08T07:00:00.000Z", affectePar: "cli:test" },
      { agentId: AG2, companyAlias: "e00002", profileAlias: "a00002", name: "Chef", statut: "actif", instanceAlias: "i00002", affecteLe: "2026-10-08T07:00:00.000Z", affectePar: "cli:test" },
    ],
  };
  const write = async (mod?: (p: P) => void, bump = 1) => {
    mod?.(p);
    p.revision += bump; // le pack fait avancer la révision à chaque écriture
    await writeFile(identitesFile(ws), JSON.stringify(p, null, 2));
  };
  await write(undefined, 0);
  await amorcerPourTest(rootDir); // amorçage explicite (fraîcheur B : jamais implicite)
  await writeWorkspaceFile(rootDir);
  await writeRoots();
  await setHermesBinary({ binary: fake });
  return { ws, p, write };
}

async function startWorker() {
  const h = createTestHarness({ manifest: manifest as unknown as PaperclipPluginManifestV1, config: {} });
  await plugin.definition.setup(h.ctx);
  h.seed({ companies: [{ id: CA, name: "Alpha" } as never, { id: CB, name: "Beta" } as never], agents: [AG1, AG2].map((id, k) => ({ id, companyId: k ? CB : CA, name: "Chef", adapterType: "hermes_local", adapterConfig: {}, status: "idle" }) as never) });
  return h;
}
const inCo = (companyId: string) => ({ actor: { type: "user" as const, userId: "u-" + companyId, companyId } });

type Cfg = Record<string, unknown>;
function spyAdapter() {
  const calls: Cfg[] = [];
  const real = createServerAdapter();
  const base = { ...real, execute: async (ctx: { config?: Cfg }) => { calls.push(ctx.config ?? {}); return { exitCode: 0, signal: null, timedOut: false } as never; } } as unknown as Parameters<typeof createServerAdapter>[0];
  return { a: createServerAdapter(base), calls };
}
const runCtx = (logs: string[], session: string | null = null, config: Cfg = {}) => ({ runId: "r", agent: { id: AG1, companyId: CA, name: "Chef", adapterType: "hermes_local", adapterConfig: {} }, runtime: { sessionId: session, sessionParams: session ? { sessionId: session } : null, sessionDisplayId: session, taskKey: session ? "t-1" : null }, config, context: {}, onLog: async (_s: string, t: string) => { logs.push(t); } }) as never;
type Res = { errorCode?: string; errorMessage?: string; resultJson?: Record<string, unknown> };

async function skillsCtx() {
  const src = join(root, "paperclip-src", "first-task");
  await mkdir(src, { recursive: true });
  await writeFile(join(src, "SKILL.md"), "---\nname: first-task\ndescription: d\n---\n");
  const config = { paperclipRuntimeSkills: [{ key: "paperclipai/paperclip/first-task", runtimeName: "first-task", source: src }], paperclipSkillSync: { desiredSkills: [{ key: "paperclipai/paperclip/first-task", versionId: null }] } };
  return { agentId: AG1, companyId: CA, adapterType: "hermes_local", config };
}

/** Empreinte d'un dossier (chemins, tailles, mtimes) : pour prouver que l'agent est préservé, rien n'a bougé. */
async function tree(dir: string): Promise<string> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const st = await lstat(p);
    out.push(`${p}:${st.size}:${st.mtimeMs}`);
    if (e.isDirectory()) out.push(await tree(p));
  }
  return out.sort().join("\n");
}

const scenarios: { name: string; mod: (p: P) => void; re: RegExp; kind: string; reactivable: boolean }[] = [
  { name: "agent absent", mod: (p) => { p.agents[0]!["statut"] = "absent"; }, re: /identité inactive : agent 0+-0000-4000-8000-000000000001 \(a00001\) absent de la dernière liste Paperclip ; préservé/, kind: "inactive", reactivable: true },
  { name: "entreprise absente", mod: (p) => { p.companies[0]!["statut"] = "absent"; }, re: /identité inactive : entreprise 1111.* \(e00001\) absente de la dernière liste Paperclip/, kind: "inactive", reactivable: true },
  { name: "entreprise retirée", mod: (p) => { p.companies[0]!["statut"] = "retire"; }, re: /identité inactive : entreprise 1111.* \(e00001\) retirée/, kind: "inactive", reactivable: false },
  { name: "agent retiré (désaffecté par le pack)", mod: (p) => { p.agents[0]!["statut"] = "retire"; delete p.agents[0]!["instanceAlias"]; }, re: /identité inactive : agent .* \(a00001\) retiré ; son alias n'est jamais réattribué/, kind: "inactive", reactivable: false },
  { name: "statut d'agent inconnu", mod: (p) => { p.agents[0]!["statut"] = "suspendu"; }, re: /projection .* invalide : agent 0+-0000-4000-8000-000000000001 : statut "suspendu" inconnu/, kind: "assignment", reactivable: false },
  { name: "statut d'entreprise inconnu", mod: (p) => { p.companies[0]!["statut"] = "pause"; }, re: /projection .* invalide : entreprise 1111.* : statut "pause" inconnu/, kind: "assignment", reactivable: false },
];

describe("refus dans tous les chemins réels : préparer, exécuter, reprise, skills de l'adaptateur", () => {
  for (const s of scenarios) {
    it(`${s.name} : préservé, rien ne tourne, refus non réessayé${s.reactivable ? " ; réactivé par le pack → tourne à nouveau, même alias et même dossier" : ""}`, async () => {
      const { ws, write } = await fixture();
      const h = await startWorker();
      const { a, calls } = spyAdapter();
      // témoin positif : actif → le bouton « Préparer » prépare, l'exécution passe sur le profil d'alias
      const prepared = await h.performAction<{ created: string[] }>("prepare-agent", { agentId: AG1 }, inCo(CA));
      expect(prepared.created.length).toBeGreaterThan(0);
      const agentDir = join(ws.root, "donnees/e/e00001/a/a00001");
      const profile = join(ws.root, "donnees/h/i00001/profiles/a00001");
      await a.execute(runCtx([]));
      expect(calls).toHaveLength(1);
      expect((calls[0]!["env"] as Cfg)["HERMES_HOME"]).toBe(profile);
      const clones = (await fakeCalls(fakeDir)).length;
      const before = await tree(join(ws.root, "donnees", "e")) + (await tree(join(ws.root, "donnees", "h")));

      await write(s.mod);

      // 1. bouton « Préparer » (action du worker) : refus, rien n'est créé, Hermes n'est pas appelé
      await expect(h.performAction("prepare-agent", { agentId: AG1 }, inCo(CA))).rejects.toThrow(s.re);
      await expect(prepareByIdentity({ ws, companyId: CA, agentId: AG1, binaryFor: async () => fake })).rejects.toThrow(s.re);
      // 2. exécuter : refus RENDU (configuration_incomplete → Paperclip ne le réessaie pas), Hermes jamais lancé
      const logs: string[] = [];
      const r = (await a.execute(runCtx(logs))) as Res;
      expect(r.errorCode).toBe(REFUSAL_ERROR_CODE);
      expect(r.errorMessage).toMatch(s.re);
      expect(r.errorMessage).toMatch(/Hermes n'est pas lancé/);
      expect((r.resultJson?.["configurationIncomplete"] as { reason: string; fingerprint: string }).reason).toBe(`hermes_control_${s.kind}`);
      expect(logs.join("")).toMatch(s.re);
      // 3. reprise d'une session existante (runtime.sessionId) puis nouvelle tentative : même refus, même empreinte
      const resumed = (await a.execute(runCtx([], "sess-fictive-1"))) as Res;
      const again = (await a.execute(runCtx([], "sess-fictive-1"))) as Res;
      for (const x of [resumed, again]) {
        expect(x.errorCode).toBe(REFUSAL_ERROR_CODE);
        expect(x.errorMessage).toMatch(s.re);
      }
      expect((again.resultJson?.["configurationIncomplete"] as { fingerprint: string }).fingerprint).toBe(`hermes_control:${s.kind}:${AG1}`);
      expect(calls).toHaveLength(1); // aucun passage depuis le changement de statut
      // 4. skills de l'adaptateur : aucun lien posé dans le profil
      const sk = await skillsCtx();
      const synced = await a.syncSkills!(sk, ["paperclipai/paperclip/first-task"]);
      const listed = await a.listSkills!(sk);
      if (s.kind === "inactive") {
        expect(synced.warnings.join(" ")).toMatch(s.re);
        expect(listed.warnings.join(" ")).toMatch(s.re);
      }
      await expect(lstat(join(profile, "skills", "first-task"))).rejects.toThrow();
      // préservé : dossiers, profil et mémoire intacts ; aucun appel à Hermes
      expect(await tree(join(ws.root, "donnees", "e")) + (await tree(join(ws.root, "donnees", "h")))).toBe(before);
      expect((await fakeCalls(fakeDir)).length).toBe(clones);
      if (s.kind === "inactive") {
        // la vue de la page Hermes garde l'agent (préservé) avec la raison du refus
        expect((await readAssignments()).inactive?.[AG1]?.reason).toMatch(s.re);
      }
      // statut inactif : l'autre entreprise n'est pas touchée ; statut hors liste : la projection ENTIÈRE est invalide (tout refusé)
      if (s.kind === "inactive") expect((await resolveAssignment(AG2, { companyId: CB })).ok?.profile).toBe("a00002");
      else expect((await resolveAssignment(AG2, { companyId: CB })).reason).toMatch(s.re);

      if (s.reactivable) {
        await write((p) => { p.agents[0]!["statut"] = "actif"; p.companies[0]!["statut"] = "actif"; });
        await a.execute(runCtx([]));
        expect(calls).toHaveLength(2);
        expect((calls[1]!["env"] as Cfg)["HERMES_HOME"]).toBe(profile);
        const re = await prepareByIdentity({ ws, companyId: CA, agentId: AG1, binaryFor: async () => fake });
        expect(re.agentDir).toBe(agentDir);
        expect(re.profile).toBe("a00001");
        expect(await readdir(join(ws.root, "donnees/e/e00001/a"))).toEqual(["a00001"]);
      }
    });
  }

  it("agent absent JAMAIS préparé : refus avant toute création (ni profil, ni dossier, ni appel Hermes)", async () => {
    const { ws, write } = await fixture();
    await write((p) => { p.agents[0]!["statut"] = "absent"; });
    const h = await startWorker();
    await expect(h.performAction("prepare-agent", { agentId: AG1 }, inCo(CA))).rejects.toThrow(/identité inactive : agent .* absent/);
    await expect(lstat(join(ws.root, "donnees", "e"))).rejects.toThrow();
    await expect(lstat(join(ws.root, "donnees/h/i00001/profiles"))).rejects.toThrow();
    expect(await fakeCalls(fakeDir)).toEqual([]);
  });

  it("entreprise d'un autre contexte : un agent inactif de B demandé depuis A → refus d'entreprise, pas de fuite du statut", async () => {
    await (await fixture()).write((p) => { p.agents[1]!["statut"] = "absent"; });
    const r = await resolveAssignment(AG2, { companyId: CA });
    expect(r.reason).toMatch(/enregistrée pour l'entreprise 2222.*, pas pour 1111/);
  });
});

/* ---------- 3. projection périmée ---------- */

describe("projection périmée : refusée dans les chemins qui font tourner un agent", () => {
  async function prepared() {
    const f = await fixture();
    const { a, calls } = spyAdapter();
    await prepareByIdentity({ ws: f.ws, companyId: CA, agentId: AG1, binaryFor: async () => fake });
    await a.execute(runCtx([]));
    expect(calls).toHaveLength(1);
    return { ...f, a, calls };
  }
  async function expectAllRefused(f: Awaited<ReturnType<typeof prepared>>, re: RegExp, runs = 1) {
    await expect(prepareByIdentity({ ws: f.ws, companyId: CA, agentId: AG1, binaryFor: async () => fake })).rejects.toThrow(re);
    const h = await startWorker();
    await expect(h.performAction("prepare-agent", { agentId: AG1 }, inCo(CA))).rejects.toThrow(re);
    for (const session of [null, "sess-fictive-1"]) {
      const r = (await f.a.execute(runCtx([], session))) as Res;
      expect(r.errorCode).toBe(REFUSAL_ERROR_CODE);
      expect(r.errorMessage).toMatch(re);
    }
    expect(f.calls).toHaveLength(runs);
  }

  it("révision plus basse que celle déjà lue (copie ancienne) → refus ; le pack réécrit une révision supérieure → accepté", async () => {
    const f = await prepared();
    await f.write(undefined, -2); // r4 → r2
    await expectAllRefused(f, /projection périmée : révision r2 < r4 déjà lue/);
    await f.write(undefined, 3); // r5
    await f.a.execute(runCtx([]));
    expect(f.calls).toHaveLength(2);
    expect(JSON.parse(await readFile(freshnessFile(), "utf8")).enveloppes[f.ws.root].revision).toBe(5);
  });

  it("même révision, contenu différent (écriture hors du pack) → refus", async () => {
    const f = await prepared();
    await f.write((p) => { p.agents[0]!["name"] = "Chef modifié à la main"; }, 0);
    await expectAllRefused(f, /projection périmée : révision r4 déjà lue avec un autre contenu/);
  });

  it("compteur d'alias en recul (un alias pourrait être réattribué) → refus", async () => {
    const f = await prepared();
    await f.write((p) => { p.compteurs.a = 5; });
    await f.a.execute(runCtx([]));
    expect(f.calls).toHaveLength(2);
    await f.write((p) => { p.compteurs.a = 2; });
    await expectAllRefused(f, /projection périmée : compteur\(s\) d'alias en recul \(a 2 < 5\)/, 2);
  });

  it("l'état de fraîcheur est dans le dossier de Hermes Control, jamais dans la projection (que HC n'écrit pas)", async () => {
    const f = await prepared();
    const st = await stat(identitesFile(f.ws));
    await f.a.execute(runCtx([]));
    expect((await stat(identitesFile(f.ws))).mtimeMs).toBe(st.mtimeMs);
    expect(freshnessFile().startsWith(join(root, ".config", "hermes-control"))).toBe(true);
  });
});

/* ---------- 4. contrat versionné identite_inactive (fraîcheur B) ---------- */

describe("contrat identite_inactive (schéma 1) dans resultJson : cause structurée, champs Paperclip inchangés", () => {
  type Id = { schema: number; code: string; cause: string; regle: string | null; agentId: string | null; companyId: string | null; empreinte: string | null; revision: number | null };
  async function refused(agentId = AG1) {
    const { a } = spyAdapter();
    const logs: string[] = [];
    const ctx = runCtx(logs) as unknown as { agent: { id: string } };
    ctx.agent.id = agentId;
    const r = (await a.execute(ctx as never)) as Res;
    expect(r.errorCode).toBe(REFUSAL_ERROR_CODE);
    const ci = r.resultJson?.["configurationIncomplete"] as { reason: string; fingerprint: string; missingBindings: unknown[]; message: string; identite?: Id };
    const hc = r.resultJson?.["hermesControl"] as { refused: boolean; kind: string; identite?: Id };
    expect(ci.missingBindings).toEqual([]);
    expect(ci.message).toBe(r.errorMessage);
    expect(hc.identite).toEqual(ci.identite);
    return { ci, hc, logs };
  }
  const statuts: [string, (p: P) => void, string][] = [
    ["agent absent", (p) => { p.agents[0]!["statut"] = "absent"; }, "agent_absent"],
    ["agent retiré", (p) => { p.agents[0]!["statut"] = "retire"; delete p.agents[0]!["instanceAlias"]; }, "agent_retire"],
    ["entreprise absente", (p) => { p.companies[0]!["statut"] = "absent"; }, "entreprise_absente"],
    ["entreprise retirée", (p) => { p.companies[0]!["statut"] = "retire"; }, "entreprise_retiree"],
  ];
  for (const [name, mod, cause] of statuts) {
    it(`${name} → cause ${cause} ; reason/fingerprint d'avant (hermes_control_inactive)`, async () => {
      const f = await fixture();
      await f.write(mod);
      const { ci } = await refused();
      expect(ci.reason).toBe("hermes_control_inactive");
      expect(ci.fingerprint).toBe(`hermes_control:inactive:${AG1}`);
      expect(ci.identite).toMatchObject({ schema: 1, code: "identite_inactive", cause, regle: null, agentId: AG1, companyId: CA, revision: 5 });
      expect(ci.identite!.empreinte).toMatch(/^[0-9a-f]{64}$/);
    });
  }
  it("projection périmée ≠ agent retiré : cause projection_perimee (regle revision_inferieure), type de refus inchangé (assignment)", async () => {
    const f = await fixture();
    await f.write(undefined, 3); // r7 lue
    expect((await resolveAssignment(AG1, { companyId: CA })).ok).toBeTruthy();
    await f.write(undefined, -2); // r5
    const { ci } = await refused();
    expect(ci.reason).toBe("hermes_control_assignment");
    expect(ci.identite).toMatchObject({ cause: "projection_perimee", regle: "revision_inferieure", agentId: AG1, companyId: CA, revision: 5 });
  });
  it("état de suivi supprimé après usage → etat_suivi_invalide ; projection invalide → projection_invalide ; jamais amorcée → suivi_non_amorce", async () => {
    const f = await fixture();
    await unlinkF(freshnessFile());
    expect((await refused()).ci.identite).toMatchObject({ cause: "etat_suivi_invalide", regle: "suivi_absent_apres_usage" });
    await unlinkF(join(f.ws.root, "donnees", ".hermes-control-suivi.json"));
    expect((await refused()).ci.identite).toMatchObject({ cause: "suivi_non_amorce", regle: "jamais_amorce" });
    await f.write((p) => { p.agents[0]!["statut"] = "suspendu"; });
    expect((await refused()).ci.identite).toMatchObject({ cause: "projection_invalide", regle: "schema", empreinte: null });
  });
  it("agent sans entrée dans la projection → cause absente, type de refus inchangé (not_assigned)", async () => {
    await fixture();
    const other = "00000000-0000-4000-8000-000000000009";
    const { ci } = await refused(other);
    expect(ci.reason).toBe("hermes_control_not_assigned");
    expect(ci.identite).toMatchObject({ cause: "absente", agentId: other, companyId: CA });
  });
  it("refus.jsonl : ligne structurée ; journal impossible (disque plein simulé) → le refus est rendu quand même ; rotation bornée ; délai borné", async () => {
    const f = await fixture();
    await f.write((p) => { p.agents[0]!["statut"] = "absent"; });
    await refused();
    const line = JSON.parse((await readFile(refusJournalFile(), "utf8")).trim().split("\n").pop()!);
    expect(line).toMatchObject({ agentId: AG1, kind: "inactive", identite: { cause: "agent_absent" } });
    await rmF(refusJournalFile());
    await mkdir(refusJournalFile()); // appendFile → EISDIR, comme un disque plein
    const { logs } = await refused();
    expect(logs.join("")).toMatch(/journal des refus non écrit \(EISDIR\) ; le refus est rendu quand même/);
    await rmF(refusJournalFile());
    for (let k = 0; k < 40; k++) await journaliserRefus({ message: "x".repeat(7000) });
    expect((await stat(`${refusJournalFile()}.1`)).size).toBeGreaterThan(0);
    expect((await stat(refusJournalFile())).size).toBeLessThanOrEqual(REFUS_MAX_OCTETS);
    const t0 = Date.now();
    expect(await journaliserRefus({}, () => new Promise(() => {}))).toMatchObject({ ok: false });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
