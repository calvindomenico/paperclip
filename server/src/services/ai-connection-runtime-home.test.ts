import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimManagedAiHome, MANAGED_AI_STABLE_HOME_STALE_AFTER_MS } from "./ai-connection-runtime.js";

const writeFileFailureCountdown = vi.hoisted(() => ({ remaining: 0 }));
vi.mock("node:fs/promises", async (original) => {
  const filesystem = await original<typeof import("node:fs/promises")>();
  return {
    ...filesystem,
    writeFile: async (...args: Parameters<typeof filesystem.writeFile>) => {
      if (writeFileFailureCountdown.remaining > 0) {
        writeFileFailureCountdown.remaining -= 1;
        throw new Error("simulated disk failure");
      }
      return filesystem.writeFile(...args);
    },
  };
});

function deadPid(): number {
  return spawnSync(process.execPath, ["-e", "0"]).pid!;
}

const roots: string[] = [];
async function tmpRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-home-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  writeFileFailureCountdown.remaining = 0;
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
    await mkdir(baseDir, { mode: 0o700 });
    await writeFile(path.join(baseDir, "leftover-credential.txt"), "stale");
    await writeFile(path.join(baseDir, ".paperclip-home-claim.json"), JSON.stringify({ pid: deadPid(), claimedAt: 1_000_000 }));

    const result = await claimManagedAiHome(baseDir, () => 1_000_000 + MANAGED_AI_STABLE_HOME_STALE_AFTER_MS + 1);

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

  it("never reclaims a claim whose owning process is still alive, no matter how old the timestamp is", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    await mkdir(baseDir, { mode: 0o700 });
    await writeFile(path.join(baseDir, "live-credential.txt"), "in-flight-run");
    await writeFile(path.join(baseDir, ".paperclip-home-claim.json"), JSON.stringify({ pid: process.pid, claimedAt: 1_000_000 }));

    const result = await claimManagedAiHome(baseDir, () => 1_000_000 + MANAGED_AI_STABLE_HOME_STALE_AFTER_MS * 10);

    expect(result.stable).toBe(false);
    expect(result.home).not.toBe(baseDir);
    expect(await readFile(path.join(baseDir, "live-credential.txt"), "utf8")).toBe("in-flight-run");
  });

  it("refuses to trust or delete a pre-existing world-writable directory at the stable path", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    await mkdir(baseDir, { mode: 0o777 });
    await writeFile(path.join(baseDir, ".paperclip-home-claim.json"), JSON.stringify({ pid: deadPid(), claimedAt: 1 }));

    const result = await claimManagedAiHome(baseDir, () => 1 + MANAGED_AI_STABLE_HOME_STALE_AFTER_MS * 10);

    expect(result.stable).toBe(false);
    expect(result.home).not.toBe(baseDir);
    await expect(stat(baseDir)).resolves.toBeDefined();
  });

  it("never lets a second reclaiming caller destroy the home the first caller just recreated", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    await mkdir(baseDir, { mode: 0o700 });
    await writeFile(path.join(baseDir, ".paperclip-home-claim.json"), JSON.stringify({ pid: deadPid(), claimedAt: 1 }));
    const now = () => 1 + MANAGED_AI_STABLE_HOME_STALE_AFTER_MS * 10;

    const [a, b] = await Promise.all([claimManagedAiHome(baseDir, now), claimManagedAiHome(baseDir, now)]);

    const stableWinners = [a, b].filter((result) => result.stable);
    expect(stableWinners).toHaveLength(1);
    expect(stableWinners[0]!.home).toBe(baseDir);
    await expect(stat(baseDir)).resolves.toBeDefined();
    expect(JSON.parse(await readFile(path.join(baseDir, ".paperclip-home-claim.json"), "utf8"))).toMatchObject({ pid: process.pid });
  });

  it("cleans up the claimed directory if writing the marker fails, instead of leaking it forever", async () => {
    const root = await tmpRoot();
    const baseDir = path.join(root, "paperclip-ai-co-grant");
    writeFileFailureCountdown.remaining = 1;

    const failed = await claimManagedAiHome(baseDir);

    expect(failed.stable).toBe(false);
    await expect(stat(baseDir)).rejects.toMatchObject({ code: "ENOENT" });

    const retried = await claimManagedAiHome(baseDir);
    expect(retried).toEqual({ home: baseDir, stable: true });
  });
});
