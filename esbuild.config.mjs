// Build : worker + manifeste (Node, ESM) et UI (navigateur, ESM, React fourni par l'hôte Paperclip).
import { build, context } from "esbuild";

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
  for (const t of targets) await build(t);
}
