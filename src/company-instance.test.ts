import { describe, expect, it } from "vitest";
import { companyInstance } from "./company-instance.js";
import type { HermesInstance } from "./hermes.js";
import { layout } from "./workspace.js";

const ws = layout("/ws");
const inst = (name: string, home = `${ws.profils}/${name}`): HermesInstance => ({ name, home, launcher: null, dashboardUrl: null, errors24h: 0, lastError: null, profiles: [] });

describe("companyInstance (strict : nom = slug de l'entreprise, aucun repli)", () => {
  it("0 instance dans le dossier de travail → erreur qui nomme l'attendu et « aucune »", () => {
    expect(() => companyInstance(ws, [inst("acme", "/ailleurs/acme")], "ACME")).toThrow(/« acme ».*aucune/);
  });
  it("1 instance d'un autre nom → erreur qui liste les instances présentes (plus de repli sur la seule)", () => {
    expect(() => companyInstance(ws, [inst("direction")], "ACME")).toThrow(/« acme ».*présentes : direction/);
  });
  it("1 instance du bon nom → retournée", () => {
    expect(companyInstance(ws, [inst("acme")], "ACME").home).toBe(`${ws.profils}/acme`);
  });
  it("plusieurs instances → celle du nom de l'entreprise, jamais la première", () => {
    expect(companyInstance(ws, [inst("direction"), inst("acme"), inst("marketing")], "Acme").name).toBe("acme");
    expect(() => companyInstance(ws, [inst("direction"), inst("marketing")], "Acme")).toThrow(/direction, marketing/);
  });
  it("entreprise sans nom → erreur (pas de choix par défaut)", () => {
    expect(() => companyInstance(ws, [inst("acme")], null)).toThrow(/nom d'entreprise inconnu/);
  });
});
