// 0.7.0 — les DEUX paquets livrés sont autonomes : aucune dépendance d'exécution à tirer du registre (installation hors ligne
// possible par le pack). Échoue si une dépendance réapparaît dans un package.json livré, ou si un bundle importe un module
// qui n'est ni intégré de Node ni fourni par l'hôte Paperclip.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAQUETS = [RACINE, join(RACINE, "adapter")];
/** pairs tolérés : fournis par l'hôte, OPTIONNELS (npm ne les installe pas) */
const PAIRS_HOTE = new Set(["@paperclipai/plugin-sdk"]);
/** imports nus tolérés dans l'UI du plugin (navigateur, fournis par l'hôte Paperclip) */
const HOTE_UI = new Set(["react", "react-dom", "react/jsx-runtime", "react-dom/client", "@paperclipai/plugin-sdk/ui"]);
const NODE = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

const lire = (d: string) => JSON.parse(readFileSync(join(d, "package.json"), "utf8")) as Record<string, Record<string, unknown> | undefined>;

function fichiersJs(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? fichiersJs(p) : p.endsWith(".js") ? [p] : [];
  });
}
function importsNus(src: string): string[] {
  const r = new Set<string>();
  const nom = `["']((?:@[\\w.-]+\\/)?[\\w][\\w.:-]*(?:\\/[\\w.-]+)*)["']`;
  for (const re of [new RegExp(`(?:^|[;}\\s])(?:import|export)\\b[^;"']*?\\bfrom\\s*${nom}`, "gm"), new RegExp(`\\bimport\\s*\\(\\s*${nom}\\s*\\)`, "g"),
    new RegExp(`\\brequire\\(\\s*${nom}\\s*\\)`, "g"), new RegExp(`(?:^|;)\\s*import\\s*${nom}`, "gm")]) {
    for (const m of src.matchAll(re)) r.add(m[1]!);
  }
  return [...r];
}

describe("paquets livrés autonomes (0.7.0)", () => {
  for (const d of PAQUETS) {
    it(`${lire(d)["name"]} : ni dependencies, ni optionalDependencies, ni bundleDependencies ; pairs seulement fournis par l'hôte et optionnels`, () => {
      const j = lire(d);
      expect(j["dependencies"] ?? {}).toEqual({});
      expect(j["optionalDependencies"] ?? {}).toEqual({});
      expect(j["bundleDependencies"] ?? j["bundledDependencies"] ?? []).toEqual([]);
      const pairs = Object.keys(j["peerDependencies"] ?? {});
      for (const p of pairs) {
        expect(PAIRS_HOTE.has(p), `pair inattendu ${p}`).toBe(true);
        expect((j["peerDependenciesMeta"] as Record<string, { optional?: boolean }> | undefined)?.[p]?.optional, `pair ${p} non optionnel : npm l'installerait depuis le registre`).toBe(true);
      }
    });
  }

  it("bundles reconstruits : aucun import d'un paquet npm hors modules de Node (et hôte Paperclip pour l'UI)", { timeout: 120_000 }, () => {
    for (const d of PAQUETS) {
      const r = spawnSync(process.execPath, ["esbuild.config.mjs"], { cwd: d, encoding: "utf8" });
      expect(r.status, r.stderr + r.stdout).toBe(0);
      const js = fichiersJs(join(d, "dist")).filter((f) => !f.includes(`${join("dist", "vendor")}`));
      expect(js.length).toBeGreaterThan(0);
      for (const f of js) {
        const ui = f.includes(join("dist", "ui"));
        const interdits = importsNus(readFileSync(f, "utf8")).filter((m) => !NODE.has(m) && !(ui && HOTE_UI.has(m)));
        expect(interdits, f).toEqual([]);
      }
      const lic = readFileSync(join(d, "dist", "THIRD_PARTY_LICENSES.md"), "utf8");
      expect(lic).toMatch(/## yaml@/);
    }
  });
});
