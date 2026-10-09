// Connexion d'une instance par abonnement ChatGPT (device code) : analyse de la sortie de Hermes, puis un VRAI processus
// enfant (faux `hermes` en Python, testkit) qui imite le flux jusqu'au fichier auth.json ; échec, annulation, délai, faux
// « Added » sans fichier ; action et données du worker.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestHarness } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import plugin from "./worker.js";
import { EventEmitter } from "node:events";
import { DELAI_ARRET_FORCE_MS, type Spawner, arretsEnCours, attendreFin, arreterConnexion, arreterToutesConnexions, demarrerConnexion, fichierAuthPorte, lireFin, lireInvitation, oublierSessions, sansAnsi, sessionConnexion } from "./connexion.js";
import { fakeCalls, makeFakeHermes, writeRoots } from "./testkit.js";
import { setCompanyInstances, setHermesBinary } from "./assignments.js";

const SORTIE = "Signing in to OpenAI Codex...\n(Hermes creates its own session — won't affect Codex CLI or VS Code)\n\nTo continue, follow these steps:\n\n  1. Open this URL in your browser:\n     \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n  2. Enter this code:\n     \x1b[94mWXYZ-1234\x1b[0m\n\nWaiting for sign-in... (press Ctrl+C to cancel)\n";

describe("analyse de la sortie de `hermes auth add openai-codex` (v2026.9.24, device code)", () => {
  it("URL et code lus après retrait de l'ANSI ; rien tant que l'invitation est incomplète", () => {
    expect(sansAnsi("\x1b[94mX\x1b[0m")).toBe("X");
    expect(lireInvitation(SORTIE)).toEqual({ url: "https://auth.openai.com/codex/device", code: "WXYZ-1234" });
    expect(lireInvitation(SORTIE.slice(0, SORTIE.indexOf("2. Enter")))).toBeNull();
    expect(lireInvitation("")).toBeNull();
  });
  it("fin : « Added » = succès (libellé lu), « Login failed » = échec, « Login cancelled. » = annulé", () => {
    expect(lireFin(SORTIE + 'Added openai-codex OAuth credential #1: "direction"\n')).toEqual({ etat: "reussi", label: "direction" });
    expect(lireFin(SORTIE + "Login failed: Login timed out after 15 minutes.\n")).toEqual({ etat: "echec", message: "Login failed: Login timed out after 15 minutes." });
    expect(lireFin(SORTIE + "\nLogin cancelled.\n")).toEqual({ etat: "annule", message: "Login cancelled." });
    expect(lireFin(SORTIE)).toBeNull();
  });
});

