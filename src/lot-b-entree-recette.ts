// Point d'entrée de la recette isolée du lot B (jamais embarqué dans le plugin : esbuild.config.mjs ne le référence pas).
export { prepareByIdentity } from "./prepare-identite.js";
export { prepareAgent } from "./prepare.js";
export { readAssignments, resolveAssignment, setExecutionRoot, setHermesBinary, assignAgent } from "./assignments.js";
export { budgetSockets } from "./health.js";
export { readOwner } from "./proprietaire.js";
export { writeWorkspace, layout } from "./workspace.js";
export { makeFakeHermes, fakeCalls } from "./testkit.js";
export { controlDir } from "./paths.js";
