import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  REVIEW_DESKTOP_DISCOVERY_VERSION,
  type ReviewDesktopDiscovery,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  type ReviewDesktopChannel,
  channelDiscoveryPath,
  claimDesktopDiscovery,
  readHealthyDesktopFromAnyChannel,
  releaseDesktopDiscovery,
} from "./desktop-discovery-claim";

const directories: string[] = [];

// Apps in this set answer health checks; the rest have exited.
const running = new Set<string>();

afterEach(async () => {
  running.clear();
  await Promise.all(
    directories.splice(0).map((dir) => rm(dir, { recursive: true })),
  );
});

async function sharedPath() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "review-discovery-"));
  directories.push(dir);

  return path.join(dir, "server.json");
}

function app(channel: ReviewDesktopChannel, appPid: number) {
  return {
    version: REVIEW_DESKTOP_DISCOVERY_VERSION,
    instanceId: `${channel}-${appPid}`,
    url: `http://127.0.0.1:${40_000 + appPid}`,
    appPid,
    serverPid: appPid + 1,
    token: "token",
    startedAt: 1,
    channel,
  } satisfies ReviewDesktopDiscovery;
}

const isHealthy = async (
  read: () => Promise<ReviewDesktopDiscovery | null>,
) => {
  const discovery = await read();

  return discovery && running.has(discovery.instanceId) ? discovery : null;
};

const owner = async (filePath: string) =>
  JSON.parse(await readFile(filePath, "utf8")).instanceId;

describe("desktop discovery channels", () => {
  it("keeps Stable as the owner while both run and hands back to Preview", async () => {
    const shared = await sharedPath();
    const stable = app("stable", 10);
    const preview = app("preview", 20);

    running.add(stable.instanceId);
    await claimDesktopDiscovery(shared, stable, isHealthy);
    running.add(preview.instanceId);
    await claimDesktopDiscovery(shared, preview, isHealthy);
    expect(await owner(shared)).toBe(stable.instanceId);

    running.delete(stable.instanceId);
    await releaseDesktopDiscovery(shared, stable, isHealthy);
    expect(await owner(shared)).toBe(preview.instanceId);
    await expect(
      readFile(channelDiscoveryPath(shared, "stable")),
    ).rejects.toThrow("ENOENT");
  });

  it("lets Stable take the pointer from a running Preview", async () => {
    const shared = await sharedPath();
    const stable = app("stable", 10);
    const preview = app("preview", 20);

    running.add(preview.instanceId);
    await claimDesktopDiscovery(shared, preview, isHealthy);
    running.add(stable.instanceId);
    await claimDesktopDiscovery(shared, stable, isHealthy);
    expect(await owner(shared)).toBe(stable.instanceId);

    // Preview quitting leaves Stable's pointer alone.
    running.delete(preview.instanceId);
    await releaseDesktopDiscovery(shared, preview, isHealthy);
    expect(await owner(shared)).toBe(stable.instanceId);
  });

  it("lets Preview claim over a Stable pointer that is no longer running", async () => {
    const shared = await sharedPath();
    const stable = app("stable", 10);
    const preview = app("preview", 20);

    await claimDesktopDiscovery(shared, stable, isHealthy);
    running.add(preview.instanceId);
    await claimDesktopDiscovery(shared, preview, isHealthy);
    expect(await owner(shared)).toBe(preview.instanceId);
  });

  it("finds a running app when the pointer is stale", async () => {
    const shared = await sharedPath();
    const stable = app("stable", 10);
    const preview = app("preview", 20);

    running.add(stable.instanceId);
    running.add(preview.instanceId);
    await claimDesktopDiscovery(shared, stable, isHealthy);
    await claimDesktopDiscovery(shared, preview, isHealthy);

    // Stable crashed without releasing.
    running.delete(stable.instanceId);
    expect(
      (await readHealthyDesktopFromAnyChannel(shared, isHealthy))?.instanceId,
    ).toBe(preview.instanceId);
  });
});
