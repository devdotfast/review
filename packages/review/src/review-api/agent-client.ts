import {
  readReviewDesktopDiscovery,
  requireHealthyReviewDesktop,
} from "../desktop-discovery.js";
import { reviewDesktopDiscoveryPath } from "../server/desktop-paths.js";
import { ReviewApiClient } from "./client.js";

export interface AuthoringTool {
  name: string;
  description: string;
  inputSchema: Tool["inputSchema"];
  method: "GET" | "POST";
  path: string;
  commandType?: string;
}

export async function connectReviewApi(env = process.env) {
  const discovery = await requireHealthyReviewDesktop("review api", {
    readDiscovery: () =>
      readReviewDesktopDiscovery(reviewDesktopDiscoveryPath(env)),
  });

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
    const { commandId, ...fields } = input;

    return client.post(
      tool.path,
      { commandId, operation: { ...fields, type: tool.commandType } },
      signal,
    );
  }

  let fields = input;
  let route = tool.path;

  if (route.includes(":reviewId")) {
    const { reviewId, ...rest } = input;

    if (!isStringValue(reviewId) || !reviewId)
      throw new Error("reviewId is required.");
    route = route.replace(":reviewId", encodeURIComponent(reviewId));
    fields = rest;
  }

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