describe("processus réel : faux hermes qui imite le flux", () => {
  let home: string;
  let inst: string;
  let bin: string;
  let saved: string | undefined;
  beforeEach(async () => {
    saved = process.env["HOME"];
    home = await mkdtemp(join(tmpdir(), "hc-cx-"));
    process.env["HOME"] = home;
    inst = join(home, "h", "direction");
    await mkdir(inst, { recursive: true });
    await writeFile(join(inst, "config.yaml"), "model:\n  provider: openai-codex\n  default: gpt-5.6-luna\n");
    bin = await makeFakeHermes(join(home, "bin"));
    oublierSessions();
  });
  afterEach(() => {
    if (saved) process.env["HOME"] = saved;
  });
  const exec = () => ({ path: bin, pathPrefix: [join(home, "bin")] });
  const mode = (m: string) => writeFile(join(inst, ".fake-hermes-auth"), m);

  it("succès : invitation rendue (URL + code), auth.json écrit en 600 par Hermes, état « reussi », sortie brute oubliée, commande et HERMES_HOME exacts", async () => {
    const logs: string[] = [];
    const s = demarrerConnexion({ instanceHome: inst, exec: exec(), label: "direction", log: (m) => logs.push(m) });
    expect(s.etat).toBe("en_cours");
    const fin = await attendreFin(inst, 10_000);
    expect(fin?.etat).toBe("reussi");
    expect(fin?.url).toBe("https://auth.openai.com/codex/device");
    expect(fin?.code).toBe("ABCD-EFGH");
    expect(fin?.label).toBe("direction");
    expect(fin?.fichierOk).toBe(true);
    expect(fin?.exitCode).toBe(0);
    expect((await stat(join(inst, "auth.json"))).mode & 0o777).toBe(0o600);
    expect(await fichierAuthPorte(inst)).toBe(true);
    const calls = await fakeCalls(join(home, "bin"));
    expect(calls[0]?.argv).toEqual(["auth", "add", "openai-codex", "--type", "oauth", "--label", "direction"]);
    expect(calls[0]?.HERMES_HOME).toBe(inst);
    expect(logs.some((l) => /invitation prête/.test(l))).toBe(true);
    expect(logs.some((l) => /: reussi/.test(l))).toBe(true);
    expect(logs.join("\n")).not.toContain("ABCD-EFGH"); // le code n'est pas journalisé
    expect(logs.join("\n")).not.toContain("FAUX"); // aucun jeton
    // une seconde session est refusée tant que la première tourne ; terminée, l'état reste lisible
    expect(sessionConnexion(inst)?.etat).toBe("reussi");
  });

  it("échec de Hermes (Login failed, code 1) : état « echec » avec la ligne d'échec, pas de fichier", async () => {
    await mode("fail");
    demarrerConnexion({ instanceHome: inst, exec: exec(), label: "direction" });
    const fin = await attendreFin(inst, 10_000);
    expect(fin?.etat).toBe("echec");
    expect(fin?.message).toBe("Login failed: Login timed out after 15 minutes.");
    expect(fin?.fichierOk).toBe(false);
    expect(fin?.exitCode).toBe(1);
  });

  it("« Added » sans auth.json : refusé (faux succès), état « echec »", async () => {
    await mode("added-sans-fichier");
    demarrerConnexion({ instanceHome: inst, exec: exec(), label: "direction" });
    const fin = await attendreFin(inst, 10_000);
    expect(fin?.etat).toBe("echec");
    expect(fin?.message).toMatch(/ne porte aucun identifiant openai-codex/);
  });

  it("annulation depuis Paperclip : processus arrêté, état « annule » ; délai dépassé : état « expire »", async () => {
    await mode("hang");
    demarrerConnexion({ instanceHome: inst, exec: exec(), label: "direction" });
    await new Promise((r) => setTimeout(r, 500));
    expect(sessionConnexion(inst)?.code).toBe("ABCD-EFGH");
    expect(arreterConnexion(inst)).toBe(true);
    const fin = await attendreFin(inst, 10_000);
    expect(fin?.etat).toBe("annule");
    expect(arreterConnexion(inst)).toBe(false);
    oublierSessions();
    demarrerConnexion({ instanceHome: inst, exec: exec(), label: "direction", timeoutMs: 800 });
    const exp = await attendreFin(inst, 10_000);
    expect(exp?.etat).toBe("expire");
    expect(exp?.message).toMatch(/aucune connexion après/);
  });

  it("binaire introuvable : « echec » immédiat, message de lancement", async () => {
    demarrerConnexion({ instanceHome: inst, exec: { path: join(home, "absent"), pathPrefix: [] }, label: "x" });
    const fin = await attendreFin(inst, 5_000);
    expect(fin?.etat).toBe("echec");
    expect(fin?.message).toMatch(/lancement impossible/);
  });
});

