// Jeton Telegram d'un profil Hermes : écrit dans <profil>/.env (mode 600), jamais relu ni affiché.
// Hermes lit TELEGRAM_BOT_TOKEN dans $HERMES_HOME/.env ; la passerelle (`hermes gateway`) est installée pour ce profil.
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hermes } from "./hermes.js";

const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,64}$/;

export function validTelegramToken(token: string): boolean {
  return TOKEN_RE.test(token.trim());
}

/** Le profil a-t-il un jeton ? (on ne lit que les NOMS de variables) */
export async function telegramConfigured(home: string): Promise<boolean> {
  try {
    return (await readFile(join(home, ".env"), "utf8")).split("\n").some((l) => /^\s*(export\s+)?TELEGRAM_BOT_TOKEN\s*=\s*\S/.test(l));
  } catch {
    return false;
  }
}

/** Pose ou remplace TELEGRAM_BOT_TOKEN dans <home>/.env (600). Retourne vrai si le fichier a changé. */
export async function setTelegramToken(home: string, token: string): Promise<boolean> {
  const t = token.trim();
  if (!validTelegramToken(t)) throw new Error("jeton Telegram invalide (forme attendue : 123456789:AAAA…)");
  const file = join(home, ".env");
  let lines: string[] = [];
  try {
    lines = (await readFile(file, "utf8")).split("\n");
  } catch {
    /* pas de .env */
  }
  const line = `TELEGRAM_BOT_TOKEN=${t}`;
  const idx = lines.findIndex((l) => /^\s*(export\s+)?TELEGRAM_BOT_TOKEN\s*=/.test(l));
  if (idx >= 0) {
    if (lines[idx] === line) return false;
    lines[idx] = line;
  } else {
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    lines.push(line);
  }
  await writeFile(file, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
  await chmod(file, 0o600);
  return true;
}

/** Installe et démarre la passerelle Hermes de ce profil (service utilisateur), sans shell. */
export async function startGateway(home: string, binary = "hermes"): Promise<string> {
  try {
    return await hermes(home, ["gateway", "install", "--start-now", "--start-on-login"], binary, 120_000);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    throw new Error(`hermes gateway install : ${(err.stderr || err.stdout || err.message || "").trim().slice(-400)}`);
  }
}
