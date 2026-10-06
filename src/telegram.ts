// Jeton Telegram d'un profil Hermes : écrit dans <profil>/.env (mode 600), jamais relu ni affiché.
// Hermes lit TELEGRAM_BOT_TOKEN dans $HERMES_HOME/.env ; la passerelle (`hermes gateway`) est installée pour ce profil.
import { chmod, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hermes } from "./hermes.js";
import { userHome } from "./paths.js";

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

export interface GatewayOwner {
  unit: string; // nom de l'unité systemd utilisateur
  home: string; // HERMES_HOME qu'elle porte
}

/** Chemin réel quand il existe (comparaisons), sinon résolu. */
async function realOrResolved(p: string): Promise<string> {
  return (await realpath(p).catch(() => null)) ?? resolve(p);
}

/** Unités `~/.config/systemd/user/hermes-gateway*.service` et le HERMES_HOME de chacune (noms de fichiers et chemins seulement). */
export async function gatewayOwners(): Promise<GatewayOwner[]> {
  const home = userHome();
  const dir = join(home, ".config", "systemd", "user");
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.startsWith("hermes-gateway") && f.endsWith(".service"));
  } catch {
    return [];
  }
  const out: GatewayOwner[] = [];
  for (const unit of files.sort()) {
    try {
      const text = await readFile(join(dir, unit), "utf8");
      // `Environment=` accepte plusieurs paires sur une ligne : Environment="A=1" "HERMES_HOME=/x"
      for (const line of text.split("\n")) {
        if (!/^Environment=/.test(line.trim())) continue;
        const m = /(?:^|["\s])HERMES_HOME=("?)([^"\s]+)\1/.exec(line);
        if (!m) continue;
        const raw = m[2]!.replace(/^%h(?=\/|$)/, home).replace(/^~(?=\/|$)/, home);
        out.push({ unit, home: await realOrResolved(raw) });
        break;
      }
    } catch {
      /* unité illisible : ignorée */
    }
  }
  return out;
}

/**
 * Garde-fou : une seule passerelle Telegram par machine (Hermes installe une unité par utilisateur).
 * Refuse quand une unité de passerelle existe pour un AUTRE HERMES_HOME, ou quand un autre profil connu a déjà
 * TELEGRAM_BOT_TOKEN (on ne lit que les noms de variables, jamais les valeurs).
 */
export async function assertGatewayFree(home: string, knownProfiles: string[]): Promise<void> {
  const target = await realOrResolved(home);
  for (const o of await gatewayOwners()) {
    if (o.home !== target) throw new Error(`passerelle Telegram refusée : le profil ${o.home} tient déjà la passerelle (unité ${o.unit}) ; une seule passerelle par machine`);
  }
  for (const p of knownProfiles) {
    if ((await realOrResolved(p)) === target) continue;
    if (await telegramConfigured(p)) throw new Error(`passerelle Telegram refusée : le profil ${p} a déjà TELEGRAM_BOT_TOKEN dans son .env ; une seule passerelle par machine`);
  }
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
