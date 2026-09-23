import {
  readHealthyWhiteboardDesktopDiscovery,
  readWhiteboardDesktopDiscovery,
} from "../desktop-discovery.js";
import {
  readWhiteboardServerDiscovery,
  serverNotReady,
  whiteboardServerIsHealthy,
  whiteboardServerStateDir,
} from "../server-discovery.js";
import { whiteboardDesktopDiscoveryPath } from "../whiteboard-home-paths.js";
import { SessionApiClient } from "./client.js";

export interface AuthoringTool {
  name: string;
  description: string;
  inputSchema: Tool["inputSchema"];
  method: "GET" | "POST";
  path: string;
  commandType?: string;
}

export async function connectSessionApi(env = process.env) {
  const apiPath = "/sessions-api";

  if (env.DEV_WHITEBOARD_SERVER_DIR?.trim()) {
    const stateDir = whiteboardServerStateDir(env);
    const server = await readWhiteboardServerDiscovery(stateDir);

    if (!server || !(await whiteboardServerIsHealthy(server)))
      throw serverNotReady(stateDir);

    return new SessionApiClient({
      serverUrl: server.url,
      token: server.token,
      apiPath,
    });
  }

  const discovery = await readHealthyWhiteboardDesktopDiscovery({
    readDiscovery: () =>
      readWhiteboardDesktopDiscovery(whiteboardDesktopDiscoveryPath(env)),
  });

  if (!discovery)
    throw new Error(
      "No Review Desktop server is ready. Run review app launch, or select a running headless server with --state-dir or DEV_WHITEBOARD_SERVER_DIR, then retry.",
    );

  return new SessionApiClient({
    serverUrl: discovery.url,
    token: discovery.token,
    apiPath,
  });
}

/** Only translate the tool envelope. The host owns validation and persistence. */
export async function callAuthoringTool(
  client: SessionApiClient,
  tool: AuthoringTool,
  input: NonNullable<CallToolRequest["params"]["arguments"]>,
  signal?: AbortSignal,
) {
  if (tool.commandType) {
    const { commandId, leaseId, ...fields } = input;

    return client.post<JsonValue>(
      tool.path,
      { commandId, leaseId, operation: { ...fields, type: tool.commandType } },
      signal,
    );
  }

  const fields = { ...input };

  const route = tool.path.replace(/:sessionId\b/g, () => {
    const value = fields.sessionId;

    if (!isStringValue(value) || !value)
      throw new Error("sessionId is required.");
    delete fields.sessionId;

    return encodeURIComponent(value);
  });

  if (tool.method === "POST")
    return client.post<JsonValue>(route, fields, signal);
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(fields)) {
    // Hosts often send null for an unused optional field; the route reads absence.
    if (value === null || value === undefined) continue;

    // Arrays travel as repeated keys, as in paths=a&paths=b.
    for (const item of Array.isArray(value) ? value : [value]) {
      if (!isStringValue(item) && !isNumberValue(item) && !isBooleanValue(item))
        throw new Error(
          `${key} must be a string, number, boolean or list of them.`,
        );

      query.append(key, String(item));
    }
  }

  const response = await client.response(
    route + (query.size ? `?${query}` : ""),
    { signal },
  );

  return response.headers.get("content-type")?.startsWith("text/plain")
    ? new ToolText(await response.text())
    : parseJsonText(await response.text());
}

/** A plain-text reply, shown to the agent as-is instead of as a JSON string. */
export class ToolText {
  constructor(readonly text: string) {}
}

/** The text an agent sees for a tool result. */
export function toolResultText(
  tool: Pick<AuthoringTool, "name">,
  result: JsonValue | ToolText,
) {
  if (result instanceof ToolText) return result.text;

  return tool.name === "session_get" && isStringValue(result)
    ? result
    : JSON.stringify(result);
}

import {
  isBooleanValue,
  isNumberValue,
  isStringValue,
  type JsonValue,
  parseJsonText,
} from "@dev.fast/json";
import type { CallToolRequest, Tool } from "@modelcontextprotocol/sdk/types.js";
