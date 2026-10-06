// Manifeste du plugin Paperclip « Hermes Control » — auteur : Cyril M (MIT).
// Déclaré statiquement : capacités visibles à l'installation, emplacements d'interface, config.

const manifest = {
  id: "hermes-control",
  apiVersion: 1,
  version: "0.6.0",
  displayName: "Hermes Control",
  author: "Cyril M",
  description:
    "Hermes Agent as the engine, Paperclip in charge: every agent runs only in the Hermes profile EXPLICITLY assigned to it (assignments table: company → authorized instances, agent → instance/profile; never by name), " +
    "and the provider / model / thinking chosen in the agent menu are written to that profile. Actions: assign / unassign an agent, declare a company's authorized instances, prepare a profile in a chosen instance (empty .env). " +
    "Health: installed / connected / connected-and-synced per agent, watchdog socket path and skill YAML checks. Pair it with the Hermes Control adapter.",
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
    "ui.action.register",
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
