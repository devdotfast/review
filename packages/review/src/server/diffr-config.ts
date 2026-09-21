import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isStringValue,
  parseJsonText,
} from "@dev.fast/json";

import { invalidateStructuralComparisons } from "./structural-comparisons.js";
import { diffrExecutable, diffrMissingError } from "./structural-diff";

const execFileAsync = promisify(execFile);

/**
 * diffr's own configuration, read and written through its CLI so the TUI and
 * Review share one source of truth. `schema` is the JSON Schema `diffr config
 * schema` prints (every key carries `description` and `default`); `values` is
 * the resolved configuration from `diffr config show --json`.
 */
export interface DiffrConfig {
  schema: JsonObject;
  values: JsonObject;
}

async function diffr(
  args: readonly string[],
  rootPath?: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(diffrExecutable(), args, {
      cwd: rootPath,
      maxBuffer: 16 * 1024 * 1024,
      signal: AbortSignal.timeout(30_000),
    });

    return stdout;
  } catch (error) {
    // SAFETY: execFile rejects with the spawn or exit error it produced, which
    // carries `code` and, after a nonzero exit, the captured `stderr`.
    const failure = error as NodeJS.ErrnoException & { stderr?: string };

    if (failure.code === "ENOENT") throw diffrMissingError();
    throw new Error(
      `diffr ${args.join(" ")} failed: ${failure.stderr?.trim() || failure.message}`,
    );
  }
}

function jsonObjectOutput(text: string, what: string): JsonObject {
  const value = parseJsonText(text);

  if (!isJsonObject(value))
    throw new Error(`diffr ${what} did not print a JSON object.`);

  return value;
}

export async function readDiffrConfig(rootPath?: string): Promise<DiffrConfig> {
  const [schema, values] = await Promise.all([
    diffr(["config", "schema"], rootPath),
    diffr(["config", "show", "--json"], rootPath),
  ]);

  return {
    schema: jsonObjectOutput(schema, "config schema"),
    values: jsonObjectOutput(values, "config show"),
  };
}

/** The text form `diffr config set` accepts: scalars verbatim, anything else as JSON. */
export function diffrConfigValueText(value: JsonValue): string {
  return isStringValue(value) ? value : JSON.stringify(value);
}

export async function setDiffrConfigValue(
  key: string,
  value: JsonValue,
  rootPath?: string,
): Promise<DiffrConfig> {
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9_-]*(\.[A-Za-z0-9_][A-Za-z0-9_-]*)*$/.test(key)
  ) {
    throw new Error(`Invalid diffr config key: ${key}`);
  }

  await diffr(["config", "set", key, diffrConfigValueText(value)], rootPath);

  invalidateStructuralComparisons();

  return readDiffrConfig(rootPath);
}
