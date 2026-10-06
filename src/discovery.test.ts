import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceHomes, rootsFile } from "./discovery.js";

let root: string;
let savedHome: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hc-disc-"));
  savedHome = process.env["HOME"];
  process.env["HOME"] = root;
});
afterEach(() => {
  if (savedHome) process.env["HOME"] = savedHome;
});

describe("instanceHomes", () => {
  it("un home venu d'un lanceur n'est retenu que s'il a un config.yaml ; rootsFile suit HOME", async () => {
    await mkdir(join(root, "vraie"));
    await writeFile(join(root, "vraie", "config.yaml"), "model: {}\n");
    await mkdir(join(root, "fausse"));
    const homes = await instanceHomes([join(root, "vraie"), join(root, "fausse"), join(root, "absente")]);
    expect(homes).toEqual([join(root, "vraie")]);
    expect(rootsFile()).toBe(join(root, ".config", "hermes-control", "roots"));
  });
});
