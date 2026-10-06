// Bibliothèque exportée pour les outils en ligne de commande (scripts/migrate-assignments.mjs) : les mêmes fonctions que le
// plugin et l'adaptateur, sans copie. Bundle : dist/lib.js (`npm run build`).
export { readConfigStrict, profileHome, instanceNameFromHome, listInstancesInRoot } from "./hermes.js";
export { configuredRoots, instanceHomes, discoverLight } from "./discovery.js";
export { assignmentsFile, emptyTable, knownRoots, parseTable, readAssignments, relationalIssues, replaceTable, canonicalInstance, sha256, expandExecutionRoot, executionHome, executionOf, hermesSpecFor, setHermesBinary, setExecutionRoot } from "./assignments.js";
export { agentsMapFile, readProjection } from "./agents-map.js";
export { readWorkspace } from "./workspace.js";
export { checkSocketPaths, SOCKET_PATH_MAX } from "./health.js";
export { profileUsability } from "./prepare.js";
export { slug } from "./match.js";
export { verifyHermesBinary, describeBinary } from "./binary.js";
export { accountHome, controlDir, legacyEnvPresent, legacyEnvRefusal } from "./paths.js";
export { referenceInfo, describeReference } from "./reference.js";
export { projectionProblem } from "./agents-map.js";
export { matchAgent } from "./match.js";
export { planMigration, parseAgentCommands, parseConfirm } from "./migrate.js";
export { planRollback, applyRollback } from "./rollback.js";
