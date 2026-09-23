import { type JsonValue, isJsonObject } from "@dev.fast/json";

import {
  type AuthoringTool,
  ToolText,
  callAuthoringTool,
} from "./agent-client.js";
import type { ReviewApiClient } from "./client.js";

/** Public vocabulary belongs to the agent boundary, not stored documents. */
export function publicTool(tool: AuthoringTool): AuthoringTool {
  const inputSchema = { ...tool.inputSchema };

  inputSchema.properties = Object.fromEntries(
    Object.entries(inputSchema.properties ?? {}).map(([key, value]) => [
      key === "reviewId" ? "sessionId" : key,
      value,
    ]),
  );

  if (inputSchema.required)
    inputSchema.required = inputSchema.required.map((key) =>
      key === "reviewId" ? "sessionId" : key,
    );

  return {
    ...tool,
    name: tool.name.replace(/^review_/, "session_"),
    description: tool.description
      .replace(/\breview_(\w+)/g, "session_$1")
      .replace(/\breviewId\b/g, "sessionId")
      .replace(/\bReview\b/g, "Whiteboard"),
    inputSchema,
  };
}

/** Translate known response envelopes only; authored content is opaque. */
export function publicResult(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(publicResult);

  if (!isJsonObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const name =
        key === "reviewId"
          ? "sessionId"
          : key === "review"
            ? "session"
            : key === "reviews"
              ? "sessions"
              : key;

      return [
        name,
        key === "review" || key === "reviews" ? publicResult(item) : item,
      ];
    }),
  );
}

export async function callPublicTool(
  client: ReviewApiClient,
  tool: AuthoringTool,
  input: Parameters<typeof callAuthoringTool>[2],
  signal?: AbortSignal,
) {
  if ("reviewId" in input) throw new Error("Use sessionId with session tools.");
  const { sessionId, ...rest } = input;

  const fields: Parameters<typeof callAuthoringTool>[2] = { ...rest };

  if (sessionId !== undefined) fields.reviewId = sessionId;
  const result = await callAuthoringTool(client, tool, fields, signal);

  return result instanceof ToolText ? result : publicResult(result);
}
