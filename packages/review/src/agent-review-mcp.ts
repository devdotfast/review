import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ReviewMcpRegistration } from "@dev.fast/review-protocol";
import { writeFileAtomicAsync } from "@dev.fast/trace-core";
import {
  type ParseError,
  applyEdits,
  modify,
  parse as parseJsonc,
} from "jsonc-parser";
import { parse, stringify } from "smol-toml";
import { z } from "zod";

import { isMissingFileError } from "./fs-utils.js";
import { devReviewHome, reviewDesktopStateDir } from "./review-home-paths.js";

export const REVIEW_MCP_TARGETS = [
  "codex",
  "claude",
  "cursor",
  "opencode",
] as const;

export function reviewMcpLauncher(env: NodeJS.ProcessEnv) {
  return path.join(reviewDesktopStateDir(env), "review-mcp");
}

export async function reviewMcpRegistration(
  target: ReviewMcpRegistration["target"],
  homeDir: string,
  env: NodeJS.ProcessEnv,
): Promise<ReviewMcpRegistration> {
  return {
    target,
    configPath: await configPath(target, homeDir, env),
    command: reviewMcpLauncher(env),
    args: ["mcp"],
    env: {
      DEV_REVIEW_HOME: devReviewHome(env, homeDir),
      // Desktop integrations must not inherit a shell's headless selection.
      DEV_REVIEW_SERVER_DIR: "",
      DEV_FAST_REVIEW_CLI_NO_DELEGATE: "1",
    },
  };
}

async function configPath(
  target: ReviewMcpRegistration["target"],
  homeDir: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (target === "codex")
    return path.resolve(homeDir, env.CODEX_HOME || ".codex", "config.toml");

  if (target === "cursor") return path.join(homeDir, ".cursor", "mcp.json");

  if (target === "opencode") {
    const directory = path.resolve(
      homeDir,
      env.XDG_CONFIG_HOME || ".config",
      "opencode",
    );

    let existing: string | undefined;

    // Prefer JSONC, but keep an existing Review entry in its original file.
    // Otherwise adding a JSONC file later could orphan our managed JSON entry
    // or override a user's custom server there.
    for (const name of ["opencode.jsonc", "opencode.json"]) {
      const file = path.join(directory, name);

      try {
        const source = await readFile(file, "utf8");
        existing ??= file;
        const servers = object.parse(jsonConfiguration(source).mcp ?? {});

        if (servers.review !== undefined) return file;
      } catch (error) {
        // Let status/install report malformed or unreadable settings normally.
        if (!isMissingFileError(error)) return file;
      }
    }

    return existing ?? path.join(directory, "opencode.json");
  }

  return env.CLAUDE_CONFIG_DIR
    ? path.resolve(homeDir, env.CLAUDE_CONFIG_DIR, ".claude.json")
    : path.join(homeDir, ".claude.json");
}

function configuration(registration: ReviewMcpRegistration) {
  const { target, command, args, env } = registration;

  if (target === "opencode")
    return {
      type: "local",
      command: [command, ...args],
      enabled: true,
      environment: env,
    };

  return target === "claude" || target === "cursor"
    ? { type: "stdio", command, args, env }
    : { command, args, env };
}

function tomlBlock(registration: ReviewMcpRegistration) {
  return (
    "# BEGIN Review Desktop MCP\n" +
    stringify({ mcp_servers: { review: configuration(registration) } }) +
    "\n# END Review Desktop MCP\n"
  );
}

const object = z.record(z.string(), z.unknown());

function jsonConfiguration(source: string) {
  const errors: ParseError[] = [];

  const parsed = parseJsonc(source || "{}", errors, {
    allowTrailingComma: true,
  });

  if (errors.length) throw new Error("Invalid MCP JSON configuration.");

  return object.parse(parsed);
}

async function readConfig(registration: ReviewMcpRegistration) {
  const source = await readFile(registration.configPath, "utf8").catch(
    (error) => {
      if (isMissingFileError(error)) return "";
      throw error;
    },
  );

  const parsed =
    registration.target === "codex"
      ? parse(source, { integersAsBigInt: "asNeeded" })
      : registration.target === "claude"
        ? object.parse(JSON.parse(source || "{}"))
        : jsonConfiguration(source);

  const key =
    registration.target === "codex"
      ? "mcp_servers"
      : registration.target === "opencode"
        ? "mcp"
        : "mcpServers";

  const servers = object.parse(parsed[key] ?? {});

  return { source, parsed, key, servers, current: servers.review };
}

function matches(
  config: Awaited<ReturnType<typeof readConfig>>,
  registration: ReviewMcpRegistration,
) {
  return (
    isDeepStrictEqual(config.current, configuration(registration)) &&
    (registration.target !== "codex" ||
      config.source.includes(tomlBlock(registration)))
  );
}

export async function reviewMcpStatus(
  desired: ReviewMcpRegistration,
  previous?: ReviewMcpRegistration,
) {
  try {
    const config = await readConfig(desired);

    const managed =
      previous?.configPath === desired.configPath && matches(config, previous);

    const state = matches(config, desired)
      ? "ready"
      : config.current === undefined || managed
        ? "missing"
        : "custom";

    return { target: desired.target, state } as const;
  } catch {
    return {
      target: desired.target,
      state: "error",
      error: `Cannot read ${desired.configPath}. Fix its configuration, then reinstall the Review integration.`,
    } as const;
  }
}

/** Only edit our unchanged entry; preserve unrelated settings and comments. */
export async function writeReviewMcpRegistration(
  desired: ReviewMcpRegistration,
  previous?: ReviewMcpRegistration,
  remove = false,
): Promise<boolean> {
  const config = await readConfig(desired);

  const managed =
    previous?.configPath === desired.configPath && matches(config, previous);

  if (config.current !== undefined && !managed && !matches(config, desired))
    return false;

  if (remove && !managed) return false;

  if (!remove && matches(config, desired)) return true;

  let next: string;

  if (desired.target === "codex") {
    next = config.source;

    if (managed) next = next.replace(tomlBlock(previous), "");
    else if (matches(config, desired))
      next = next.replace(tomlBlock(desired), "");

    if (!remove) next += `\n${tomlBlock(desired)}`;
    // Reject conflicting inline/dotted declarations before touching the file.
    parse(next);
  } else if (desired.target === "claude") {
    if (remove) delete config.servers.review;
    else config.servers.review = configuration(desired);
    config.parsed[config.key] = config.servers;
    next = JSON.stringify(config.parsed, null, 2) + "\n";
  } else {
    next =
      config.source ||
      (desired.target === "opencode"
        ? '{\n  "$schema": "https://opencode.ai/config.json"\n}\n'
        : "{}\n");
    next = applyEdits(
      next,
      modify(
        next,
        [config.key, "review"],
        remove ? undefined : configuration(desired),
        { formattingOptions: { insertSpaces: true, tabSize: 2 } },
      ),
    );
    jsonConfiguration(next);
  }

  if (next !== config.source) {
    // Do not overwrite a concurrent settings edit from the agent app.
    const latest = await readConfig(desired);

    if (latest.source !== config.source)
      throw new Error("Agent settings changed during Review setup. Retry.");
    await writeFileAtomicAsync(desired.configPath, next, { mode: 0o600 });
  }

  return true;
}
