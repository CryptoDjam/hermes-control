import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTelegramToken, telegramConfigured, validTelegramToken } from "./telegram.js";

const TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789abc";

describe("jeton Telegram", () => {
  it("valide la forme du jeton", () => {
    expect(validTelegramToken(TOKEN)).toBe(true);
    expect(validTelegramToken("abc")).toBe(false);
    expect(validTelegramToken("123:court")).toBe(false);
  });

  it("écrit TELEGRAM_BOT_TOKEN dans .env en 600, garde les autres variables, remplace sans doublon", async () => {
    const home = await mkdtemp(join(tmpdir(), "hc-tg-"));
    await writeFile(join(home, ".env"), "HINDSIGHT_API_KEY=secret\n");
    expect(await telegramConfigured(home)).toBe(false);
    expect(await setTelegramToken(home, TOKEN)).toBe(true);
    const text = await readFile(join(home, ".env"), "utf8");
    expect(text).toBe(`HINDSIGHT_API_KEY=secret\n\nTELEGRAM_BOT_TOKEN=${TOKEN}\n`);
    expect(((await stat(join(home, ".env"))).mode & 0o777)).toBe(0o600);
    expect(await telegramConfigured(home)).toBe(true);
    expect(await setTelegramToken(home, TOKEN)).toBe(false); // identique → rien
    const other = TOKEN.replace("ABC", "XYZ");
    expect(await setTelegramToken(home, other)).toBe(true);
    expect((await readFile(join(home, ".env"), "utf8")).match(/TELEGRAM_BOT_TOKEN/g)?.length).toBe(1);
  });

  it("crée .env s'il n'existe pas", async () => {
    const home = await mkdtemp(join(tmpdir(), "hc-tg-"));
    await setTelegramToken(home, TOKEN);
    expect(await readFile(join(home, ".env"), "utf8")).toBe(`TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
  });

  it("refuse un jeton invalide sans toucher au fichier", async () => {
    const home = await mkdtemp(join(tmpdir(), "hc-tg-"));
    await expect(setTelegramToken(home, "pas-un-jeton")).rejects.toThrow(/invalide/);
    await expect(stat(join(home, ".env"))).rejects.toThrow();
  });
});

describe("garde-fou passerelle Telegram unique", () => {
  it("gatewayOwners lit les unités hermes-gateway*.service (HOME temporaire) ; assertGatewayFree refuse pour un autre HERMES_HOME ou un autre profil avec jeton", async () => {
    const { mkdir } = await import("node:fs/promises");
    const { assertGatewayFree, gatewayOwners } = await import("./telegram.js");
    const root = await mkdtemp(join(tmpdir(), "hc-gw-"));
    const saved = process.env["HOME"];
    process.env["HOME"] = root;
    try {
      expect(await gatewayOwners()).toEqual([]);
      const units = join(root, ".config", "systemd", "user");
      await mkdir(units, { recursive: true });
      const owner = join(root, "marketing", "profiles", "apolline-m");
      await writeFile(join(units, "hermes-gateway-apolline-m.service"), `[Service]\nExecStart=/x/python -m hermes_cli.main --profile apolline-m gateway run\nEnvironment="HERMES_HOME=${owner}"\nEnvironment="HERMES_SUPERVISED_CHILD=1"\n`);
      await writeFile(join(units, "hermes-dashboard-direction.service"), "Environment=HERMES_HOME=%h/direction\n"); // pas une passerelle : ignorée
      expect(await gatewayOwners()).toEqual([{ unit: "hermes-gateway-apolline-m.service", home: owner }]);
      const other = join(root, "direction");
      await expect(assertGatewayFree(other, [owner, other])).rejects.toThrow(new RegExp(`${owner}.*hermes-gateway-apolline-m.service`));
      await expect(assertGatewayFree(owner, [owner, other])).resolves.toBeUndefined(); // le même profil peut changer son jeton
      // sans unité, un autre profil connu qui a déjà TELEGRAM_BOT_TOKEN suffit à refuser (nom de variable seulement)
      const { rm } = await import("node:fs/promises");
      await rm(join(units, "hermes-gateway-apolline-m.service"));
      await mkdir(owner, { recursive: true });
      await writeFile(join(owner, ".env"), "TELEGRAM_BOT_TOKEN=secret\n");
      await expect(assertGatewayFree(other, [owner, other])).rejects.toThrow(/a déjà TELEGRAM_BOT_TOKEN/);
      await expect(assertGatewayFree(other, [owner, other])).rejects.not.toThrow(/secret/);
      await expect(assertGatewayFree(owner, [owner, other])).resolves.toBeUndefined();
    } finally {
      if (saved) process.env["HOME"] = saved;
    }
  });
});
