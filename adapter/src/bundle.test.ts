// 0.7.0 — BUNDLE AUTONOME : l'archive de l'adaptateur ne dépend plus d'aucun paquet npm à l'installation (plus de `file:`).
// Le build est rejoué ici, puis dist/ est copié SEUL (avec package.json et ui-parser.cjs) dans un dossier temporaire sans
// node_modules au-dessus : l'import doit réussir, les copies corrigées (voie 1) doivent être celles INTÉGRÉES dans le bundle
// (marqueurs présents, URL #bundle:), les ressources lues à l'exécution (skills/ de l'adaptateur officiel) présentes.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER = join(dirname(fileURLToPath(import.meta.url)), "..");

function construire(): void {
  const r = spawnSync(process.execPath, ["esbuild.config.mjs"], { cwd: ADAPTER, encoding: "utf8" });
  expect(r.status, r.stderr + r.stdout).toBe(0);
}

async function isoler(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "hc-bundle-"));
  // aucun node_modules au-dessus du dossier temporaire : la résolution ne peut rien trouver hors du bundle
  let p = d;
  while (p !== dirname(p)) {
    p = dirname(p);
    expect(existsSync(join(p, "node_modules")), `node_modules au-dessus de ${d}`).toBe(false);
  }
  const pkg = join(d, "paquet");
  await cp(join(ADAPTER, "dist"), join(pkg, "dist"), { recursive: true });
  await cp(join(ADAPTER, "package.json"), join(pkg, "package.json"));
  await cp(join(ADAPTER, "ui-parser.cjs"), join(pkg, "ui-parser.cjs"));
  return pkg;
}

/** Charge le paquet comme Paperclip (import du point d'entrée par URL de fichier), dans un processus à l'environnement vide. */
function charger(pkg: string, script: string): Record<string, unknown> {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: pkg, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: join(pkg, "home-vide") },
  });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

describe("bundle autonome de l'adaptateur (0.7.1)", () => {
  it("package.json : aucune dépendance d'installation, aucun `file:`, nom et version 0.7.1", async () => {
    const pkg = JSON.parse(await readFile(join(ADAPTER, "package.json"), "utf8"));
    expect(pkg.name).toBe("@cyberservices-ai/paperclip-adapter-hermes-control");
    expect(pkg.version).toBe("0.7.1");
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.optionalDependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
    expect(JSON.stringify(pkg.files)).not.toMatch(/paquets\/\*\.tgz/);
  });

  it("le bundle copié seul s'importe, expose l'adaptateur hermes_local et charge les copies corrigées INTÉGRÉES", { timeout: 60_000 }, async () => {
    construire();
    const pkg = await isoler();
    try {
      const out = charger(pkg, `
        import { pathToFileURL } from "node:url";
        import { readFileSync, existsSync } from "node:fs";
        const j = JSON.parse(readFileSync("package.json", "utf8"));
        const mod = await import(pathToFileURL(process.cwd() + "/" + j.exports["."]).href);
        const a = mod.createServerAdapter();
        const v = mod.voie1Status();
        const skills = process.cwd() + "/dist/vendor/hermes-paperclip-adapter/skills/paperclip-task-bridge/SKILL.md";
        console.log(JSON.stringify({ type: a.type, execute: typeof a.execute, listSkills: typeof a.listSkills, v, skills: existsSync(skills),
          uiParser: existsSync(process.cwd() + "/" + j.exports["./ui-parser"]), licences: existsSync(process.cwd() + "/dist/THIRD_PARTY_LICENSES.md") }));
      `);
      expect(out["type"]).toBe("hermes_local");
      expect(out["execute"]).toBe("function");
      expect(out["listSkills"]).toBe("function");
      const v = out["v"] as { ok: boolean; hermes: string; adapterUtils: string; adapterUtilsUrl: string };
      expect(v.ok, JSON.stringify(v)).toBe(true);
      expect(v.hermes).toMatch(/^hermes-control-voie1\/hermes-paperclip-adapter@2026\.1001\.0\//);
      expect(v.adapterUtils).toMatch(/voie1|voie 1|hermes-control/i);
      expect(v.adapterUtilsUrl).toMatch(/\/dist\/index\.js#bundle:@paperclipai\/adapter-utils@2026\.1001\.0-hc063\.1\//);
      expect(v.adapterUtilsUrl.startsWith("file://" + pkg)).toBe(true);
      expect(out["skills"]).toBe(true);
      expect(out["uiParser"]).toBe(true);
      expect(out["licences"]).toBe(true);
    } finally {
      await rm(dirname(pkg), { recursive: true, force: true });
    }
  });

  it("licences des modules intégrés : les deux copies corrigées et leurs dépendances sont listées avec leur licence", async () => {
    construire();
    const t = await readFile(join(ADAPTER, "dist", "THIRD_PARTY_LICENSES.md"), "utf8");
    for (const n of ["@paperclipai/adapter-utils@2026.1001.0-hc063.1 — MIT", "@paperclipai/hermes-paperclip-adapter@2026.1001.0-hc063.1 — MIT", "@paperclipai/shared@2026.1001.0 — MIT", "yaml@"]) {
      expect(t).toContain(n);
    }
    expect(t).toContain("Copyright (c) 2026 Nous Research");
  });
});
