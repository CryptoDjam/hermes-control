// 0.6.3, points 1 et 2 côté plugin : HOME du compte (getpwuid, refus sans repli) ; environnement des appels Hermes et de
// systemctl (PATH fixé, USER/LOGNAME du compte, bus utilisateur réservé à l'opération d'administration, dérivé de l'uid).
// Les appels sont observés dans le PROCESSUS FILS réel (faux Hermes qui journalise son environnement).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fixedPath, needsServiceManager, systemctlUserEnv, trustedSystemctl, userServiceManagerEnv } from "./admin-env.js";
import { hermes, hermesCallEnv } from "./hermes.js";
import { setAccountHomeResolverForTests } from "./paths.js";
import { planExecution, HermesControlRefusal } from "./execution.js";
import { startGateway } from "./telegram.js";
import { fakeCalls, makeFakeHermes } from "./testkit.js";

const ICI = dirname(fileURLToPath(import.meta.url));
const uid = process.getuid!();
let root: string;
const saved: Record<string, string | undefined> = {};
const SERVER_ENV = { PATH: "/tmp/leurre-bin:/usr/bin", USER: "root", LOGNAME: "root", XDG_RUNTIME_DIR: "/tmp/faux-xdg", DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/faux-bus", SECRET_DU_SERVICE: "sentinelle", LANG: "fr_FR.UTF-8", TZ: "../../../etc/passwd" };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hc-063-"));
  for (const [k, v] of Object.entries(SERVER_ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe("point 2 : environnement des appels Hermes du plugin (hermesCallEnv)", () => {
  it("opération ordinaire : PATH FIXÉ (interpréteur + système, rien du serveur), USER/LOGNAME du compte, ni XDG ni DBUS même si le serveur les porte", () => {
    const env = hermesCallEnv("/srv/h/profiles/p", { path: "/opt/venv/bin/hermes", pathPrefix: ["/opt/venv/bin"] });
    expect(env["PATH"]).toBe("/opt/venv/bin:/usr/local/bin:/usr/bin:/bin");
    expect(env["USER"]).toBe(userInfo().username);
    expect(env["LOGNAME"]).toBe(userInfo().username);
    expect(env).not.toHaveProperty("XDG_RUNTIME_DIR");
    expect(env).not.toHaveProperty("DBUS_SESSION_BUS_ADDRESS");
    expect(env).not.toHaveProperty("SECRET_DU_SERVICE");
    expect(env["LANG"]).toBe("fr_FR.UTF-8");
    expect(env).not.toHaveProperty("TZ"); // valeur au format refusé (chemin) : non transmise
    expect(Object.keys(env).sort()).toEqual(["HERMES_HOME", "HOME", "LANG", "LOGNAME", "NO_COLOR", "PATH", "PYTHONUNBUFFERED", "USER"]);
  });

  it("opération d'ADMINISTRATION du service (gateway_service) : bus dérivé de l'uid du compte (/run/user/<uid>), JAMAIS les valeurs du serveur", () => {
    expect(needsServiceManager("gateway_service")).toBe(true);
    expect(needsServiceManager("query")).toBe(false);
    const env = hermesCallEnv("/srv/h", { path: "/opt/venv/bin/hermes", pathPrefix: ["/opt/venv/bin"] }, "gateway_service");
    expect(env["XDG_RUNTIME_DIR"]).not.toBe("/tmp/faux-xdg");
    expect(env["DBUS_SESSION_BUS_ADDRESS"]).not.toBe("unix:path=/tmp/faux-bus");
    const expected = userServiceManagerEnv(uid);
    for (const k of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) expect(env[k]).toBe(expected[k]);
    if (existsSync(`/run/user/${uid}`)) expect(env["XDG_RUNTIME_DIR"]).toBe(`/run/user/${uid}`);
  });

  it("userServiceManagerEnv : dossier absent → rien ; dossier du compte → XDG ; socket bus du compte → DBUS", async () => {
    expect(userServiceManagerEnv(uid, join(root, "absent"))).toEqual({});
    const rr = join(root, "run-user");
    await mkdir(join(rr, String(uid)), { recursive: true, mode: 0o700 });
    expect(userServiceManagerEnv(uid, rr)).toEqual({ XDG_RUNTIME_DIR: `${rr}/${uid}` });
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(join(rr, String(uid), "bus"), r));
    try {
      expect(userServiceManagerEnv(uid, rr)).toEqual({ XDG_RUNTIME_DIR: `${rr}/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=${rr}/${uid}/bus` });
      // dossier d'un AUTRE uid (même chemin, uid demandé différent) : refusé
      expect(userServiceManagerEnv(uid + 1, rr)).toEqual({});
    } finally {
      srv.close();
    }
  });

  it("PROCESSUS FILS réel : un appel ordinaire (config set) ne reçoit ni XDG ni DBUS ; l'installation de la passerelle les reçoit, dérivés du compte", async () => {
    const bin = await makeFakeHermes(join(root, "hb"));
    await hermes(join(root, "h"), ["config", "set", "model.default", "m", "--force"], bin);
    await startGateway(join(root, "h"), bin).catch(() => "");
    const calls = await fakeCalls(join(root, "hb"));
    expect(calls).toHaveLength(2);
    const [q, g] = calls as [(typeof calls)[0], (typeof calls)[0]];
    expect(q.argv.slice(0, 2)).toEqual(["config", "set"]);
    expect(q.PATH).toBe(`${dirname(bin)}:/usr/local/bin:/usr/bin:/bin`);
    expect(q.env["USER"]).toBe(userInfo().username);
    expect(q.env["LOGNAME"]).toBe(userInfo().username);
    expect(q.env).not.toHaveProperty("XDG_RUNTIME_DIR");
    expect(q.env).not.toHaveProperty("DBUS_SESSION_BUS_ADDRESS");
    expect(g.argv.slice(0, 2)).toEqual(["gateway", "install"]);
    expect(g.env["XDG_RUNTIME_DIR"]).toBe(userServiceManagerEnv(uid)["XDG_RUNTIME_DIR"]);
    expect(g.env["DBUS_SESSION_BUS_ADDRESS"]).toBe(userServiceManagerEnv(uid)["DBUS_SESSION_BUS_ADDRESS"]);
    expect(g.env["XDG_RUNTIME_DIR"]).not.toBe("/tmp/faux-xdg");
  });

  it("l'opération n'est jamais un paramètre : `gateway_service` n'apparaît que dans admin-env, hermes (type) et telegram (startGateway)", () => {
    const users = readdirSync(ICI).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).filter((f) => readFileSync(join(ICI, f), "utf8").includes('"gateway_service"'));
    expect(users.sort()).toEqual(["admin-env.ts", "telegram.ts"]);
    const worker = readFileSync(join(ICI, "worker.ts"), "utf8");
    expect(worker).not.toMatch(/params\[["'](op|operation)["']\]/);
  });

  it("restartDashboard : systemctl de CONFIANCE (système, root, non modifiable) ; un systemctl du compte ou absent est refusé ; environnement minimal propre", async () => {
    const own = join(root, "systemctl");
    await writeFile(own, "#!/bin/sh\n");
    await chmod(own, 0o755);
    expect(() => trustedSystemctl([own])).toThrow(/propriétaire non root/);
    expect(() => trustedSystemctl([join(root, "absent")])).toThrow(/ENOENT/);
    if (existsSync("/usr/bin/systemctl") && statSync("/usr/bin/systemctl").uid === 0) expect(trustedSystemctl()).toMatch(/^\/usr\/(bin|lib)\//);
    const env = systemctlUserEnv();
    expect(env["PATH"]).toBe("/usr/bin:/bin");
    expect(env["USER"]).toBe(userInfo().username);
    expect(env["LANG"]).toBe("C.UTF-8");
    expect(env["XDG_RUNTIME_DIR"]).not.toBe("/tmp/faux-xdg");
    expect(env).not.toHaveProperty("SECRET_DU_SERVICE");
    expect(Object.keys(env).filter((k) => !["PATH", "HOME", "USER", "LOGNAME", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].includes(k))).toEqual([]);
    expect(fixedPath(["rel/ignoré", "/opt/a", "/opt/a"])).toBe("/opt/a:/usr/local/bin:/usr/bin:/bin");
  });
});

describe("point 1 : HOME du compte (getpwuid) — jamais $HOME, refus sans repli", () => {
  it("HOME d'un appel du plugin = dossier du compte, pas le HOME du processus", () => {
    setAccountHomeResolverForTests(null); // la vraie résolution (getpwuid), le temps de ce test (lecture seule)
    try {
      process.env["HOME"] = "/tmp/home-mensonger";
      const env = hermesCallEnv("/srv/h", { path: "/opt/venv/bin/hermes", pathPrefix: ["/opt/venv/bin"] });
      expect(env["HOME"]).toBe(userInfo().homedir);
    } finally {
      process.env["HOME"] = root;
      setAccountHomeResolverForTests(() => root);
    }
  });

  it("résolution du compte en échec → refus de CONFIGURATION avant tout (planExecution), aucun repli", async () => {
    setAccountHomeResolverForTests(() => { throw new Error("Hermes Control : compte Unix courant introuvable dans la base des comptes (getpwuid : ENOENT) ; refus, aucun repli vers $HOME"); });
    try {
      const e = await planExecution({ id: "x", name: "X", companyId: "A" }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(HermesControlRefusal);
      expect((e as HermesControlRefusal).kind).toBe("reference");
      expect((e as Error).message).toMatch(/aucun repli/);
    } finally {
      setAccountHomeResolverForTests(() => root);
    }
  });

  // accountHome réel (src/paths.ts, exécuté tel quel par Node avec suppression des types) dans un bwrap : base des comptes FICTIVE
  const NODE = process.execPath;
  function inSandbox(uidIn: number, passwd: string[]): { ok: boolean; home?: string; error?: string } {
    const pw = join(root, `passwd-${uidIn}-${passwd.length}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(pw, passwd.join("\n") + "\n");
    const drv = join(root, "pilote.mjs");
    writeFileSync(drv, `import { accountHome } from "/m/paths.ts";\ntry { console.log(JSON.stringify({ ok: true, home: accountHome() })); } catch (e) { console.log(JSON.stringify({ ok: false, error: String(e.message) })); }\n`);
    const r = spawnSync("/usr/bin/bwrap", ["--unshare-all", "--die-with-parent", "--uid", String(uidIn), "--gid", String(uidIn),
      "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib", "/lib64",
      "--ro-bind", pw, "/etc/passwd", "--ro-bind", "/etc/nsswitch.conf", "/etc/nsswitch.conf", "--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--ro-bind", dirname(dirname(NODE)), dirname(dirname(NODE)),
      "--ro-bind", join(ICI, "paths.ts"), "/m/paths.ts", "--ro-bind", drv, "/m/pilote.mjs",
      "--clearenv", "--setenv", "PATH", "/usr/bin", "--setenv", "HOME", "/tmp/home-mensonger", NODE, "--no-warnings", "/m/pilote.mjs"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout.trim().split("\n").pop()!);
  }
  it("accountHome réel (bwrap, base des comptes fictive) : HOME mensonger ignoré ; uid inconnu, dossier vide ou relatif → refus", () => {
    expect(inSandbox(1234, ["compte:x:1234:1234::/home/compte-recette:/bin/sh"])).toEqual({ ok: true, home: "/home/compte-recette" });
    expect(inSandbox(4242, ["autre:x:1234:1234::/home/autre:/bin/sh"]).error).toMatch(/introuvable dans la base des comptes.*aucun repli/);
    expect(inSandbox(1234, ["compte:x:1234:1234:::/bin/sh"]).error).toMatch(/invalide.*aucun repli/);
    expect(inSandbox(1234, ["compte:x:1234:1234::home/relatif:/bin/sh"]).error).toMatch(/invalide/);
  });
});
