import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type HostApiError,
  HostApiErrorSchema,
  type HostCommandInputs,
  type HostCommandName,
  HostIdSchema,
  type HostQueryInputs,
  type HostQueryName,
  HostVersionSchema,
  ReviewClient,
  ReviewClientError,
} from "@dev.fast/review-protocol";
import { z } from "zod";

const discoveryBytes = 16 * 1024;
export const LocalHostConnectionSchema = z.strictObject({
  hostId: HostIdSchema,
  workspaceId: HostIdSchema,
  url: z
    .url()
    .max(2048)
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(url.hostname) &&
        url.pathname === "/" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }, "Discovery must name a loopback HTTP origin."),
  token: z.string().min(16).max(512),
});
export type LocalHostConnection = z.infer<typeof LocalHostConnectionSchema>;
const HostDiscoverySchema = LocalHostConnectionSchema.extend({
  apiVersion: z.literal(1),
  instanceId: z.string().min(1).max(200),
  appPid: z.number().int().positive(),
});
export type HostDiscovery = z.infer<typeof HostDiscoverySchema>;

const scopedConnectionKeys = [
  "DEV_REVIEW_HOST_URL",
  "DEV_REVIEW_HOST_TOKEN",
  "DEV_REVIEW_HOST_ID",
  "DEV_REVIEW_WORKSPACE_ID",
  "DEV_REVIEW_HOST_CLIENT_ID",
] as const;

/** A scoped Ask process never falls back to the author's discovery credential. */
function explicitHostConnection(
  env: NodeJS.ProcessEnv,
): LocalHostConnection | undefined {
  if (!scopedConnectionKeys.some((key) => env[key] !== undefined))
    return undefined;
  const result = LocalHostConnectionSchema.safeParse({
    url: env.DEV_REVIEW_HOST_URL,
    token: env.DEV_REVIEW_HOST_TOKEN,
    hostId: env.DEV_REVIEW_HOST_ID,
    workspaceId: env.DEV_REVIEW_WORKSPACE_ID,
  });
  if (
    !result.success ||
    (env.DEV_REVIEW_HOST_CLIENT_ID !== undefined &&
      !HostIdSchema.safeParse(env.DEV_REVIEW_HOST_CLIENT_ID).success)
  )
    throw clientError(
      "INVALID_REQUEST",
      "The explicit Review connection is incomplete or invalid. Author discovery was not used.",
    );
  return result.data;
}

export interface LocalHostClientOptions {
  env?: NodeJS.ProcessEnv;
  clientId?: string;
  fetch?: typeof globalThis.fetch;
}

export function hostDiscoveryPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.DEV_REVIEW_HOME?.trim();
  const home = override
    ? path.resolve(override)
    : path.join(os.homedir(), ".dev");
  return path.join(home, "review-desktop", "host.json");
}

/** This is the only local file consumed by the agent transport. Never follow a
 * discovered executable path or read a review/database to service a request. */
