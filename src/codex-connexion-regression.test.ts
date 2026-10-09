// Test de régression de Codex (réponse du 09/10/2026, 23 h 05, § 1 « Défaut reproduit ») : course annulation / reconnexion.
// Intégré tel quel dans la suite HC ; seule adaptation : conversion de type du faux spawner (« as unknown as Spawner ») pour tsc.
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { arreterConnexion, demarrerConnexion, sessionConnexion, type Spawner } from "./connexion.js";

it("annuler puis reconnecter : la fermeture de l'ancien enfant ne remplace pas la nouvelle session", async () => {
  const instanceHome = await mkdtemp(join(tmpdir(), "codex-cx-race-"));
  const children: Array<EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean }> = [];
  const spawnFn = (() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true,
    });
    children.push(child);
    return child;
  }) as unknown as Spawner;
  const options = { instanceHome, exec: { path: "/fixture/hermes", pathPrefix: [] }, spawnFn, timeoutMs: 3000 };
  const first = demarrerConnexion(options);
  expect(arreterConnexion(instanceHome)).toBe(true);
  const second = demarrerConnexion(options);
  expect(second).not.toBe(first);
  children[0]!.emit("close", null);
  await new Promise((r) => setTimeout(r, 40));
  const observed = sessionConnexion(instanceHome);
  children[1]!.emit("close", 1);
  await new Promise((r) => setTimeout(r, 40));
  expect(observed).toBe(second);
});
