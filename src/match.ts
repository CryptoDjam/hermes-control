// Le nom de l'agent Paperclip choisit son profil Hermes : « Apolline M » → profiles/apolline-m,
// « Chef » → profil dont la description commence par « Chef ».
import type { HermesInstance, HermesProfile } from "./hermes.js";

export function slug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface Match {
  instance: HermesInstance;
  profile: HermesProfile;
  by: "profile-name" | "description";
}

/** Premier mot (avant « — », « : », « - » ou « (») de la description, en slug. */
function descriptionHead(p: HermesProfile): string {
  const head = (p.description ?? "").split(/[—:(\-–]/)[0] ?? "";
  return slug(head);
}

export function matchAgent(agentName: string, instances: HermesInstance[]): Match | null {
  const s = slug(agentName);
  if (!s) return null;
  for (const instance of instances) {
    for (const profile of instance.profiles) if (profile.name === s) return { instance, profile, by: "profile-name" };
  }
  for (const instance of instances) {
    for (const profile of instance.profiles) if (descriptionHead(profile) === s) return { instance, profile, by: "description" };
  }
  return null;
}
