// UNE SEULE RÉFÉRENCE pour le plugin et l'adaptateur, indépendante de l'environnement du service : on la calcule dans des
// processus séparés, avec l'environnement que Paperclip 2026.1001.0 donne au worker (plugin-worker-manager.js : PATH,
// NODE_PATH, PAPERCLIP_PLUGIN_ID, NODE_ENV, TZ — ni HOME ni variable du service) et avec celui, complet, du serveur
// (adaptateur) où HOME pointerait ailleurs : même dossier. Ces processus calculent seulement un chemin (aucune lecture du
// vrai dossier). Dans le processus de test, la référence est redirigée vers un HOME temporaire (vitest.setup.ts).
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describeReference, referenceInfo } from "./reference.js";
import { controlDir, legacyEnvRefusal } from "./paths.js";
import { sha256 } from "./assignments.js";

const run = promisify(execFile);
const paths = new URL("./paths.ts", import.meta.url).pathname;
const probe = `import(${JSON.stringify(paths)}).then((m) => { console.log(JSON.stringify({ dir: m.controlDir(), legacy: m.legacyEnvPresent() })); })`;

async function inChild(env: Record<string, string>): Promise<{ dir: string; legacy: string[] }> {
  const { stdout } = await run(process.execPath, ["--no-warnings", "--input-type=module", "-e", probe], { env });
  return JSON.parse(stdout.trim()) as { dir: string; legacy: string[] };
}

describe("référence commune plugin / adaptateur", () => {
  it("environnement FILTRÉ du worker (sans HOME) et environnement du serveur (HOME ailleurs, variables héritées) → le même dossier, celui du compte Unix (getpwuid)", async () => {
    const expected = join(userInfo().homedir, ".config", "hermes-control");
    const worker = await inChild({ PATH: process.env["PATH"] ?? "/usr/bin:/bin", NODE_PATH: "", PAPERCLIP_PLUGIN_ID: "hermes-control", NODE_ENV: "production", TZ: "UTC" });
    const server = await inChild({ PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: await mkdtemp(join(tmpdir(), "hc-autre-home-")), HERMES_CONTROL_ASSIGNMENTS: "/srv/autre/assignments.json", HERMES_CONTROL_ROOTS: "/srv/autres" });
    expect(worker.dir).toBe(expected);
    expect(server.dir).toBe(expected);
    expect(worker.legacy).toEqual([]);
    expect(server.legacy).toEqual(["HERMES_CONTROL_ASSIGNMENTS", "HERMES_CONTROL_ROOTS"]); // signalées → refus (pas de repli silencieux)
  }, 20_000);

  it("une ancienne variable posée → refus explicite qui nomme la référence ; aucune → null", () => {
    expect(legacyEnvRefusal({})).toBeNull();
    expect(legacyEnvRefusal({ HERMES_CONTROL_HERMES_BIN: "/usr/bin/hermes" })).toMatch(/HERMES_CONTROL_HERMES_BIN posée.*plus lues depuis Hermes Control 0\.6\.1.*référence unique est/);
  });

  it("diagnostic : chemin du dossier, compte, empreinte sha256 de chaque fichier (absent / présent), variables héritées", async () => {
    await mkdir(controlDir(), { recursive: true });
    await writeFile(join(controlDir(), "roots"), "/x\n");
    const r = await referenceInfo();
    expect(r.dir).toBe(controlDir());
    expect(r.files.find((f) => f.name === "roots")).toMatchObject({ exists: true, sha256: sha256("/x\n") });
    expect(r.files.find((f) => f.name === "assignments.json")).toMatchObject({ exists: false, sha256: null });
    expect(describeReference(r)).toMatch(/assignments\.json absent · roots sha256 [0-9a-f]{16}…/);
  });
});
