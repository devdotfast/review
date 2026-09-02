/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Review server runs in a utility process and announces the endpoint it
 * bound as a single newline-delimited JSON object on stdout. The main process
 * is the only party that knows the credentials it generated, so it validates
 * that announcement here before handing a connection to any renderer.
 */
// Hand-maintained twin of REVIEW_DESKTOP_DISCOVERY_VERSION in
// @dev.fast/review-protocol. Version 3: CLI-owned publish; the server
// replaced /publish with /publish-ready.
export const REVIEW_DESKTOP_CONNECTION_VERSION = 3;

/** Main-process IPC channel the renderer asks for that endpoint on. */
export const REVIEW_DESKTOP_CHANNEL = "review";

export interface ReviewDesktopConnection {
  readonly version: number;
  readonly url: string;
  readonly token: string;
  readonly instanceId: string;
  readonly installationId?: string;
  readonly cliPath?: string;
  readonly cliVersion?: string;
}

export interface ReviewDesktopCredentials {
  readonly token: string;
  readonly instanceId: string;
}

/**
 * The Review runtime is staged inside the application bundle at packaging time
 * so an installed app never reaches back into a development checkout.
 */
const REVIEW_RUNTIME_SERVER_ENTRY =
  "review-runtime/dist/server/desktop-host.js";

/**
 * Resolves the server entry point. A development checkout may point at its own
 * build output, but a packaged app must only ever use the runtime staged inside
 * the bundle: honouring an environment override there would let an installed
 * app be pointed at arbitrary code.
 */
export function resolveReviewServerEntry(input: {
  readonly isBuilt: boolean;
  readonly appRoot: string;
  readonly serverEntryOverride?: string | undefined;
  readonly join?: (...segments: string[]) => string;
}): string {
  const join = input.join ?? ((...segments) => segments.join("/"));
  if (!input.isBuilt && input.serverEntryOverride) {
    return input.serverEntryOverride;
  }
  return join(input.appRoot, REVIEW_RUNTIME_SERVER_ENTRY);
}

export class ReviewReadyEventReader {
  private buffer = "";
  private done = false;

  constructor(private readonly credentials: ReviewDesktopCredentials) {}

  /**
   * Feeds a stdout chunk and returns the connection once the ready event has
   * been seen. Lines that are not the ready event are server logs and are
   * ignored; a ready event that fails validation throws immediately so startup
   * fails with a real reason instead of stalling until the readiness timeout.
   */
  push(chunk: string): ReviewDesktopConnection | undefined {
    if (this.done) return undefined;
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      const connection = this.readLine(line);
      if (connection) {
        this.done = true;
        this.buffer = "";
        return connection;
      }
      newline = this.buffer.indexOf("\n");
    }
    return undefined;
  }

  private readLine(line: string): ReviewDesktopConnection | undefined {
    if (!line.startsWith("{")) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (!isRecord(parsed) || parsed["event"] !== "ready") return undefined;
    return this.validate(parsed);
  }

  private validate(event: Record<string, unknown>): ReviewDesktopConnection {
    const version = event["version"];
    if (version !== REVIEW_DESKTOP_CONNECTION_VERSION) {
      throw new Error(
        `The Review server announced an unsupported discovery version: ${String(version)}.`,
      );
    }
    const url = event["url"];
    const token = event["token"];
    const instanceId = event["instanceId"];
    if (
      typeof url !== "string" ||
      typeof token !== "string" ||
      typeof instanceId !== "string"
    ) {
      throw new Error("The Review server ready event is malformed.");
    }
    if (
      token !== this.credentials.token ||
      instanceId !== this.credentials.instanceId
    ) {
      throw new Error(
        "The Review server ready event carried unexpected credentials.",
      );
    }
    const cliPath = event["cliPath"];
    const cliVersion = event["cliVersion"];
    const installationId = event["installationId"];
    return {
      version: REVIEW_DESKTOP_CONNECTION_VERSION,
      url: loopbackOrigin(url),
      token,
      instanceId,
      ...(typeof installationId === "string" && installationId
        ? { installationId }
        : {}),
      ...(typeof cliPath === "string" && cliPath ? { cliPath } : {}),
      ...(typeof cliVersion === "string" && cliVersion ? { cliVersion } : {}),
    };
  }
}

function loopbackOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `The Review server must listen on http loopback, got ${value}.`,
    );
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
    throw new Error(
      `The Review server must listen on http loopback, got ${value}.`,
    );
  }
  return url.origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
