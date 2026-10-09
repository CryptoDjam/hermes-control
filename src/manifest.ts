// Manifeste du plugin Paperclip « Hermes Control » — auteur : Cyril M (AGPL-3.0-or-later, terme additionnel 7(b) : ADDITIONAL-TERMS.md).
// Déclaré statiquement : capacités visibles à l'installation, emplacements d'interface, config.

const manifest = {
  id: "hermes-control",
  apiVersion: 1,
  version: "0.7.1",
  displayName: "Hermes Control",
  author: "Cyril M",
  // ≤ 500 caractères : Paperclip 2026.1001.0 refuse au-delà (« description: Too big ») ; vérifié par manifest.test.ts
  description:
    "Hermes Agent as the engine, Paperclip in charge. Each agent runs only in the Hermes profile explicitly assigned to it (assignments table, never by name), with the administered binary. Provider, model and thinking chosen in Paperclip are written to that profile. Actions: assign or unassign agents, authorize instances per company, prepare a profile (empty .env). Health per agent: installed / connected / connected-and-synced, socket path and skill checks. Use with the Hermes Control adapter.",
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
