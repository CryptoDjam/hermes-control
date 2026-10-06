// Garde-fou des tests : la référence de Hermes Control se calcule depuis le compte Unix (getpwuid), jamais $HOME. Les
// tests la redirigent vers $HOME, qui DOIT être un dossier temporaire : un test qui viserait le vrai dossier du compte
// (donc ~/.config/hermes-control de la machine) échoue au lieu d'y écrire.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { setAccountHomeResolverForTests } from "./src/paths.js";

const realAccount = (() => {
  try {
    return realpathSync(userInfo().homedir);
  } catch {
    return userInfo().homedir;
  }
})();
// HOME temporaire par défaut pour tout le fichier de test (chaque test peut le remplacer par le sien)
process.env["HOME"] = mkdtempSync(join(tmpdir(), "hc-home-"));
setAccountHomeResolverForTests(() => {
  const h = process.env["HOME"];
  if (!h) throw new Error("test sans HOME temporaire : référence refusée");
  let r = h;
  try {
    r = realpathSync(h);
  } catch {
    /* dossier pas encore créé */
  }
  if (r === realAccount || realAccount.startsWith(r + "/")) throw new Error(`test : HOME (${h}) désigne le vrai dossier du compte ; refus`);
  return h;
});
