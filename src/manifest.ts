// Manifeste du plugin Paperclip « Hermes Control » — auteur : Cyril M (MIT).
// Déclaré statiquement : capacités visibles à l'installation, emplacements d'interface, config.

const manifest = {
  id: "hermes-control",
  apiVersion: 1,
  version: "0.4.0",
  displayName: "Hermes Control",
  author: "Cyril M",
  description:
    "Hermes Agent as the engine, Paperclip in charge: the agent name picks its Hermes profile, and the provider / model / thinking " +
    "chosen in the agent menu are written to that Hermes profile. Pair it with the Hermes Control adapter to list Hermes providers and models in Paperclip.",
  categories: ["ui", "automation"],
  capabilities: [
    "agents.read",
    "companies.read",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "jobs.schedule",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  jobs: [
    { jobKey: "sync", displayName: "Sync Paperclip -> Hermes", schedule: "*/5 * * * *" },
  ],
  ui: {
    slots: [
      { type: "sidebar", id: "hermes-sidebar", displayName: "Hermes", exportName: "HermesSidebar" },
      { type: "page", id: "hermes-page", displayName: "Hermes", exportName: "HermesPage", routePath: "hermes" },
    ],
  },
} as const;

export default manifest;
