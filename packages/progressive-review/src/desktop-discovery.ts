import { readFile } from "node:fs/promises";

import {
  type JsonValue,
  REVIEW_DESKTOP_DISCOVERY_VERSION,
  type ReviewDesktopDiscovery,
  isJsonObject,
  jsonNumber,
  jsonProperty,
  parseJsonText,
  parseReviewDesktopDiscovery,
} from "@dev.fast/review-protocol";

import { reviewDesktopDiscoveryPath } from "./server/desktop-paths";

export class ReviewDesktopProtocolMismatchError extends Error {
  readonly name = "ReviewDesktopProtocolMismatchError";

  constructor(
    readonly actualVersion: number,
    readonly expectedVersion = REVIEW_DESKTOP_DISCOVERY_VERSION,
  ) {
    super(
      `Review Desktop uses protocol ${actualVersion}, but this Review CLI needs protocol ${expectedVersion}. Update Review and Review Desktop to compatible versions, then try again.`,
    );
  }
}

export class ReviewDesktopDiscoveryUnreadableError extends Error {
  readonly name = "ReviewDesktopDiscoveryUnreadableError";

  constructor(filePath: string, detail?: string) {
    super(
      `Review Desktop discovery is unreadable at ${filePath}. Restart Review Desktop and try again.${detail ? ` ${detail}` : ""}`,
    );
  }
}

export async function readReviewDesktopDiscovery(
  filePath = reviewDesktopDiscoveryPath(),
): Promise<ReviewDesktopDiscovery | null> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw new ReviewDesktopDiscoveryUnreadableError(filePath, String(error));
  }
  let value: JsonValue;
  try {
    value = parseJsonText(source);
  } catch (error) {
    throw new ReviewDesktopDiscoveryUnreadableError(filePath, String(error));
  }
  try {
    return parseReviewDesktopDiscovery(value);
  } catch (error) {
    const version = isJsonObject(value)
      ? jsonNumber(jsonProperty(value, "version"))
      : undefined;
    if (
      version !== undefined &&
      Number.isInteger(version) &&
      version !== REVIEW_DESKTOP_DISCOVERY_VERSION
    ) {
      throw new ReviewDesktopProtocolMismatchError(version);
    }
    throw new ReviewDesktopDiscoveryUnreadableError(filePath, String(error));
  }
}

export interface ReviewDesktopHealthDependencies {
  readDiscovery?: typeof readReviewDesktopDiscovery;
  fetch?: typeof globalThis.fetch;
}

export async function readHealthyReviewDesktopDiscovery(
  dependencies: ReviewDesktopHealthDependencies = {},
): Promise<ReviewDesktopDiscovery | null> {
  const readDiscovery =
    dependencies.readDiscovery ?? readReviewDesktopDiscovery;
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const discovery = await readDiscovery();
  if (!discovery) return null;

  try {
    const response = await fetch(`${discovery.url}/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return null;
    const health = await response.json();
    if (
      !isJsonObject(health) ||
      health.ok !== true ||
      health.instanceId !== discovery.instanceId ||
      health.desktopAttached !== true
    ) {
      return null;
    }
    return discovery;
  } catch {
    return null;
  }
}

export async function requireHealthyReviewDesktop(
  retryCommand: string,
  dependencies: ReviewDesktopHealthDependencies = {},
): Promise<ReviewDesktopDiscovery> {
  const discovery = await readHealthyReviewDesktopDiscovery(dependencies);
  if (discovery) return discovery;
  throw new Error(
    `Review Desktop is not ready. Run \`review app launch\`, then retry \`${retryCommand}\`.`,
  );
}
