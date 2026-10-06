// Dossier personnel et fichiers de ~/.config/hermes-control. Paperclip lance le worker sans HOME : on prend HOME
// s'il est défini (tests, environnements explicites), sinon le dossier de l'utilisateur Unix (/etc/passwd), jamais « / ».
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export function userHome(): string {
  const env = process.env["HOME"]?.trim();
  if (env) return env;
  try {
    const h = userInfo().homedir;
    if (h) return h;
  } catch {
    /* utilisateur sans entrée passwd */
  }
  return homedir();
}

export function controlDir(): string {
  return join(userHome(), ".config", "hermes-control");
}
