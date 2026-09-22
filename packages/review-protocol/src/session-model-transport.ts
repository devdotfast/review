import { type JsonValue, isJsonObject } from "@dev.fast/json";

/** The saved/in-memory model keeps its old keys until its own migration. */
function renameId(value: JsonValue, from: string, to: string): JsonValue {
  if (!isJsonObject(value) || !(from in value)) return value;
  const { [from]: id, ...rest } = value;

  return { ...rest, [to]: id };
}

/** Map only known request envelopes, never authored document/resource fields. */
export function sessionModelRequest(
  route: string,
  value: JsonValue,
): JsonValue {
  const pathname = route.split("?")[0];

  if (!isJsonObject(value)) return value;

  if (pathname === "/commands" && "operation" in value)
    return {
      ...value,
      operation: renameId(value.operation, "reviewId", "sessionId"),
    };

  if (
    pathname?.startsWith("/draft-commands/") ||
    pathname === "/sharing/publish"
  )
    return renameId(value, "reviewId", "sessionId");

  if (pathname?.endsWith("/copy-context") && "apiSource" in value)
    return {
      ...value,
      apiSource: renameId(value.apiSource, "reviewId", "sessionId"),
    };

  return value;
}

function modelMetadata(value: JsonValue): JsonValue {
  return Array.isArray(value)
    ? value.map((item) => renameId(item, "sessionId", "reviewId"))
    : renameId(value, "sessionId", "reviewId");
}

/** Only routes that return session metadata use the model's historical names. */
export function sessionModelResponse(
  route: string,
  value: JsonValue,
): JsonValue {
  const pathname = route.split("?")[0] || "/";

  if (
    pathname === "/" ||
    /^\/[^/]+$/.test(pathname) ||
    /^\/(drafts|draft-commands)\/[^/]+$/.test(pathname) ||
    /^\/[^/]+\/workspaces(?:\/[^/]+\/retry)?$/.test(pathname) ||
    /^\/sharing\/import(?:\/[^/]+)?$/.test(pathname)
  )
    return modelMetadata(value);

  return value;
}

export function sessionModelWatch(
  value: JsonValue,
  multiplexed: boolean,
): JsonValue {
  if (!multiplexed || !Array.isArray(value)) return modelMetadata(value);

  return value.map((result) =>
    isJsonObject(result) && "value" in result
      ? { ...result, value: modelMetadata(result.value) }
      : result,
  );
}
