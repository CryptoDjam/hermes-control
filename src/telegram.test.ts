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
