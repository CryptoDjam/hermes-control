import { describe, expect, it } from "vitest";
import { matchAgent, slug } from "./match.js";
import type { HermesInstance, HermesProfile } from "./hermes.js";

function prof(name: string, description: string | null): HermesProfile {
  return { name, home: `/i/${name}`, description, model: "m", provider: "openai-codex", authStatus: "logged_in", approvalsMode: null, terminalBackend: null, toolsets: [], configError: null };
}
const instances: HermesInstance[] = [
  { name: "direction", home: "/i/direction", launcher: null, dashboardUrl: null, errors24h: 0, lastError: null, profiles: [prof("default", "Chef — PDG de CDjam"), prof("assistant", "Assistant de Chef (PDG de CDjam) : suivi")] },
  { name: "marketing", home: "/i/marketing", launcher: null, dashboardUrl: null, errors24h: 0, lastError: null, profiles: [prof("default", "CMO — directeur marketing"), prof("apolline-m", "Apolline M, influenceuse IA")] },
  { name: "recherche", home: "/i/recherche", launcher: null, dashboardUrl: null, errors24h: 0, lastError: null, profiles: [prof("default", "Chercheur — recherches web, wiki")] },
];

describe("slug", () => {
  it("normalise accents, majuscules et espaces", () => {
    expect(slug("Apolline M")).toBe("apolline-m");
    expect(slug("Élodie  Dupont")).toBe("elodie-dupont");
  });
});

describe("matchAgent", () => {
  it("trouve par nom de profil d'abord", () => {
    expect(matchAgent("Apolline M", instances)?.profile.name).toBe("apolline-m");
    expect(matchAgent("Assistant", instances)?.profile.name).toBe("assistant");
  });
  it("trouve par début de description sinon", () => {
    const chef = matchAgent("Chef", instances);
    expect(chef?.instance.name).toBe("direction");
    expect(chef?.profile.name).toBe("default");
    expect(matchAgent("CMO", instances)?.instance.name).toBe("marketing");
    expect(matchAgent("Chercheur", instances)?.instance.name).toBe("recherche");
  });
  it("renvoie null sans correspondance", () => {
    expect(matchAgent("Gardien", instances)).toBeNull();
  });
});
