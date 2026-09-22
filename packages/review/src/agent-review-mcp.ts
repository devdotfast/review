import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ReviewMcpRegistration } from "@dev.fast/review-protocol";
import { writeFileAtomicAsync } from "@dev.fast/trace-core";
import { parse, stringify } from "smol-toml";
import { z } from "zod";

import { isMissingFileError } from "./fs-utils.js";
import { devReviewHome, reviewDesktopStateDir } from "./review-home-paths.js";

export const REVIEW_MCP_TARGETS = ["codex", "claude"] as const;

export function reviewMcpLauncher(env: NodeJS.ProcessEnv) {
  return path.join(reviewDesktopStateDir(env), "whiteboard-mcp");
}

export function reviewMcpRegistration(
  target: ReviewMcpRegistration["target"],
  homeDir: string,
  env: NodeJS.ProcessEnv,
): ReviewMcpRegistration {
  return {
    name: "whiteboard",
    target,
    configPath:
      target === "codex"
        ? path.resolve(homeDir, env.CODEX_HOME || ".codex", "config.toml")
        : env.CLAUDE_CONFIG_DIR
          ? path.resolve(homeDir, env.CLAUDE_CONFIG_DIR, ".claude.json")
          : path.join(homeDir, ".claude.json"),
    command: reviewMcpLauncher(env),
    args: ["mcp"],
    env: {
      DEV_WHITEBOARD_HOME: devReviewHome(env, homeDir),
      // Desktop integrations must not inherit a shell's headless selection.
      DEV_WHITEBOARD_SERVER_DIR: "",
      DEV_REVIEW_SERVER_DIR: "",
      DEV_FAST_REVIEW_CLI_NO_DELEGATE: "1",
    },
  };
}

function configuration(registration: ReviewMcpRegistration) {
  const { target, command, args, env } = registration;

  return target === "claude"
    ? { type: "stdio", command, args, env }
    : { command, args, env };
}

function serverName(registration: ReviewMcpRegistration) {
  return registration.name ?? "review";
}

function tomlBlock(registration: ReviewMcpRegistration) {
  const owner =
    serverName(registration) === "review" ? "Review Desktop" : "Whiteboard";

  return (
    `# BEGIN ${owner} MCP\n` +
    stringify({
      mcp_servers: { [serverName(registration)]: configuration(registration) },
    }) +
    `\n# END ${owner} MCP\n`
  );
}

const object = z.record(z.string(), z.unknown());

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
      : object.parse(JSON.parse(source || "{}"));

  const key = registration.target === "codex" ? "mcp_servers" : "mcpServers";
  const servers = object.parse(parsed[key] ?? {});

  return {
    source,
    parsed,
    key,
    servers,
    current: servers[serverName(registration)],
  };
}

function matches(
  config: Awaited<ReturnType<typeof readConfig>>,
  registration: ReviewMcpRegistration,
) {
  return (
    isDeepStrictEqual(
      config.servers[serverName(registration)],
      configuration(registration),
    ) &&
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
      : config.current === undefined ||
          (managed && previous && serverName(previous) === serverName(desired))
        ? "missing"
        : "custom";

    return { target: desired.target, state } as const;
  } catch {
    return {
      target: desired.target,
      state: "error",
      error: `Cannot read ${desired.configPath}. Fix its configuration, then reinstall the Whiteboard integration.`,
    } as const;
  }
}

/** Only edit our unchanged entry; preserve all unrelated settings and TOML comments. */
export async function writeReviewMcpRegistration(
  desired: ReviewMcpRegistration,
  previous?: ReviewMcpRegistration,
  remove = false,
): Promise<boolean> {
  const config = await readConfig(desired);

  const managed =
    previous?.configPath === desired.configPath && matches(config, previous);

  const sameName = previous && serverName(previous) === serverName(desired);

  if (
    config.current !== undefined &&
    !(managed && sameName) &&
    !matches(config, desired)
  )
    return false;

  if (remove && !managed) return false;

  if (!remove && matches(config, desired) && (!managed || sameName))
    return true;

  let next: string;

  if (desired.target === "codex") {
    next = config.source;

    if (managed) next = next.replace(tomlBlock(previous), "");

    if (matches(config, desired) && (!managed || !sameName))
      next = next.replace(tomlBlock(desired), "");

    if (!remove) next += `\n${tomlBlock(desired)}`;
    // Reject conflicting inline/dotted declarations before touching the file.
    parse(next);
  } else {
    if (managed) delete config.servers[serverName(previous)];

    if (!remove) config.servers[serverName(desired)] = configuration(desired);
    config.parsed[config.key] = config.servers;
    next = JSON.stringify(config.parsed, null, 2) + "\n";
  }

  if (next !== config.source) {
    // Do not overwrite a concurrent settings edit from the agent app.
    const latest = await readConfig(desired);

    if (latest.source !== config.source)
      throw new Error("Agent settings changed during Whiteboard setup. Retry.");
    await writeFileAtomicAsync(desired.configPath, next, { mode: 0o600 });
  }

  return true;
}
