// Build : worker + manifeste (Node, ESM) et UI (navigateur, ESM, React fourni par l'hôte Paperclip).
import { build, context } from "esbuild";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { licencesTiers } from "./scripts/licences-tiers.mjs";

const ICI = dirname(fileURLToPath(import.meta.url));

const watch = process.argv.includes("--watch");
const hostProvided = ["react", "react-dom", "react/jsx-runtime", "react-dom/client"];

const node = {
  platform: "node",
  target: "node22",
  format: "esm",
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  external: [...hostProvided, "node:*"],
  // Les dépendances CommonJS (yaml) utilisent require() : on le fournit dans le bundle ESM.
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
};

const targets = [
  { ...node, entryPoints: ["src/worker.ts"], outfile: "dist/worker.js" },
  { ...node, entryPoints: ["src/manifest.ts"], outfile: "dist/manifest.js" },
  { ...node, entryPoints: ["src/lib.ts"], outfile: "dist/lib.js" }, // pour scripts/migrate-assignments.mjs
  { ...node, entryPoints: ["src/suivi-cli.ts"], outfile: "dist/hermes-control-suivi.js", banner: { js: "#!/usr/bin/env node\n" + node.banner.js } }, // commande de l'opérateur (fraîcheur B)
  {
    platform: "browser",
    target: "es2022",
    format: "esm",
    bundle: true,
    sourcemap: true,
    logLevel: "info",
    jsx: "automatic",
    entryPoints: ["src/ui/index.tsx"],
    outfile: "dist/ui/index.js",
    external: [...hostProvided, "@paperclipai/plugin-sdk", "@paperclipai/plugin-sdk/ui"],
  },
];

if (watch) {
  for (const t of targets) (await context(t)).watch();
  console.log("hermes-control : surveillance des fichiers…");
} else {
  // 0.7.0 : paquet AUTONOME — toute dépendance d'exécution (yaml, plugin-sdk côté worker…) est intégrée ; seuls restent
  // externes Node et ce que l'hôte Paperclip fournit (React, @paperclipai/plugin-sdk/ui dans le navigateur)
  const metafiles = [];
  for (const t of targets) metafiles.push((await build({ ...t, absWorkingDir: ICI, metafile: true })).metafile);
  const { texte, noms } = await licencesTiers(ICI, metafiles, ["# Modules tiers intégrés dans dist/ (worker, manifeste, lib, commande, UI)", "",
    "Généré par `esbuild.config.mjs` depuis les métafichiers du build. React et `@paperclipai/plugin-sdk/ui` ne sont pas intégrés",
    "dans l'UI : ils sont fournis par l'hôte Paperclip."]);
  await writeFile(`${ICI}/dist/THIRD_PARTY_LICENSES.md`, texte);
  console.log(`intégrés : ${noms.join(", ")}`);
}
