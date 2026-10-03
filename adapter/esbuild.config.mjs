// Build de l'adaptateur : un seul fichier ESM Node ; les paquets @paperclipai restent externes (résolus dans node_modules).
import { build } from "esbuild";

await build({
  platform: "node",
  target: "node22",
  format: "esm",
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  external: ["@paperclipai/*", "node:*"],
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
});