export async function readHostDiscovery(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HostDiscovery> {
  try {
    const file = await open(
      hostDiscoveryPath(env),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size > discoveryBytes ||
        (process.platform !== "win32" &&
          ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
      )
        throw clientError(
          "FORBIDDEN",
          "Review host discovery must be an owner-private regular file.",
        );
      const bytes = Buffer.alloc(discoveryBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(
          bytes,
          length,
          bytes.length - length,
          length,
        );
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length > discoveryBytes)
        throw clientError(
          "RESOURCE_LIMIT",
          "Review host discovery is too large.",
        );
      return HostDiscoverySchema.parse(
        JSON.parse(bytes.toString("utf8", 0, length)),
      );
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof ReviewClientError) throw error;
    throw clientError(
      "DEPENDENCY_UNAVAILABLE",
      "Review Desktop's JSON host is unavailable. Start the checkout's Desktop with the JSON host enabled, then retry. No app was launched.",
    );
  }
}

/** A thin discovery adapter around the same ReviewClient used by the canvas.
 * A lost response is retried once with the original command/client IDs. */
export class LocalHostClient {
  private address: { hostId: string; workspaceId: string } | undefined;

  constructor(private readonly options: LocalHostClientOptions = {}) {
    if (options.clientId) HostIdSchema.parse(options.clientId);
  }

  connection(signal?: AbortSignal) {
    return this.perform(async (client) => client.connection, signal);
  }

  query<K extends HostQueryName>(
    type: K,
    input: HostQueryInputs[K],
    signal?: AbortSignal,
  ) {
    return this.perform((client) => client.query(type, input, signal), signal);
  }

  command<K extends HostCommandName>(
    type: K,
    input: HostCommandInputs[K],
    options: { commandId: string; signal?: AbortSignal },
  ) {
    HostIdSchema.parse(options.commandId);
    return this.perform(
      (client) => client.command(type, input, options),
      options.signal,
    );
  }

  open(reviewId: string, reviewVersion?: number, signal?: AbortSignal) {
    HostIdSchema.parse(reviewId);
    HostVersionSchema.optional().parse(reviewVersion);
    return this.perform(async (_client, discovery, request) => {
      const response = await request(
        `${discovery.url.replace(/\/$/, "")}/v1/app/open`,
        {
          method: "POST",
          signal,
          headers: {
            "x-review-token": discovery.token,
            "content-type": "application/json",
          },
          body: JSON.stringify({ reviewId, reviewVersion }),
        },
      );
      const result = z
        .discriminatedUnion("ok", [
          z.strictObject({
            ok: z.literal(true),
            data: z.strictObject({ opened: z.literal(true) }),
          }),
          z.strictObject({ ok: z.literal(false), error: HostApiErrorSchema }),
        ])
        .parse(await response.json());
      if (!result.ok) throw new ReviewClientError(result.error);
      if (!response.ok)
        throw clientError(
          "INTEGRITY_ERROR",
          "Review Desktop returned an inconsistent open response.",
        );
      return { opened: true as const };
    }, signal);
  }

  private async perform<T>(
    operation: (
      client: ReviewClient,
      discovery: LocalHostConnection,
      request: typeof globalThis.fetch,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const env = this.options.env ?? process.env;
        const discovery =
          explicitHostConnection(env) ?? (await readHostDiscovery(env));
        this.checkAddress(discovery);
        const request: typeof globalThis.fetch = (input, init) =>
          (this.options.fetch ?? globalThis.fetch)(input, {
            ...init,
            redirect: "error",
            signal: AbortSignal.any([
              AbortSignal.timeout(30_000),
              ...(init?.signal ? [init.signal] : []),
            ]),
          });
        if ("instanceId" in discovery) {
          const healthResponse = await request(
            `${discovery.url.replace(/\/$/, "")}/health`,
            {
              signal: AbortSignal.any([
                AbortSignal.timeout(1_500),
                ...(signal ? [signal] : []),
              ]),
            },
          );
          const health = z
            .object({
              ok: z.literal(true),
              instanceId: z.string(),
              desktopAttached: z.literal(true),
            })
            .safeParse(await healthResponse.json());
          if (
            !healthResponse.ok ||
            !health.success ||
            health.data.instanceId !== discovery.instanceId
          )
            throw clientError(
              "DEPENDENCY_UNAVAILABLE",
              "Review Desktop discovery refers to an inactive instance. Start the checkout's Desktop, then retry.",
            );
        }
        const client = await ReviewClient.connect(
          {
            serverUrl: discovery.url,
            token: discovery.token,
            clientId:
              this.options.clientId ??
              env.DEV_REVIEW_HOST_CLIENT_ID ??
              authoringClientId(discovery),
            fetch: request,
          },
          signal,
        );
        if (
          client.connection.hostId !== discovery.hostId ||
          client.connection.workspaceId !== discovery.workspaceId ||
          client.connection.principal.kind !== "agent"
        )
          throw clientError(
            "INTEGRITY_ERROR",
            "The Review host connection does not match its agent discovery identity.",
          );
        // A concurrent request may have connected while this one awaited I/O.
        this.checkAddress(discovery);
        this.address = {
          hostId: discovery.hostId,
          workspaceId: discovery.workspaceId,
        };
        return await operation(client, discovery, request);
      } catch (error) {
        if (signal?.aborted)
          throw clientError(
            "DEPENDENCY_UNAVAILABLE",
            "The Review client request was interrupted; its command ID can be retried.",
          );
        const failure =
          error instanceof Error
            ? describeHostClientError(error)
            : clientError("INTERNAL", "The Review client failed unexpectedly.")
                .detail;
        if (
          attempt === 1 ||
          (!failure.retryable && failure.code !== "UNAUTHORIZED")
        )
          throw new ReviewClientError(failure);
      }
    }
    throw clientError(
      "DEPENDENCY_UNAVAILABLE",
      "The Review host is unavailable.",
    );
  }

  private checkAddress(discovery: LocalHostConnection): void {
    if (
      this.address &&
      (this.address.hostId !== discovery.hostId ||
        this.address.workspaceId !== discovery.workspaceId)
    )
      throw clientError(
        "INTEGRITY_ERROR",
        "The discovered Review host or workspace changed. Reconnect explicitly before sending more requests.",
      );
  }
}

/** Stable across CLI/MCP restarts so a caller's receipt survives process loss. */
function authoringClientId(discovery: LocalHostConnection): string {
  const bytes = createHash("sha256")
    .update(
      `review-authoring-client-v1\0${discovery.hostId}\0${discovery.workspaceId}`,
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function describeHostClientError(error: Error): HostApiError {
  if (error instanceof ReviewClientError) return error.detail;
  if (error instanceof z.ZodError)
    return {
      code: "INVALID_REQUEST",
      message: "The value does not match the Review API schema.",
      retryable: false,
      diagnostics: error.issues.slice(0, 100).map((issue) => ({
        severity: "error",
        code: issue.code,
        message: issue.message,
        path: `/input${issue.path.map((part) => `/${String(part).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("")}`,
      })),
    };
  return clientError(
    "DEPENDENCY_UNAVAILABLE",
    "The Review host connection failed. Retry with the same command ID; no local fallback was used.",
  ).detail;
}

function clientError(
  code: HostApiError["code"],
  message: string,
): ReviewClientError {
  return new ReviewClientError({
    code,
    message,
    retryable: code === "DEPENDENCY_UNAVAILABLE",
    diagnostics: [],
  });
}