describe("worker : action « connect-instance » et données « connexion »", () => {
  let home: string;
  let saved: string | undefined;
  beforeEach(async () => {
    saved = process.env["HOME"];
    home = await mkdtemp(join(tmpdir(), "hc-cxw-"));
    process.env["HOME"] = home;
    oublierSessions();
  });
  afterEach(() => {
    if (saved) process.env["HOME"] = saved;
  });
  const user = { actor: { type: "user" as const, userId: "u1" } };

  it("instance autorisée + binaire administré : invitation rendue, puis état « connecté » relu par `hermes auth status` ; instance d'une autre entreprise refusée ; agent refusé", async () => {
    const root = join(home, "profils");
    const inst = join(root, "direction");
    await mkdir(inst, { recursive: true });
    await writeFile(join(inst, "config.yaml"), "model:\n  provider: openai-codex\n  default: gpt-5.6-luna\n");
    await writeRoots(root);
    const bin = await makeFakeHermes(join(home, "bin"));
    await setHermesBinary({ binary: bin });
    const h = createTestHarness({ manifest: manifest as unknown as PaperclipPluginManifestV1, config: {} });
    await plugin.definition.setup(h.ctx);
    h.seed({ companies: [{ id: "A", name: "Atelier" } as never, { id: "B", name: "Autre" } as never], agents: [] });
    await setCompanyInstances("A", "Atelier", [inst]);
    const avant = await h.getData<{ authStatus: string; session: unknown; fichierOk: boolean }>("connexion", { companyId: "A", instanceHome: inst });
    expect(avant.authStatus).toBe("logged_out");
    expect(avant.session).toBeNull();
    expect(avant.fichierOk).toBe(false);
    await expect(h.performAction("connect-instance", { companyId: "B", instanceHome: inst }, user)).rejects.toThrow(/n'est pas une instance autorisée de cette entreprise/);
    await expect(h.performAction("connect-instance", { companyId: "A", instanceHome: inst }, { actor: { type: "agent", agentId: "x" } })).rejects.toThrow(/réservée à un utilisateur/);
    await expect(h.performAction("connect-instance", { companyId: "A", instanceHome: inst, provider: "openai-api" }, user)).rejects.toThrow(/seul le fournisseur openai-codex/);
    const r = await h.performAction<{ etat: string; url: string | null; code: string | null }>("connect-instance", { companyId: "A", instanceHome: inst }, user);
    expect(r.url).toBe("https://auth.openai.com/codex/device");
    expect(r.code).toBe("ABCD-EFGH");
    const fin = await attendreFin(inst, 10_000);
    expect(fin?.etat).toBe("reussi");
    const apres = await h.getData<{ authStatus: string; authLine: string | null; session: { etat: string }; fichierOk: boolean }>("connexion", { companyId: "A", instanceHome: inst });
    expect(apres.authStatus).toBe("logged_in");
    expect(apres.authLine).toBe("openai-codex: logged in");
    expect(apres.session.etat).toBe("reussi");
    expect(apres.fichierOk).toBe(true);
    expect(JSON.stringify(apres)).not.toContain("FAUX");
    // la vue « instances » relit la colonne Connexion de l'instance (profil racine)
    const vue = await h.getData<{ instances: { home: string; profiles: { name: string; authStatus: string }[] }[] }>("instances", { companyId: "A" });
    const i = vue.instances.find((x) => x.home === inst)!;
    expect(i.profiles.find((p) => p.name === "default")?.authStatus).toBe("logged_in");
    expect(await readFile(join(inst, "auth.json"), "utf8")).toContain("credential_pool");
  });
});

/** Faux enfant piloté par le test : `kill` note le signal ; `ignoreTerm` = ne se ferme que sur SIGKILL (ou jamais). */
function fauxEnfant(opts: { ignoreTerm?: boolean; fermeSur?: NodeJS.Signals[] } = {}) {
  const signaux: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), signaux,
    kill: (sig: NodeJS.Signals = "SIGTERM") => {
      signaux.push(sig);
      const ferme = opts.fermeSur ?? (opts.ignoreTerm ? ["SIGKILL"] : ["SIGTERM", "SIGKILL"]);
      if (ferme.includes(sig)) setImmediate(() => child.emit("close", null));
      return true;
    },
  });
  return child;
}

