import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isStringValue,
  parseJsonText,
} from "@dev.fast/json";
import {
  type WhiteboardDiffrConfig,
  type WhiteboardDiffrSummarizerInput,
  decodeStructuralDiffEvent,
  whiteboardDiffrSummarizerInputSchema,
} from "@dev.fast/whiteboard-protocol";
import { stringify } from "smol-toml";

import { invalidateStructuralComparisons } from "./structural-comparisons.js";
import { diffrExecutable, diffrMissingError } from "./structural-diff";

const execFileAsync = promisify(execFile);

let writes: Promise<unknown> = Promise.resolve();

let testing = false;

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const next = writes.then(operation, operation);
  writes = next.catch(() => {});

  return next;
}

async function diffr(
  args: string[],
  rootPath?: string,
  options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(diffrExecutable(), args, {
      cwd: rootPath,
      maxBuffer: 16 * 1024 * 1024,
      signal: options.signal ?? AbortSignal.timeout(30_000),
      env: options.env ?? process.env,
    });

    return stdout;
  } catch (error) {
    // SAFETY: execFile rejects with an Error carrying its exit or spawn code.
    // Do not forward its message: it includes command arguments.
    const failure = error as NodeJS.ErrnoException;

    if (failure.code === "ENOENT") throw diffrMissingError();

    if (failure.name === "AbortError")
      throw new Error("diffr timed out or was cancelled.");
    throw new Error(
      "diffr could not complete the operation. Check its configuration and credentials.",
    );
  }
}

async function values(
  rootPath?: string,
  reveal = false,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const output = await diffr(
    ["config", "show", "--json", ...(reveal ? ["--reveal"] : [])],
    rootPath,
    { signal },
  );

  try {
    const parsed = parseJsonText(output);

    if (isJsonObject(parsed)) return parsed;
  } catch {
    /* Do not echo config contents in parse errors. */
  }

  throw new Error("diffr configuration response is malformed.");
}

function valueAt(object: JsonObject, key: string): JsonValue | undefined {
  let value: JsonValue | undefined = object;

  for (const segment of key.split("."))
    value = isJsonObject(value) ? value[segment] : undefined;

  return value;
}

const prefix = "plugins.bundled.summarize";

function environmentKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined;
}

async function read(rootPath?: string): Promise<WhiteboardDiffrConfig> {
  const config = await values(rootPath);
  const saved = valueAt(config, `${prefix}.api_key`);

  const credentialSource =
    isStringValue(saved) && saved.length > 0
      ? "config"
      : environmentKey()
        ? "environment"
        : "missing";

  const plugins = config.plugins;

  if (isJsonObject(plugins)) {
    for (const namespace of Object.values(plugins)) {
      if (!isJsonObject(namespace)) continue;

      for (const plugin of Object.values(namespace)) {
        if (isJsonObject(plugin)) delete plugin.api_key;
      }
    }
  }

  return { values: config, credentialSource };
}

export function readDiffrConfig(
  rootPath?: string,
): Promise<WhiteboardDiffrConfig> {
  return serialized(() => read(rootPath));
}

export function diffrConfigValueText(value: JsonValue): string {
  return isStringValue(value) ? value : JSON.stringify(value);
}

async function writeSettings(
  entries: [string, JsonValue][],
  rootPath?: string,
): Promise<WhiteboardDiffrConfig> {
  let changed = false;
  let error: string | undefined;
  const current = await values(rootPath);

  try {
    for (const [key, value] of entries) {
      if (valueAt(current, key) === value) continue;
      await diffr(
        ["config", "set", key, diffrConfigValueText(value)],
        rootPath,
      );
      changed = true;
    }
  } catch {
    error = changed
      ? "Some settings were saved before diffr rejected a change. Check the current values and try again."
      : "diffr could not save the setting. Check its configuration and the entered value.";
  } finally {
    if (changed) invalidateStructuralComparisons();
  }

  return { ...(await read(rootPath)), changed, error };
}

export function setDiffrConfigValue(
  key: string,
  value: JsonValue,
  rootPath?: string,
): Promise<WhiteboardDiffrConfig> {
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9_-]*(\.[A-Za-z0-9_][A-Za-z0-9_-]*)*$/.test(key)
  ) {
    throw new Error("Invalid diffr config key.");
  }

  return serialized(() => writeSettings([[key, value]], rootPath));
}

