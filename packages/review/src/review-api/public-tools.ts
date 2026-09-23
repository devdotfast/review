import { type JsonValue, isJsonObject, isStringValue } from "@dev.fast/json";

import {
  type AuthoringTool,
  ToolText,
  callAuthoringTool,
} from "./agent-client.js";
import type { ReviewApiClient } from "./client.js";

function publicDescription(text: string): string {
  return text
    .replace(/\breview_(\w+)/g, "session_$1")
    .replace(/\breviewId\b/g, "sessionId")
    .replace(/\bReview\b/g, "Whiteboard")
    .replace("The result carries review,", "The result carries session,");
}

/** Rewrite schema prose without changing property names, enum values or examples. */
function translateSchemaDescriptions(value: JsonValue): void {
  if (Array.isArray(value)) {
    value.forEach(translateSchemaDescriptions);

    return;
  }

  if (!isJsonObject(value)) return;

  for (const [key, item] of Object.entries(value)) {
    if (key === "description" && isStringValue(item))
      value[key] = publicDescription(item);
    else if (!["examples", "default", "const", "enum"].includes(key))
      translateSchemaDescriptions(item);
  }
}

/** Public vocabulary belongs to the agent boundary, not stored documents. */
export function publicTool(tool: AuthoringTool): AuthoringTool {
  const inputSchema = structuredClone(tool.inputSchema);

  if (isJsonObject(inputSchema)) translateSchemaDescriptions(inputSchema);

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
    description: publicDescription(tool.description),
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
