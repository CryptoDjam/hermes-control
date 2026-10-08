// Build de l'adaptateur (0.7.0) : BUNDLE AUTONOME, un seul fichier ESM Node, sans dépendance npm à l'installation.
// Les copies corrigées « voie 1 » (@paperclipai/hermes-paperclip-adapter et @paperclipai/adapter-utils, 2026.1001.0-hc063.1,
// installées en devDependencies depuis voie1/paquets/*.tgz) et leurs dépendances d'exécution sont INTÉGRÉES dans
// dist/index.js : l'archive publiée ne contient plus de dépendance `file:` (qu'npm ne sait pas résoudre depuis un paquet
// installé, voir docs/migration-0.7.0.md). Seuls les modules intégrés de Node restent externes.
//
// Deux substitutions EXACTES (échec du build si le texte attendu n'est pas trouvé exactement une fois) :
//  1. execute.js de l'adaptateur officiel corrigé : `import.meta.resolve("@paperclipai/adapter-utils/server-utils")` ne peut
//     plus rien résoudre dans un bundle (le paquet n'est pas installé) → URL fixe qui désigne la copie INTÉGRÉE ; le marqueur
//     du correctif (`RUN_CHILD_PROCESS_FINAL_ENV_PATCH`) reste lu dans le module réellement intégré.
//  2. skills.js de l'adaptateur officiel : son dossier de module (`import.meta.url`) servait à trouver `../../skills` →
//     dossier vendu dans l'archive (dist/vendor/hermes-paperclip-adapter/skills, copié du paquet corrigé).
// Sortie : dist/index.js, dist/vendor/…/skills, dist/THIRD_PARTY_LICENSES.md (licences des modules intégrés, depuis le métafichier).
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { licencesTiers } from "../scripts/licences-tiers.mjs";

const ICI = dirname(fileURLToPath(import.meta.url));
const HPA = join(ICI, "node_modules", "@paperclipai", "hermes-paperclip-adapter");
const AU = join(ICI, "node_modules", "@paperclipai", "adapter-utils");
const VENDOR_HPA = "vendor/hermes-paperclip-adapter";

for (const [p, v] of [[HPA, "2026.1001.0-hc063.1"], [AU, "2026.1001.0-hc063.1"]]) {
  const j = JSON.parse(await readFile(join(p, "package.json"), "utf8"));
  if (j.version !== v || !j.hermesControlPatch) throw new Error(`copie corrigée attendue ${j.name}@${v} (voie 1), trouvée ${j.version} : lancer npm ci dans adapter/`);
}
const auVersion = JSON.parse(await readFile(join(AU, "package.json"), "utf8")).version;

function remplacerUneFois(src, avant, apres, fichier) {
  const n = src.split(avant).length - 1;
  if (n !== 1) throw new Error(`substitution impossible dans ${fichier} : « ${avant} » trouvé ${n} fois (attendu 1) — la base a changé`);
  return src.replace(avant, apres);
}
const substitutions = {
  name: "voie1-bundle",
  setup(b) {
    b.onLoad({ filter: /[\\/]@paperclipai[\\/]hermes-paperclip-adapter[\\/]dist[\\/]server[\\/](execute|skills)\.js$/ }, async (args) => {
      let src = await readFile(args.path, "utf8");
      if (args.path.endsWith(`${sep}execute.js`)) {
        src = remplacerUneFois(src, 'import.meta.resolve("@paperclipai/adapter-utils/server-utils")',
          `new URL("#bundle:@paperclipai/adapter-utils@${auVersion}/dist/server-utils.js", import.meta.url).href`, args.path);
      } else {
        src = remplacerUneFois(src, "const __moduleDir = path.dirname(fileURLToPath(import.meta.url));",
          `const __moduleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), ${JSON.stringify(`${VENDOR_HPA}/dist/server`)});`, args.path);
      }
      return { contents: src, loader: "js" };
    });
  },
};

await rm(join(ICI, "dist"), { recursive: true, force: true });
const r = await build({
  absWorkingDir: ICI,
  platform: "node",
  target: "node22",
  format: "esm",
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  metafile: true,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  external: ["node:*"],
  define: { __HC_BUNDLE__: "true" },
  plugins: [substitutions],
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
});

// ressources de l'adaptateur officiel corrigé lues à l'exécution : skills/ (paperclip-task-bridge)
await mkdir(join(ICI, "dist", VENDOR_HPA), { recursive: true });
await cp(join(HPA, "skills"), join(ICI, "dist", VENDOR_HPA, "skills"), { recursive: true });

// licences des paquets intégrés (depuis le métafichier : chaque node_modules/<paquet> qui a fourni du code)
const { texte, noms } = await licencesTiers(ICI, [r.metafile], ["# Modules tiers intégrés dans dist/index.js", "",
  "Généré par `esbuild.config.mjs` depuis le métafichier du build. Les deux paquets `@paperclipai/*` sont les copies corrigées",
  "« voie 1 » (base 2026.1001.0 publiée + `voie1/patches/`, provenance : `voie1/LICENCES.md`). Les modifications de Hermes Control",
  "sont sous licence MIT (Cyril M)."]);
await writeFile(join(ICI, "dist", "THIRD_PARTY_LICENSES.md"), texte);
console.log(`intégrés : ${noms.join(", ")}`);
