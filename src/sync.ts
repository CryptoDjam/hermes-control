// Paperclip est le maître : provider / modèle / thinking choisis dans le menu de l'agent sont écrits
// dans le config.yaml du profil Hermes trouvé par le nom. On n'écrit que ce qui change.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hermes, parseConfig } from "./hermes.js";

export interface Desired {
  provider: string | null; // adapterConfig.provider
  model: string | null; // adapterConfig.model
  thinking: string | null; // --reasoning-effort dans adapterConfig.extraArgs (Thinking effort)
}

export interface SyncResult {
  changed: string[]; // clés écrites
  skipped: string[]; // clés déjà identiques ou vides
  error: string | null;
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,120}$/;
const PROVIDER_RE = /^[a-z0-9-]{1,40}$/;
const EFFORT_RE = /^[a-z0-9-]{1,20}$/;

/** Lit provider / modèle / thinking tels que Paperclip les stocke dans adapterConfig. */
export function desiredFromAdapterConfig(ac: Record<string, unknown>): Desired {
  const provider = typeof ac["provider"] === "string" && ac["provider"].trim() ? ac["provider"].trim() : null;
  const model = typeof ac["model"] === "string" && ac["model"].trim() ? ac["model"].trim() : null;
  let thinking: string | null = null;
  const extra = Array.isArray(ac["extraArgs"]) ? (ac["extraArgs"] as unknown[]).map(String) : [];
  const i = extra.indexOf("--reasoning-effort");
  if (i >= 0 && extra[i + 1]) thinking = String(extra[i + 1]);
  for (const k of ["thinkingEffort", "reasoningEffort", "modelReasoningEffort"]) {
    if (!thinking && typeof ac[k] === "string" && (ac[k] as string).trim()) thinking = (ac[k] as string).trim();
  }
  return { provider, model, thinking };
}

function pick(cfg: Record<string, unknown>, path: string[]): string | null {
  let cur: unknown = cfg;
  for (const k of path) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === "string" ? cur : cur == null ? null : String(cur);
}

/** Compare le config.yaml du profil aux valeurs Paperclip et écrit les différences avec `hermes config set`. */
export async function syncProfile(home: string, want: Desired, binary = "hermes"): Promise<SyncResult> {
  const res: SyncResult = { changed: [], skipped: [], error: null };
  let cfg: Record<string, unknown> = {};
  try {
    cfg = parseConfig(await readFile(join(home, "config.yaml"), "utf8"));
  } catch (e) {
    return { ...res, error: `config.yaml illisible : ${String(e)}` };
  }
  const plan: { key: string; value: string | null; current: string | null; ok: RegExp }[] = [
    { key: "model.provider", value: want.provider && want.provider !== "auto" ? want.provider : null, current: pick(cfg, ["model", "provider"]), ok: PROVIDER_RE },
    { key: "model.default", value: want.model, current: pick(cfg, ["model", "default"]), ok: MODEL_RE },
    { key: "reasoning_effort", value: want.thinking && want.thinking !== "auto" ? want.thinking : null, current: pick(cfg, ["reasoning_effort"]), ok: EFFORT_RE },
  ];
  for (const p of plan) {
    if (!p.value || p.value === p.current) {
      res.skipped.push(p.key);
      continue;
    }
    if (!p.ok.test(p.value)) {
      res.error = `${p.key} : valeur refusée (${p.value})`;
      continue;
    }
    try {
      await hermes(home, ["config", "set", p.key, p.value, "--force"], binary);
      res.changed.push(p.key);
    } catch (e) {
      res.error = `${p.key} : ${String((e as Error).message ?? e)}`;
    }
  }
  return res;
}
