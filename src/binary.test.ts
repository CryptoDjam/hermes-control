// Vérification du point d'entrée Hermes administré (sans rien exécuter).
import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeBinary, strictAbsolute, verifyHermesBinary } from "./binary.js";
import { PYTHON, makeFakeHermes } from "./testkit.js";

describe("verifyHermesBinary", () => {
  it("point d'entrée de forme officielle (script Python d'un venv, shebang absolu) : accepté ; interpréteur et installation consignés", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-bin-"));
    const venv = join(root, "hermes-agent", ".venv");
    await mkdir(join(venv, "bin"), { recursive: true });
    await symlink(PYTHON, join(venv, "bin", "python"));
    await writeFile(join(venv, "pyvenv.cfg"), "home = /usr/bin\nimplementation = CPython\nversion_info = 3.14\n");
    const entry = join(venv, "bin", "hermes");
    await writeFile(entry, `#!${join(venv, "bin", "python")}\n# -*- coding: utf-8 -*-\nimport sys\nfrom hermes_cli.main import main\nsys.exit(main())\n`);
    await chmod(entry, 0o755);
    const v = await verifyHermesBinary({ binary: entry });
    expect(v.error).toBeNull();
    expect(v.ok).toMatchObject({ path: entry, kind: "python", link: null, pathPrefix: [join(venv, "bin")] });
    expect(v.ok!.interpreter).toMatchObject({ path: join(venv, "bin", "python"), installation: venv, pyvenv: { version_info: "3.14" } });
    expect(v.ok!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(describeBinary(v.ok!)).toMatch(/Python · interpréteur .*\.venv\/bin\/python → .*python3.* · installation .*\.venv \(Python 3\.14\)/);
  });

  it("refus : absent, relatif, « .. », répertoire, shebang via env, shebang relatif, script shell, format inconnu, non exécutable", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-bin-"));
    const w = async (name: string, text: string, mode = 0o755) => {
      const p = join(root, name);
      await writeFile(p, text);
      await chmod(p, mode);
      return p;
    };
    expect((await verifyHermesBinary(null)).error).toMatch(/aucun binaire Hermes administré/);
    expect((await verifyHermesBinary({ binary: join(root, "absent") })).error).toMatch(/illisible/);
    expect((await verifyHermesBinary({ binary: "hermes" })).error).toMatch(/non absolu/);
    expect(strictAbsolute(`${root}/a/../b`, "x")).toMatch(/« \. » ou « \.\. » interdit/);
    expect((await verifyHermesBinary({ binary: root })).error).toMatch(/pas un fichier régulier/);
    expect((await verifyHermesBinary({ binary: await w("env", "#!/usr/bin/env python3\n") })).error).toMatch(/lancé via env/);
    expect((await verifyHermesBinary({ binary: await w("rel", "#!python3\n") })).error).toMatch(/sans interpréteur absolu/);
    expect((await verifyHermesBinary({ binary: await w("sh", "#!/bin/sh\nexec hermes\n") })).error).toMatch(/script shell \(sh\)/);
    expect((await verifyHermesBinary({ binary: await w("txt", "bonjour\n") })).error).toMatch(/format inconnu/);
    expect((await verifyHermesBinary({ binary: await w("noexec", `#!${PYTHON}\n`, 0o644) })).error).toMatch(/non exécutable/);
    expect((await verifyHermesBinary({ binary: await w("perl", "#!/usr/bin/perl\n") })).error).toMatch(/non pris en charge/);
  });

  it("lien : refusé sans cible notée ; accepté avec la cible notée exacte ; `linkTarget` sur un non-lien refusé", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-bin-"));
    const real = await makeFakeHermes(join(root, "r"));
    const link = join(root, "hermes");
    await symlink(real, link);
    expect((await verifyHermesBinary({ binary: link })).error).toMatch(/lien symbolique vers .*refusé tant que sa cible n'est pas notée/);
    const ok = await verifyHermesBinary({ binary: link, linkTarget: real });
    expect(ok.ok).toMatchObject({ path: link, realPath: real, link: { target: real } });
    expect((await verifyHermesBinary({ binary: real, linkTarget: real })).error).toMatch(/ce n'est pas un lien/);
  });

  const official = "/home/cyril/.local/share/hermes-0.21/hermes-agent/.venv/bin/hermes";
  it.skipIf(!existsSync(official))("machine de Cyril (lecture seule) : le vrai point d'entrée Hermes 0.21 est accepté ; l'enveloppe shell ~/.local/bin/hermes est refusée", async () => {
    const v = await verifyHermesBinary({ binary: official });
    expect(v.error).toBeNull();
    expect(v.ok?.kind).toBe("python");
    const wrapper = "/home/cyril/.local/bin/hermes";
    if (existsSync(wrapper)) expect((await verifyHermesBinary({ binary: wrapper })).error).toMatch(/script shell \(bash\)/);
  });
});
