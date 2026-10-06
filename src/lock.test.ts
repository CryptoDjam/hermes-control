import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { type LockOwner, lockReclaimable, ownerFile, pidAlive, readOwner, releaseLock, withDirLock } from "./lock.js";

const opts = { waitMs: 0, staleMs: 30_000, busy: "occupé" };
/** Un pid certainement mort : le plus grand pid possible sous Linux (pid_max 4194304) + quelques essais. */
function deadPid(): number {
  for (const pid of [4194303, 4194302, 4194301, 4000001]) if (!pidAlive(pid)) return pid;
  throw new Error("aucun pid mort trouvé");
}
async function plant(lock: string, owner: Partial<LockOwner>): Promise<LockOwner> {
  await mkdir(lock, { recursive: true });
  const o: LockOwner = { pid: owner.pid ?? process.pid, host: owner.host ?? hostname(), token: owner.token ?? "tok", startedAt: owner.startedAt ?? new Date().toISOString(), renewedAt: owner.renewedAt ?? new Date().toISOString() };
  await writeFile(ownerFile(lock), JSON.stringify(o));
  return o;
}
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("verrou à bail (owner.json : pid, token, startedAt, renewedAt)", () => {
  it("libération normale : owner.json écrit pendant l'opération, verrou supprimé à la fin", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-lock-"));
    const lock = join(root, "op.lock");
    let seen: LockOwner | null = null;
    await withDirLock(lock, opts, async () => {
      seen = await readOwner(lock);
    });
    expect(seen).not.toBeNull();
    expect(seen!.pid).toBe(process.pid);
    expect(seen!.host).toBe(hostname());
    expect(seen!.token).toMatch(/^[0-9a-f]{32}$/);
    await expect(stat(lock)).rejects.toThrow();
  });

  it("verrou ABANDONNÉ (bail périmé ET pid mort) : repris", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-lock-"));
    const lock = join(root, "op.lock");
    await plant(lock, { pid: deadPid(), renewedAt: ago(60_000) });
    expect(await lockReclaimable(lock, opts.staleMs)).toBe(true);
    let entered = false;
    await withDirLock(lock, opts, async () => {
      entered = true;
    });
    expect(entered).toBe(true);
    await expect(stat(lock)).rejects.toThrow();
  });

  it("verrou d'un pid mort mais au bail encore frais : PAS repris (le bail fait foi tant qu'il court)", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-lock-"));
    const lock = join(root, "op.lock");
    await plant(lock, { pid: deadPid(), renewedAt: ago(1_000) });
    expect(await lockReclaimable(lock, opts.staleMs)).toBe(false);
    await expect(withDirLock(lock, opts, async () => "x")).rejects.toThrow(/occupé/);
  });

  it("propriétaire VIVANT suspendu (bail périmé mais pid présent) : PAS repris, même si le dossier est vieux", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-lock-"));
    const lock = join(root, "op.lock");
    await plant(lock, { pid: process.pid, renewedAt: ago(120_000) });
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    expect(await lockReclaimable(lock, opts.staleMs)).toBe(false);
    await expect(withDirLock(lock, opts, async () => "x")).rejects.toThrow(/occupé/);
    expect((await readOwner(lock))?.token).toBe("tok"); // intact
  });

  it("propriétaire vivant qui renouvelle son bail : un second entrant est refusé pendant toute l'opération", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-lock-"));
    const lock = join(root, "op.lock");
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    const a = withDirLock(lock, { ...opts, renewMs: 20 }, async () => { entered(); await held; });
    await started;
    const first = (await readOwner(lock))!.renewedAt;
    await new Promise((r) => setTimeout(r, 80));
    expect(Date.parse((await readOwner(lock))!.renewedAt)).toBeGreaterThanOrEqual(Date.parse(first)); // bail renouvelé
    // vieillir le dossier ne suffit pas : le bail est frais et le pid vivant
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    await expect(withDirLock(lock, opts, async () => "x")).rejects.toThrow(/occupé/);
    release();
    await a;
    await expect(stat(lock)).rejects.toThrow();
  });

  it("un ancien détenteur ne libère JAMAIS le verrou de son successeur (jeton différent) ; un troisième reste refusé", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-lock-"));
    const lock = join(root, "op.lock");
    let enterA!: () => void, releaseA!: () => void, enterB!: () => void, releaseB!: () => void;
    const enteredA = new Promise<void>((r) => { enterA = r; });
    const finishA = new Promise<void>((r) => { releaseA = r; });
    const enteredB = new Promise<void>((r) => { enterB = r; });
    const finishB = new Promise<void>((r) => { releaseB = r; });
    const a = withDirLock(lock, { ...opts, renewMs: 3_600_000 }, async () => { enterA(); await finishA; });
    await enteredA;
    const ownerA = (await readOwner(lock))!;
    // A est en réalité abandonné : on simule sa mort (pid mort, bail périmé) ; B peut reprendre
    await writeFile(ownerFile(lock), JSON.stringify({ ...ownerA, pid: deadPid(), renewedAt: ago(60_000) }));
    const b = withDirLock(lock, { ...opts, renewMs: 3_600_000 }, async () => { enterB(); await finishB; });
    await enteredB;
    const ownerB = (await readOwner(lock))!;
    expect(ownerB.token).not.toBe(ownerA.token);
    // A termine : son finally ne doit pas toucher au verrou de B
    releaseA();
    await a;
    expect((await stat(lock)).isDirectory()).toBe(true);
    expect((await readOwner(lock))?.token).toBe(ownerB.token);
    // C ne passe pas pendant que B travaille
    let cEntered = false;
    await expect(withDirLock(lock, opts, async () => { cEntered = true; })).rejects.toThrow(/occupé/);
    expect(cEntered).toBe(false);
    // releaseLock avec le jeton de A : refusé ; avec celui de B (par B) : libéré
    expect(await releaseLock(lock, ownerA.token)).toBe(false);
    expect((await readOwner(lock))?.token).toBe(ownerB.token);
    releaseB();
    await b;
    await expect(stat(lock)).rejects.toThrow();
  });

  it("verrou d'un ancien format (sans owner.json) : repris seulement s'il est vieux ; frais → refus", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-lock-"));
    const lock = join(root, "op.lock");
    await mkdir(lock);
    await expect(withDirLock(lock, opts, async () => "x")).rejects.toThrow(/occupé/);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect(await withDirLock(lock, opts, async () => "x")).toBe("x");
  });

  it("verrou d'une autre machine au bail périmé : repris (le pid n'est pas sondable ici)", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-lock-"));
    const lock = join(root, "op.lock");
    await plant(lock, { pid: process.pid, host: "autre-machine", renewedAt: ago(60_000) });
    expect(await lockReclaimable(lock, opts.staleMs)).toBe(true);
    expect(await withDirLock(lock, opts, async () => "x")).toBe("x");
    expect(JSON.parse(await readFile(ownerFile(lock), "utf8").catch(() => "null"))).toBeNull();
  });
});