export function saveDiffrSummarizer(
  input: WhiteboardDiffrSummarizerInput,
  rootPath?: string,
): Promise<WhiteboardDiffrConfig> {
  const parsed = whiteboardDiffrSummarizerInputSchema.safeParse(input);

  if (!parsed.success) throw new Error("Invalid summary settings.");
  const draft = parsed.data;

  return serialized(async () => {
    const current = await read(rootPath);

    if (
      draft.enabled &&
      !draft.apiKey &&
      current.credentialSource === "missing"
    ) {
      return {
        ...current,
        changed: false,
        error: "Add a Gemini API key before enabling summaries.",
      };
    }

    const entries: [string, JsonValue][] = [];

    if (!draft.enabled) entries.push([`${prefix}.enabled`, false]);

    if (draft.apiKey) entries.push([`${prefix}.api_key`, draft.apiKey]);
    entries.push(
      [`${prefix}.model`, draft.model],
      [`${prefix}.tests`, draft.tests],
    );

    if (draft.enabled) entries.push([`${prefix}.enabled`, true]);

    return writeSettings(entries, rootPath);
  });
}

export async function testDiffrSummarizer(
  input: WhiteboardDiffrSummarizerInput,
  rootPath?: string,
  signal?: AbortSignal,
): Promise<string> {
  const parsed = whiteboardDiffrSummarizerInputSchema.safeParse(input);

  if (!parsed.success) throw new Error("Invalid summary settings.");

  if (testing) throw new Error("A summary test is already running.");
  testing = true;
  const timeout = AbortSignal.timeout(60_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let directory: string | undefined;

  try {
    const config = await serialized(() => values(rootPath, true, deadline));
    const saved = valueAt(config, prefix);

    if (!isJsonObject(saved))
      throw new Error("The summarizer is not available in this configuration.");

    const apiKey =
      parsed.data.apiKey ||
      (isStringValue(saved.api_key) ? saved.api_key : undefined) ||
      environmentKey();

    if (!apiKey) throw new Error("Add a Gemini API key to test summaries.");
    directory = await mkdtemp(join(tmpdir(), "review-summary-"));

    const options: JsonObject = {
      ...saved,
      enabled: true,
      model: parsed.data.model,
      min_lines: 1,
      retries: 0,
      request_timeout_ms: 45_000,
    };

    delete options.api_key;
    const configPath = join(directory, "config.toml");
    await writeFile(
      configPath,
      stringify({
        version: 1,
        plugins: {
          order: ["bundled.summarize"],
          bundled: { summarize: options },
        },
      }),
      { mode: 0o600 },
    );

    const before = join(directory, "before.rs"),
      after = join(directory, "after.rs");

    await writeFile(before, "");
    await writeFile(after, SUMMARY_SAMPLE);

    const output = await diffr(
      [
        "--config",
        configPath,
        "--no-index",
        "--format",
        "ndjson",
        "--stream-annotations",
        "--",
        before,
        after,
      ],
      directory,
      {
        env: { ...process.env, GEMINI_API_KEY: apiKey, GOOGLE_API_KEY: "" },
        signal: deadline,
      },
    );

    try {
      const events = output.trim().split("\n").map(decodeStructuralDiffEvent);
      const complete = events.at(-1);

      const annotation = events
        .flatMap((event) =>
          event.type === "annotations" ? event.annotations : [],
        )
        .find((item) => item.label.trim());

      if (
        complete?.type === "complete" &&
        complete.failed === 0 &&
        !complete.aborted &&
        !events.some(
          (event) =>
            (event.type === "annotations" || event.type === "file") &&
            event.error,
        ) &&
        annotation
      ) {
        return annotation.label.split(apiKey).join("[redacted]");
      }
    } catch {
      /* Never return provider output or parser causes. */
    }

    throw new Error(
      "No summary was produced. Check the API key, model, and network connection.",
    );
  } finally {
    testing = false;

    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

const SUMMARY_SAMPLE = `pub fn count_values(values: &[i32]) -> (i32, i32) {
    let mut total = 0;
    let mut count = 0;
    for value in values {
        if *value > 0 {
            total += value;
            count += 1;
        }
    }
    let average = if count > 0 {
        total / count
    } else {
        0
    };
    (count, average)
}
`;