describe("tentatives : identité, fin idempotente, arrêt forcé borné, arrêt du worker (correction Codex 09/10)", () => {
  let inst: string;
  beforeEach(async () => {
    inst = await mkdtemp(join(tmpdir(), "hc-cx-race-"));
    oublierSessions();
  });
  const exec = { path: "/fixture/hermes", pathPrefix: [] as string[] };

  it("annuler puis reconnecter : la place n'est libérée qu'à la fermeture effective ; la fermeture de l'ancien enfant n'écrase pas la nouvelle tentative", async () => {
    const enfants: ReturnType<typeof fauxEnfant>[] = [];
    const spawnFn = (() => { const c = fauxEnfant({ fermeSur: [] }); enfants.push(c); return c; }) as unknown as Spawner;
    const a = demarrerConnexion({ instanceHome: inst, exec, spawnFn, timeoutMs: 60_000 });
    expect(arreterConnexion(inst)).toBe(true);
    expect(arretsEnCours()).toBe(1); // l'enfant A n'est pas encore fermé
    const b = demarrerConnexion({ instanceHome: inst, exec, spawnFn, timeoutMs: 60_000 });
    expect(b).not.toBe(a);
    expect(sessionConnexion(inst)).toBe(b);
    enfants[0]!.emit("close", null);
    await new Promise((r) => setTimeout(r, 30));
    expect(sessionConnexion(inst)).toBe(b); // B reste la courante
    expect(a.etat).toBe("annule");
    expect(a.fin).not.toBeNull(); // A est bien terminée pour qui en garde la référence
    expect(arretsEnCours()).toBe(0); // place libérée à l'arrêt effectif
    expect(b.etat).toBe("en_cours");
    enfants[1]!.emit("close", 1);
    const fin = await attendreFin(inst, 1_000);
    expect(fin).toBe(b);
    expect(b.etat).toBe("echec");
  });

  it("fin idempotente : « error » puis « close » ne terminent qu'une fois (état et fin figés)", async () => {
    let enfant!: ReturnType<typeof fauxEnfant>;
    const spawnFn = (() => (enfant = fauxEnfant({ fermeSur: [] }))) as unknown as Spawner;
    const s = demarrerConnexion({ instanceHome: inst, exec, spawnFn, timeoutMs: 60_000 });
    enfant.emit("error", new Error("ENOENT"));
    const fin = await attendreFin(inst, 1_000);
    expect(fin?.etat).toBe("echec");
    expect(fin?.message).toMatch(/lancement impossible/);
    const figee = { ...s };
    enfant.emit("close", 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(s).toEqual(figee); // close ignoré : ni exitCode, ni fin, ni message réécrits
    expect(sessionConnexion(inst)).toBe(s);
  });

  it("arrêt forcé borné : SIGTERM ignoré → SIGKILL après DELAI_ARRET_FORCE_MS ; le délai dépassé force aussi", async () => {
    vi.useFakeTimers();
    try {
      let enfant!: ReturnType<typeof fauxEnfant>;
      const spawnFn = (() => (enfant = fauxEnfant({ ignoreTerm: true }))) as unknown as Spawner;
      demarrerConnexion({ instanceHome: inst, exec, spawnFn, timeoutMs: 60_000 });
      expect(arreterConnexion(inst)).toBe(true);
      expect(enfant.signaux).toEqual(["SIGTERM"]);
      await vi.advanceTimersByTimeAsync(DELAI_ARRET_FORCE_MS - 1);
      expect(enfant.signaux).toEqual(["SIGTERM"]);
      await vi.advanceTimersByTimeAsync(2);
      expect(enfant.signaux).toEqual(["SIGTERM", "SIGKILL"]);
      await vi.advanceTimersByTimeAsync(10);
      expect(arretsEnCours()).toBe(0); // enfant fermé sur SIGKILL : place libérée
      vi.useRealTimers();
      expect((await attendreFin(inst, 1_000))?.etat).toBe("annule");
      vi.useFakeTimers();
      // délai de connexion dépassé : même chemin (SIGTERM puis SIGKILL borné), état « expire »
      oublierSessions();
      demarrerConnexion({ instanceHome: inst, exec, spawnFn, timeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_001);
      expect(enfant.signaux).toEqual(["SIGTERM"]);
      await vi.advanceTimersByTimeAsync(DELAI_ARRET_FORCE_MS + 10);
      expect(enfant.signaux).toEqual(["SIGTERM", "SIGKILL"]);
      vi.useRealTimers();
      expect((await attendreFin(inst, 1_000))?.etat).toBe("expire");
      expect(arretsEnCours()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("arrêt du worker : toutes les tentatives en cours sont annulées et attendues (fermeture effective)", async () => {
    const autre = await mkdtemp(join(tmpdir(), "hc-cx-race-"));
    const enfants: ReturnType<typeof fauxEnfant>[] = [];
    const spawnFn = (() => { const c = fauxEnfant(); enfants.push(c); return c; }) as unknown as Spawner;
    demarrerConnexion({ instanceHome: inst, exec, spawnFn, timeoutMs: 60_000 });
    demarrerConnexion({ instanceHome: autre, exec, spawnFn, timeoutMs: 60_000 });
    await arreterToutesConnexions(2_000);
    expect(enfants.map((e) => e.signaux)).toEqual([["SIGTERM"], ["SIGTERM"]]);
    expect(sessionConnexion(inst)?.etat).toBe("annule");
    expect(sessionConnexion(autre)?.etat).toBe("annule");
    expect(sessionConnexion(inst)?.message).toBe("arrêt du worker Hermes Control");
    expect(arretsEnCours()).toBe(0);
  });
});
