import { rm } from "node:fs/promises";

import type { ReviewDesktopDiscovery } from "@dev.fast/review-protocol";
import { writePrivateJsonAtomic } from "@dev.fast/trace-core";

import {
  readHealthyReviewDesktopDiscovery,
  readReviewDesktopDiscovery,
} from "./desktop-discovery";

export type ReviewDesktopChannel = NonNullable<
  ReviewDesktopDiscovery["channel"]
>;

export function reviewDesktopChannel(
  env: NodeJS.ProcessEnv = process.env,
): ReviewDesktopChannel {
  return env.DEV_FAST_REVIEW_APP_URL_PROTOCOL === "dev-fast-review-preview"
    ? "preview"
    : "stable";
}

/** `server.json` → `server.preview.json`: each running app's own record. */
export function channelDiscoveryPath(
  sharedPath: string,
  channel: ReviewDesktopChannel,
): string {
  return sharedPath.replace(/\.json$/, `.${channel}.json`);
}

type Healthy = (
  read: () => Promise<ReviewDesktopDiscovery | null>,
) => Promise<ReviewDesktopDiscovery | null>;

const healthy: Healthy = (readDiscovery) =>
  readHealthyReviewDesktopDiscovery({ readDiscovery });

const readQuietly = (filePath: string) => () =>
  readReviewDesktopDiscovery(filePath).catch(() => null);

/**
 * Stable and Preview share one discovery pointer, so agents keep one Review
 * MCP entry. Stable always takes the pointer; Preview takes it only while no
 * healthy Stable holds it.
 */
export async function claimDesktopDiscovery(
  sharedPath: string,
  discovery: ReviewDesktopDiscovery & { channel: ReviewDesktopChannel },
  isHealthy: Healthy = healthy,
): Promise<void> {
  await writePrivateJsonAtomic(
    channelDiscoveryPath(sharedPath, discovery.channel),
    discovery,
  );

  if (discovery.channel === "preview") {
    const owner = await isHealthy(readQuietly(sharedPath));

    // Discovery written before channels existed came from Stable.
    if (owner && (owner.channel ?? "stable") === "stable") return;
  }

  await writePrivateJsonAtomic(sharedPath, discovery);
}

/** Removes this app's records and hands the pointer to a running Preview. */
export async function releaseDesktopDiscovery(
  sharedPath: string,
  discovery: ReviewDesktopDiscovery & { channel: ReviewDesktopChannel },
  isHealthy: Healthy = healthy,
): Promise<void> {
  const own = channelDiscoveryPath(sharedPath, discovery.channel);

  for (const filePath of [own, sharedPath]) {
    const current = await readQuietly(filePath)();

    if (
      current?.instanceId === discovery.instanceId &&
      current.appPid === discovery.appPid
    )
      await rm(filePath, { force: true });
  }

  if (discovery.channel !== "stable") return;

  const preview = await isHealthy(
    readQuietly(channelDiscoveryPath(sharedPath, "preview")),
  );

  if (preview && !(await readQuietly(sharedPath)()))
    await writePrivateJsonAtomic(sharedPath, preview);
}

/** The pointer, else a running app's own record when the pointer is stale. */
export async function readHealthyDesktopFromAnyChannel(
  sharedPath: string,
  isHealthy: Healthy = healthy,
): Promise<ReviewDesktopDiscovery | null> {
  for (const filePath of [
    sharedPath,
    channelDiscoveryPath(sharedPath, "stable"),
    channelDiscoveryPath(sharedPath, "preview"),
  ]) {
    const discovery = await isHealthy(readQuietly(filePath));

    if (discovery) return discovery;
  }

  return null;
}
