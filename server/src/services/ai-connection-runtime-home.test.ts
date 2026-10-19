import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimManagedAiHome, MANAGED_AI_STABLE_HOME_STALE_AFTER_MS } from "./ai-connection-runtime.js";

const roots: string[] = [];
async function tmpRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-home-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("claimManagedAiHome", () => {
  it("claims the stable path when nothing holds it yet", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    const result = await claimManagedAiHome(baseDir);
    expect(result).toEqual({ home: baseDir, stable: true });
    expect((await stat(baseDir)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(path.join(baseDir, ".paperclip-home-claim.json"), "utf8"))).toMatchObject({ pid: process.pid });
  });

  it("reclaims the same stable path on the next run after cleanup removes it", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    const first = await claimManagedAiHome(baseDir);
    await rm(first.home, { recursive: true, force: true });
    const second = await claimManagedAiHome(baseDir);
    expect(second).toEqual({ home: baseDir, stable: true });
  });

  it("falls back to a fresh unique directory without disturbing a live claim", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    const live = await claimManagedAiHome(baseDir);
    await writeFile(path.join(live.home, "sentinel.txt"), "in-flight-run");

    const concurrent = await claimManagedAiHome(baseDir);

    expect(concurrent.stable).toBe(false);
    expect(concurrent.home).not.toBe(baseDir);
    expect(concurrent.home.startsWith(`${baseDir}-`)).toBe(true);
    expect(await readFile(path.join(live.home, "sentinel.txt"), "utf8")).toBe("in-flight-run");
  });

  it("never lets two concurrent callers both win the stable path", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    const [a, b] = await Promise.all([claimManagedAiHome(baseDir), claimManagedAiHome(baseDir)]);
    const stableWinners = [a, b].filter((result) => result.stable);
    expect(stableWinners).toHaveLength(1);
    expect(stableWinners[0]!.home).toBe(baseDir);
    expect(a.home).not.toBe(b.home);
  });

  it("treats a claim with no readable marker as live, not stale", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    await mkdir(baseDir, { mode: 0o700 });

    const result = await claimManagedAiHome(baseDir);

    expect(result.stable).toBe(false);
    expect(result.home).not.toBe(baseDir);
  });

  it("reclaims a claim left behind by a run that crashed before cleanup", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    let now = 1_000_000;
    await claimManagedAiHome(baseDir, () => now);
    await writeFile(path.join(baseDir, "leftover-credential.txt"), "stale");

    now += MANAGED_AI_STABLE_HOME_STALE_AFTER_MS + 1;
    const result = await claimManagedAiHome(baseDir, () => now);

    expect(result).toEqual({ home: baseDir, stable: true });
    await expect(stat(path.join(baseDir, "leftover-credential.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not reclaim a claim that is merely old-ish, below the staleness threshold", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    let now = 1_000_000;
    await claimManagedAiHome(baseDir, () => now);

    now += MANAGED_AI_STABLE_HOME_STALE_AFTER_MS - 1;
    const result = await claimManagedAiHome(baseDir, () => now);

    expect(result.stable).toBe(false);
    expect(result.home).not.toBe(baseDir);
  });
});
