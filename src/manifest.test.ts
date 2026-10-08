// Le manifeste COMPLET est validé comme Paperclip 2026.1001.0 le valide à l'installation (server/dist/services/plugin-loader.js) :
//  1. le VRAI schéma Zod du SDK : `pluginManifestV1Schema` de @paperclipai/shared 2026.1001.0 (exporté, importé tel quel —
//     c'est lui qu'utilise pluginManifestValidator().parseOrThrow, d'où « Invalid plugin manifest: description: Too big ») ;
//  2. la version d'API acceptée par l'hôte (PLUGIN_API_VERSION, importé) ;
//  3. la cohérence capacités ↔ déclarations (plugin-capability-validator.js : validateManifestCapabilities). Ce validateur
//     vit dans @paperclipai/server, qui ne l'exporte pas : ses tables utiles ici (FEATURE_CAPABILITIES, UI_SLOT_CAPABILITIES)
//     sont REPRODUITES fidèlement ci-dessous (copie de la version 2026.1001.0, limitée aux entrées pertinentes).
import { describe, expect, it } from "vitest";
import { PLUGIN_API_VERSION, pluginManifestV1Schema } from "@paperclipai/shared";
import { readFileSync } from "node:fs";
import manifest from "./manifest.js";

// copie de server/dist/services/plugin-capability-validator.js (2026.1001.0)
const FEATURE_CAPABILITIES: Record<string, string> = {
  tools: "agent.tools.register",
  jobs: "jobs.schedule",
  webhooks: "webhooks.receive",
  database: "database.namespace.migrate",
  environmentDrivers: "environment.drivers.register",
  agents: "agents.managed",
  projects: "projects.managed",
  routines: "routines.managed",
  objectReferences: "external.objects.detect",
};
const UI_SLOT_CAPABILITIES: Record<string, string> = {
  sidebar: "ui.sidebar.register",
  sidebarPanel: "ui.sidebar.register",
  projectSidebarItem: "ui.sidebar.register",
  page: "ui.page.register",
  detailTab: "ui.detailTab.register",
  taskDetailView: "ui.detailTab.register",
  dashboardWidget: "ui.dashboardWidget.register",
  globalToolbarButton: "ui.action.register",
  appShellOverlay: "ui.action.register",
  toolbarButton: "ui.action.register",
  contextMenuItem: "ui.action.register",
  commentAnnotation: "ui.commentAnnotation.register",
  commentContextMenuItem: "ui.action.register",
  settingsPage: "instance.settings.register",
  companySettingsPage: "instance.settings.register",
  routeSidebar: "ui.sidebar.register",
};
function missingCapabilities(m: Record<string, unknown>): string[] {
  const declared = new Set(m["capabilities"] as string[]);
  const missing: string[] = [];
  for (const [feature, cap] of Object.entries(FEATURE_CAPABILITIES)) {
    const v = m[feature];
    if (Array.isArray(v) && v.length > 0 && !declared.has(cap)) missing.push(cap);
  }
  for (const slot of ((m["ui"] as { slots?: { type: string }[] } | undefined)?.slots ?? [])) {
    const cap = UI_SLOT_CAPABILITIES[slot.type];
    if (cap && !declared.has(cap) && !missing.includes(cap)) missing.push(cap);
  }
  return missing;
}

describe("manifeste (Paperclip 2026.1001.0)", () => {
  it("passe le schéma Zod réel du SDK (pluginManifestV1Schema), en entier", () => {
    const r = pluginManifestV1Schema.safeParse(manifest);
    if (!r.success) throw new Error(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    expect(r.success).toBe(true);
  });

  it("description ≤ 500 caractères ; le même schéma refuse 501 (garde-fou du test lui-même)", () => {
    expect(manifest.description.length).toBeLessThanOrEqual(500);
    const tooBig = pluginManifestV1Schema.safeParse({ ...manifest, description: "x".repeat(501) });
    expect(tooBig.success).toBe(false);
  });

  it("version d'API acceptée par l'hôte, capacités cohérentes avec les déclarations", () => {
    expect(manifest.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(missingCapabilities(manifest as unknown as Record<string, unknown>)).toEqual([]);
  });

  it("version 0.7.0 partout : manifeste, package.json du plugin et de l'adaptateur", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    const apkg = JSON.parse(readFileSync(new URL("../adapter/package.json", import.meta.url), "utf8")) as { version: string };
    expect([manifest.version, pkg.version, apkg.version]).toEqual(["0.7.0", "0.7.0", "0.7.0"]);
  });

  it("0.7.0 : noms npm @cyberservices-ai, id du manifeste INCHANGÉ (clé du plugin dans Paperclip = manifest.id)", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string };
    const apkg = JSON.parse(readFileSync(new URL("../adapter/package.json", import.meta.url), "utf8")) as { name: string };
    expect(pkg.name).toBe("@cyberservices-ai/paperclip-plugin-hermes-control");
    expect(apkg.name).toBe("@cyberservices-ai/paperclip-adapter-hermes-control");
    expect(manifest.id).toBe("hermes-control");
  });
});
