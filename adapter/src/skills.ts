// Skills Paperclip → profil Hermes.
// L'adaptateur Hermes officiel pose les liens des skills gérés par Paperclip dans `$HOME/.hermes/skills` ;
// or Hermes ne lit que `$HERMES_HOME/skills`. Hermes Control lance chaque agent avec HERMES_HOME = son profil,
// donc on pose (et retire) les mêmes liens dans `<profil>/skills/<nom>`.
import {
  type PaperclipSkillEntry,
  ensurePaperclipSkillSymlink,
  isPaperclipSkillSourceMissing,
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import type { AdapterSkillEntry, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import { lstat, mkdir, readFile, readdir, realpath, stat, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

type AnyRecord = Record<string, unknown>;


export interface ReconcileResult {
  skillsDir: string;
  desired: string[];
  linked: string[];
  removed: string[];
  warnings: string[];
}

export function profileSkillsDir(profileHome: string): string {
  return join(profileHome, "skills");
}

/** Dossier de l'adaptateur Hermes officiel : sert de secours quand Paperclip n'envoie pas l'inventaire. */
function officialModuleDir(): string {
  try {
    const req = createRequire(import.meta.url);
    return dirname(req.resolve("@paperclipai/hermes-paperclip-adapter/server"));
  } catch {
    return dirname(new URL(import.meta.url).pathname);
  }
}

async function realOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/** Skills désirés : ceux cochés dans Paperclip (+ `paperclip`, toujours), ou la liste passée par syncSkills. */
export async function desiredEntries(config: AnyRecord, requested?: string[]): Promise<{ entries: PaperclipSkillEntry[]; desired: string[] }> {
  const entries = await readPaperclipRuntimeSkillEntries(config, officialModuleDir());
  const desired = requested
    ? [...new Set([...resolveLegacyPaperclipDesiredSkillNames({}, entries), ...requested])]
    : resolveLegacyPaperclipDesiredSkillNames(config, entries);
  return { entries, desired };
}

/** Pose les liens des skills désirés dans `<profil>/skills`, retire ceux décochés (seulement s'ils pointent vers Paperclip). */
export async function reconcileIntoProfile(config: AnyRecord, profileHome: string, requested?: string[]): Promise<ReconcileResult> {
  const skillsDir = profileSkillsDir(profileHome);
  const out: ReconcileResult = { skillsDir, desired: [], linked: [], removed: [], warnings: [] };
  const { entries, desired } = await desiredEntries(config, requested);
  out.desired = desired;
  if (!entries.length) return out;
  await mkdir(skillsDir, { recursive: true });
  const desiredSet = new Set(desired);
  const sourceOf = new Map<string, PaperclipSkillEntry>();

  for (const e of entries) {
    sourceOf.set(e.runtimeName, e);
    if (!desiredSet.has(e.key)) continue;
    if (isPaperclipSkillSourceMissing(e)) {
      out.warnings.push(`Skill « ${e.runtimeName} » : source absente (${e.source}).`);
      continue;
    }
    const target = join(skillsDir, e.runtimeName);
    const wantReal = (await realOrNull(e.source)) ?? e.source;
    try {
      await ensurePaperclipSkillSymlink(e.source, target);
    } catch (err) {
      out.warnings.push(`Skill « ${e.runtimeName} » : lien impossible (${err instanceof Error ? err.message : String(err)}).`);
      continue;
    }
    const gotReal = await realOrNull(target);
    if (gotReal === wantReal) {
      out.linked.push(e.runtimeName);
      continue;
    }
    const st = await lstat(target).catch(() => null);
    const what = st?.isSymbolicLink() ? "un autre lien" : "un dossier";
    out.warnings.push(`Skill « ${e.runtimeName} » : ${target} est déjà occupé par ${what} ; laissé tel quel.`);
  }

  // Décoché dans Paperclip → on retire le lien, uniquement s'il pointe vers une source Paperclip.
  const installed = await readInstalledSkillTargets(skillsDir);
  for (const [name, inst] of installed.entries()) {
    const e = sourceOf.get(name);
    if (!e || desiredSet.has(e.key) || inst.kind !== "symlink") continue;
    const target = join(skillsDir, name);
    const gotReal = await realOrNull(target);
    const srcReal = (await realOrNull(e.source)) ?? e.source;
    const pointsToPaperclip = gotReal === srcReal || inst.targetPath === e.source;
    if (!pointsToPaperclip) continue;
    await unlink(target).catch(() => {});
    out.removed.push(name);
  }
  return out;
}

function frontmatterDescription(text: string): string | null {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return null;
  for (const line of m[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    if (line.slice(0, idx).trim() !== "description") continue;
    let v = line.slice(idx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v || null;
  }
  return null;
}

/** Skills présents dans `<profil>/skills` (dossiers ou liens avec un SKILL.md). */
export async function scanProfileSkills(profileHome: string): Promise<{ name: string; skillMd: string; description: string | null }[]> {
  const dir = profileSkillsDir(profileHome);
  const out: { name: string; skillMd: string; description: string | null }[] = [];
  const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const it of items) {
    if (it.name.startsWith(".")) continue;
    const skillMd = join(dir, it.name, "SKILL.md");
    if (!(await stat(skillMd).catch(() => null))) continue;
    const text = await readFile(skillMd, "utf8").catch(() => "");
    out.push({ name: it.name, skillMd, description: frontmatterDescription(text) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Corrige le snapshot officiel : les skills gérés par Paperclip montrent leur lien dans le profil ; ajoute les skills propres au profil. */
export async function snapshotForProfile(base: AdapterSkillSnapshot, profileHome: string, label: string): Promise<AdapterSkillSnapshot> {
  const skillsDir = profileSkillsDir(profileHome);
  const entries: AdapterSkillEntry[] = [];
  const managedNames = new Set<string>();
  for (const e of base.entries) {
    if (!e.managed || !e.runtimeName) {
      // skills « ~/.hermes/skills » listés par l'officiel : non chargés par ce profil → on les remplace par ceux du profil
      if (e.origin === "user_installed" && e.readOnly) continue;
      entries.push(e);
      continue;
    }
    managedNames.add(e.runtimeName);
    if (!e.desired) {
      entries.push(e);
      continue;
    }
    const target = join(skillsDir, e.runtimeName);
    const gotReal = await realOrNull(target);
    const srcReal = e.sourcePath ? (await realOrNull(e.sourcePath)) ?? e.sourcePath : null;
    const linked = gotReal !== null && (srcReal === null || gotReal === srcReal);
    entries.push({
      ...e,
      state: linked ? "configured" : "missing",
      targetPath: linked ? target : null,
      detail: linked ? `Lié dans le profil Hermes ${label} (${target}).` : `Pas encore lié dans ${skillsDir} : le lien sera posé au prochain passage de l'agent.`,
    });
  }
  for (const s of await scanProfileSkills(profileHome)) {
    if (managedNames.has(s.name)) continue;
    entries.push({
      key: s.name,
      runtimeName: s.name,
      desired: true,
      managed: false,
      state: "installed",
      origin: "user_installed",
      originLabel: "Skill du profil Hermes",
      locationLabel: `${basename(profileHome)}/skills/${s.name}`,
      readOnly: true,
      sourcePath: s.skillMd,
      targetPath: null,
      detail: s.description,
    });
  }
  return { ...base, entries };
}
