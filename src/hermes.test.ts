import { describe, expect, it } from "vitest";
import { assertSafeName, parseAuthStatus, parseConfig } from "./hermes.js";

describe("parseConfig", () => {
  it("lit le modèle et le fournisseur", () => {
    const cfg = parseConfig("model:\n  provider: openai-codex\n  default: gpt-5.6-luna\ntoolsets: [file, productivity]\napprovals:\n  mode: manual\n");
    expect((cfg["model"] as Record<string, string>)["default"]).toBe("gpt-5.6-luna");
    expect(cfg["toolsets"]).toEqual(["file", "productivity"]);
    expect((cfg["approvals"] as Record<string, string>)["mode"]).toBe("manual");
  });
  it("ne plante pas sur un fichier cassé", () => {
    expect(parseConfig("model: [oops")).toEqual({});
  });
});

describe("parseAuthStatus", () => {
  it("reconnaît les états de hermes auth status", () => {
    expect(parseAuthStatus("openai-codex: logged in")).toBe("logged_in");
    expect(parseAuthStatus("openai-codex: logged out (No Codex credentials stored. Run `hermes auth`)")).toBe("logged_out");
    expect(parseAuthStatus("???")).toBe("unknown");
  });
});

describe("assertSafeName", () => {
  it("accepte les noms de profils simples et refuse le reste", () => {
    expect(assertSafeName("apolline-m")).toBe("apolline-m");
    expect(() => assertSafeName("../x")).toThrow();
    expect(() => assertSafeName("a b")).toThrow();
  });
});
