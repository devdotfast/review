import { existsSync } from "node:fs";
import { delimiter, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type JsonValue,
  isJsonObject,
  jsonString,
} from "@dev.fast/review-protocol";

import { writePathShim } from "../server/cli-install";

export const REVIEW_AGENT_HOOK_URL_ENV = "DEV_FAST_REVIEW_AGENT_HOOK_URL";
export const REVIEW_AGENT_HOOK_TOKEN_ENV = "DEV_FAST_REVIEW_AGENT_HOOK_TOKEN";
export const REVIEW_AGENT_THREAD_URL_ENV = "DEV_FAST_REVIEW_AGENT_THREAD_URL";

/**
 * Exposes the `review` CLI to native agent terminals through a PATH shim.
 * The shim is written once per runtime directory and reused for every launch.
 */
export class ReviewCommandPath {
  #directory: Promise<string | undefined> | undefined;

  constructor(
    private readonly input: {
      runtimeDirectory: string;
      reviewCliPath?: string;
      reviewCliRuntimePath?: string;
    },
  ) {}

  /** PATH for a native agent terminal, or undefined to inherit the caller's. */
  async resolve(): Promise<string | undefined> {
    const commandDirectory = await this.#prepare();
    const inheritedPath = process.env.PATH;
    if (!commandDirectory) return inheritedPath;
    return inheritedPath
      ? `${commandDirectory}${delimiter}${inheritedPath}`
      : commandDirectory;
  }

  #prepare(): Promise<string | undefined> {
    const reviewCliPath = this.input.reviewCliPath;
    if (!reviewCliPath) return Promise.resolve(undefined);
    this.#directory ??= (async () => {
      const commandDirectory = join(this.input.runtimeDirectory, "bin");
      await writePathShim(
        join(commandDirectory, "review"),
        reviewCliPath,
        this.input.reviewCliRuntimePath,
      );
      return commandDirectory;
    })();
    return this.#directory;
  }
}

/** Path of a sibling module that native agents load directly (hook client, extension). */
export function companionModulePath(name: string): string {
  const currentPath = fileURLToPath(import.meta.url);
  const extension = extname(currentPath) === ".ts" ? ".ts" : ".js";
  const direct = join(dirname(currentPath), `${name}${extension}`);
  if (extension === ".ts" || existsSync(direct)) return direct;
  return join(dirname(currentPath), "native-agent", `${name}${extension}`);
}

/** Shell command that runs the native hook client under this Node runtime. */
export function nativeHookCommand(): string {
  const modulePath = companionModulePath("native-hook-client");
  const nodeArgs =
    extname(modulePath) === ".ts"
      ? [
          process.execPath,
          "--import",
          fileURLToPath(import.meta.resolve("tsx/esm")),
          modulePath,
        ]
      : [process.execPath, modulePath];
  const command =
    process.versions.electron === undefined
      ? nodeArgs
      : ["/usr/bin/env", "ELECTRON_RUN_AS_NODE=1", ...nodeArgs];
  return command.map(shellQuote).join(" ");
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Serialize a value as an inline TOML literal for `codex -c key=value`. */
export function tomlInline(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(tomlInline).join(", ")}]`;
  }
  if (isJsonObject(value)) {
    return `{ ${Object.entries(value)
      .map(([key, entry]) => {
        const name = /^[A-Za-z0-9_-]+$/u.test(key) ? key : JSON.stringify(key);
        return `${name} = ${tomlInline(entry)}`;
      })
      .join(", ")} }`;
  }
  if (value === null) {
    throw new TypeError("Codex hook configuration contains an invalid value.");
  }
  const text = jsonString(value);
  return text === undefined ? String(value) : JSON.stringify(text);
}
