import { readHealthyDesktopFromAnyChannel } from "../desktop-discovery-claim.js";
import { reviewDesktopDiscoveryPath } from "../review-home-paths.js";
import {
  readReviewServerDiscovery,
  reviewServerIsHealthy,
  reviewServerStateDir,
  serverNotReady,
} from "../server-discovery.js";
import { ReviewApiClient } from "./client.js";

export interface AuthoringTool {
  name: string;
  description: string;
  inputSchema: Tool["inputSchema"];
  method: "GET" | "POST";
  path: string;
  commandType?: string;
}

export const TEXT_TOOLS = new Set(["review_get", "review_get_instructions"]);

export async function connectReviewApi(env = process.env) {
  if (env.DEV_REVIEW_SERVER_DIR?.trim()) {
    const stateDir = reviewServerStateDir(env);
    const server = await readReviewServerDiscovery(stateDir);

    if (!server || !(await reviewServerIsHealthy(server)))
      throw serverNotReady(stateDir);

    return new ReviewApiClient({ serverUrl: server.url, token: server.token });
  }

  const discovery = await readHealthyDesktopFromAnyChannel(
    reviewDesktopDiscoveryPath(env),
  );

  if (!discovery)
    throw new Error(
      "No Review Desktop server is ready. Run review app launch, or select a running headless server with --state-dir or DEV_REVIEW_SERVER_DIR, then retry.",
    );

  return new ReviewApiClient({
    serverUrl: discovery.url,
    token: discovery.token,
  });
}

/** Only translate the tool envelope. The host owns validation and persistence. */
export function callAuthoringTool(
  client: ReviewApiClient,
  tool: AuthoringTool,
  input: NonNullable<CallToolRequest["params"]["arguments"]>,
  signal?: AbortSignal,
) {
  if (tool.commandType) {
    const { commandId, leaseId, ...fields } = input;

    return client.post(
      tool.path,
      { commandId, leaseId, operation: { ...fields, type: tool.commandType } },
      signal,
    );
  }

  const fields = { ...input };

  const route = tool.path.replace(
    /:(reviewId|draftId)\b/g,
    (_match, name: string) => {
      const value = fields[name];

      if (!isStringValue(value) || !value)
        throw new Error(`${name} is required.`);
      delete fields[name];

      return encodeURIComponent(value);
    },
  );

  if (tool.method === "POST") return client.post(route, fields, signal);
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(fields)) {
    // Hosts often send null for an unused optional field; the route reads absence.
    if (value === null || value === undefined) continue;

    if (
      !isStringValue(value) &&
      !isNumberValue(value) &&
      !isBooleanValue(value)
    )
      throw new Error(`${key} must be a string, number or boolean.`);

    query.set(key, String(value));
  }

  return client.read(route + (query.size ? `?${query}` : ""), signal);
}

import { isBooleanValue, isNumberValue, isStringValue } from "@dev.fast/json";
import type { CallToolRequest, Tool } from "@modelcontextprotocol/sdk/types.js";
