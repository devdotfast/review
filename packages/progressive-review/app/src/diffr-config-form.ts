import {
  type JsonObject,
  type JsonValue,
  isJsonArray,
  isJsonObject,
  isStringValue,
  jsonProperty,
  jsonString,
} from "@dev.fast/review-protocol";

/**
 * One editable diffr setting, flattened from the JSON Schema `diffr config
 * schema` prints. Nested objects become dotted keys, which is what `diffr
 * config set` takes.
 */
export interface DiffrConfigField {
  key: string;
  kind: "boolean" | "number" | "string" | "enum";
  description: string;
  default: JsonValue | undefined;
  choices: string[];
  value: JsonValue | undefined;
  /** Rendered as a password input and never echoed anywhere else. */
  secret: boolean;
}

const SECRET_KEY = /(^|[._])(api_key|token|secret|password)($|[._])/;

function schemaType(schema: JsonObject): string | undefined {
  const type = jsonProperty(schema, "type");
  if (isStringValue(type)) return type;
  // schemars writes nullable fields as ["string", "null"]; the first entry names the editor.
  if (isJsonArray(type)) {
    return jsonString(
      type.find((entry) => isStringValue(entry) && entry !== "null"),
    );
  }
  return undefined;
}

function valueAt(
  values: JsonObject,
  path: readonly string[],
): JsonValue | undefined {
  let current: JsonValue | undefined = values;
  for (const segment of path) {
    if (!isJsonObject(current)) return undefined;
    current = jsonProperty(current, segment);
  }
  return current;
}

/**
 * Flattens the schema into fields in declaration order, resolving each
 * field's current value. Keys the schema cannot describe as one of the four
 * editable kinds are left out rather than rendered as free text, since a
 * wrong write would be diffr's error to report, not the form's.
 */
export function diffrConfigFields(
  schema: JsonObject,
  values: JsonObject,
): DiffrConfigField[] {
  const fields: DiffrConfigField[] = [];
  const definitions =
    jsonProperty(schema, "$defs") ?? jsonProperty(schema, "definitions");
  function resolve(node: JsonObject): JsonObject {
    const reference = jsonString(jsonProperty(node, "$ref"));
    if (reference === undefined) return node;
    const name = reference.replace(/^#\/(\$defs|definitions)\//, "");
    const target = isJsonObject(definitions)
      ? jsonProperty(definitions, name)
      : undefined;
    if (!isJsonObject(target))
      throw new Error(
        `diffr schema references an unknown definition: ${reference}`,
      );
    return target;
  }
  function walk(node: JsonObject, path: readonly string[]) {
    const resolved = resolve(node);
    const properties = jsonProperty(resolved, "properties");
    if (isJsonObject(properties)) {
      for (const [name, child] of Object.entries(properties)) {
        if (isJsonObject(child)) walk(child, [...path, name]);
      }
      return;
    }
    if (path.length === 0) return;
    const key = path.join(".");
    const description = jsonString(jsonProperty(resolved, "description")) ?? "";
    const choices = jsonProperty(resolved, "enum");
    const enumChoices = isJsonArray(choices)
      ? choices.filter(isStringValue)
      : [];
    const type = schemaType(resolved);
    let kind: DiffrConfigField["kind"] | undefined;
    if (
      isJsonArray(choices) &&
      enumChoices.length === choices.length &&
      choices.length > 0
    )
      kind = "enum";
    else if (type === "boolean") kind = "boolean";
    else if (type === "integer" || type === "number") kind = "number";
    else if (type === "string") kind = "string";
    if (!kind) return;
    fields.push({
      key,
      kind,
      description,
      default: jsonProperty(resolved, "default"),
      choices: kind === "enum" ? enumChoices : [],
      value: valueAt(values, path),
      secret: SECRET_KEY.test(key),
    });
  }
  walk(schema, []);
  return fields;
}

/** The text shown beside a field for its shipped default. */
export function diffrConfigDefaultText(field: DiffrConfigField): string {
  if (field.default === undefined || field.default === null) return "";
  if (field.secret) return "";
  return isStringValue(field.default)
    ? field.default
    : JSON.stringify(field.default);
}

/** Parses what the user typed into the value `diffr config set` should receive. */
export function diffrConfigInputValue(
  field: DiffrConfigField,
  text: string,
): JsonValue {
  if (field.kind === "number") {
    const value = Number(text);
    if (text.trim() === "" || !Number.isFinite(value)) {
      throw new Error(`${field.key} must be a number.`);
    }
    return value;
  }
  return text;
}
