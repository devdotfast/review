/**
 * JSON values as they come off the wire or out of a file. Parse into one of
 * these at the I/O boundary, then narrow into a domain type; never carry an
 * `unknown`-valued dictionary past the boundary.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonArray(value: unknown): value is JsonArray {
  return Array.isArray(value);
}

/** Parses JSON text into a JsonValue; throws SyntaxError on malformed input. */
export function parseJsonText(text: string): JsonValue {
  // SAFETY: JSON.parse only ever produces JSON primitives, arrays, and plain
  // objects, which is exactly the JsonValue union.
  return JSON.parse(text) as JsonValue;
}

/** Reads one property of a JSON object; missing keys read as undefined. */
export function jsonProperty(
  value: JsonObject,
  key: string,
): JsonValue | undefined {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}
