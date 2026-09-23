import { readFile } from "node:fs/promises";

import {
  type JsonValue,
  WHITEBOARD_DESKTOP_DISCOVERY_VERSION,
  type WhiteboardDesktopDiscovery,
  isJsonObject,
  jsonNumber,
  jsonProperty,
  parseJsonText,
  parseWhiteboardDesktopDiscovery,
} from "@dev.fast/whiteboard-protocol";

import { whiteboardDesktopDiscoveryPath } from "./whiteboard-home-paths";

export class WhiteboardDesktopProtocolMismatchError extends Error {
  readonly name = "WhiteboardDesktopProtocolMismatchError";

  constructor(
    readonly actualVersion: number,
    readonly expectedVersion = WHITEBOARD_DESKTOP_DISCOVERY_VERSION,
  ) {
    super(
      `Review Desktop uses protocol ${actualVersion}, but this Review CLI needs protocol ${expectedVersion}. Update Review and Review Desktop to compatible versions, then try again.`,
    );
  }
}

export class WhiteboardDesktopDiscoveryUnreadableError extends Error {
  readonly name = "WhiteboardDesktopDiscoveryUnreadableError";

  constructor(filePath: string, detail?: string) {
    super(
      `Review Desktop discovery is unreadable at ${filePath}. Restart Review Desktop and try again.${detail ? ` ${detail}` : ""}`,
    );
  }
}

export async function readWhiteboardDesktopDiscovery(
  filePath = whiteboardDesktopDiscoveryPath(),
): Promise<WhiteboardDesktopDiscovery | null> {
  let source: string;

  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw new WhiteboardDesktopDiscoveryUnreadableError(
      filePath,
      String(error),
    );
  }

  let value: JsonValue;

  try {
    value = parseJsonText(source);
  } catch (error) {
    throw new WhiteboardDesktopDiscoveryUnreadableError(
      filePath,
      String(error),
    );
  }

  try {
    return parseWhiteboardDesktopDiscovery(value);
  } catch (error) {
    const version = isJsonObject(value)
      ? jsonNumber(jsonProperty(value, "version"))
      : undefined;

    if (
      version !== undefined &&
      Number.isInteger(version) &&
      version !== WHITEBOARD_DESKTOP_DISCOVERY_VERSION
    ) {
      throw new WhiteboardDesktopProtocolMismatchError(version);
    }

    throw new WhiteboardDesktopDiscoveryUnreadableError(
      filePath,
      String(error),
    );
  }
}

export interface WhiteboardDesktopHealthDependencies {
  readDiscovery?: typeof readWhiteboardDesktopDiscovery;
  fetch?: typeof globalThis.fetch;
}

export async function readHealthyWhiteboardDesktopDiscovery(
  dependencies: WhiteboardDesktopHealthDependencies = {},
): Promise<WhiteboardDesktopDiscovery | null> {
  const readDiscovery =
    dependencies.readDiscovery ?? readWhiteboardDesktopDiscovery;

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

export async function requireHealthyWhiteboardDesktop(
  retryCommand: string,
  dependencies: WhiteboardDesktopHealthDependencies = {},
): Promise<WhiteboardDesktopDiscovery> {
  const discovery = await readHealthyWhiteboardDesktopDiscovery(dependencies);

  if (discovery) return discovery;
  throw new Error(
    `Review Desktop is not ready. Run \`review app launch\`, then retry \`${retryCommand}\`.`,
  );
}
