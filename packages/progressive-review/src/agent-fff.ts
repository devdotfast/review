import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  type JsonValue,
  type ReviewFffInstallTarget,
  type ReviewFffManagedRegistration,
  isJsonArray,
  isJsonObject,
  jsonArray,
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";

import { isFile } from "./fs-utils";

export const FFF_SERVER_NAME = "fff";
export const FFF_INSTALL_URL = "https://dmtrkovalenko.dev/install-fff-mcp.sh";
export const FFF_TARGETS: ReviewFffInstallTarget[] = ["claude", "codex", "pi"];
export const PI_FFF_PACKAGE = "npm:@ff-labs/pi-fff";

const execFileAsync = promisify(execFile);

export function fffBinaryPath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".local", "bin", "fff-mcp");
}

export function fffCorpusRoot(homeDir = os.homedir()): string {
  return path.join(homeDir, ".dev", "trace-search");
}

export function isFffTarget(target: string): target is ReviewFffInstallTarget {
  return target === "claude" || target === "codex" || target === "pi";
}

export async function installFffForTargets(input: {
  targets: ReviewFffInstallTarget[];
  homeDir: string;
  env: NodeJS.ProcessEnv;
  write: (text: string) => void;
}): Promise<{ ok: boolean; created: ReviewFffManagedRegistration[] }> {
  const binaryPath = fffBinaryPath(input.homeDir);
  const corpusRoot = fffCorpusRoot(input.homeDir);
  await mkdir(corpusRoot, { recursive: true });

  const missingTargets: ReviewFffInstallTarget[] = [];
  for (const target of input.targets) {
    const current = await readFffRegistration(target, input.homeDir, input.env);
    if (current.present) {
      input.write(`[ok] existing ${fffTargetLabel(target)} left unchanged\n`);
    } else {
      missingTargets.push(target);
    }
  }
  if (missingTargets.length === 0) {
    return { ok: true, created: [] };
  }

  const needsMcpBinary = missingTargets.some((target) => target !== "pi");
  if (needsMcpBinary && !(await isFile(binaryPath))) {
    input.write("Installing FFF MCP…\n");
    const installer = await runCommand(
      "/bin/bash",
      ["-c", `set -o pipefail; curl -fL ${FFF_INSTALL_URL} | bash`],
      input.homeDir,
      input.env,
    );
    input.write(installer.output);
    if (!installer.ok || !(await isFile(binaryPath))) {
      input.write(`FFF MCP was not installed at ${binaryPath}.\n`);
      return { ok: false, created: [] };
    }
  } else if (needsMcpBinary) {
    input.write(`[ok] FFF MCP binary found at ${binaryPath}\n`);
  }

  const created: ReviewFffManagedRegistration[] = [];
  for (const target of missingTargets) {
    const registration = fffRegistration(target, binaryPath, corpusRoot);
    const result = await runCommand(
      registration.command,
      registration.args,
      input.homeDir,
      input.env,
    );
    input.write(result.output);
    if (!result.ok) return { ok: false, created };
    created.push(registration);
    input.write(`[ok] installed ${fffTargetLabel(target)}\n`);
  }
  return { ok: true, created };
}

export async function readFffRegistration(
  target: ReviewFffInstallTarget,
  homeDir: string,
  env: NodeJS.ProcessEnv,
): Promise<{ present: boolean; output: string }> {
  if (target === "pi") {
    const present = await isPiFffInstalled(homeDir, env);
    return { present, output: present ? PI_FFF_PACKAGE : "" };
  }
  const result = await runCommand(
    target,
    target === "codex"
      ? ["mcp", "get", FFF_SERVER_NAME, "--json"]
      : ["mcp", "get", FFF_SERVER_NAME],
    homeDir,
    env,
  );
  return { present: result.ok, output: result.output };
}

export function fffRegistration(
  target: ReviewFffInstallTarget,
  binaryPath: string,
  corpusRoot: string,
): ReviewFffManagedRegistration {
  if (target === "pi") {
    return {
      target,
      command: "pi",
      args: ["install", PI_FFF_PACKAGE],
    };
  }
  return target === "claude"
    ? {
        target,
        command: "claude",
        args: [
          "mcp",
          "add",
          "-s",
          "user",
          FFF_SERVER_NAME,
          "--",
          binaryPath,
          corpusRoot,
        ],
      }
    : {
        target,
        command: "codex",
        args: ["mcp", "add", FFF_SERVER_NAME, "--", binaryPath, corpusRoot],
      };
}

export function fffRegistrationMatches(
  output: string,
  registration: ReviewFffManagedRegistration,
): boolean {
  if (registration.target === "pi") {
    return output.trim() === PI_FFF_PACKAGE;
  }
  const binaryPath = registration.args.at(-2);
  const corpusRoot = registration.args.at(-1);
  if (!binaryPath || !corpusRoot) return false;

  if (registration.target === "codex") {
    try {
      const config = findStdioConfig(parseJsonText(output));
      return (
        config?.command === binaryPath &&
        config.args.length === 1 &&
        config.args[0] === corpusRoot
      );
    } catch {
      return false;
    }
  }

  const lines = output.split("\n").map((line) => line.trim());
  const command = readLabeledValue(lines, "Command");
  const args =
    readLabeledValue(lines, "Args") ?? readLabeledValue(lines, "Arguments");
  return command === binaryPath && args === corpusRoot;
}

export async function removeFffRegistration(
  target: ReviewFffInstallTarget,
  homeDir: string,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; output: string }> {
  const command =
    target === "pi"
      ? { command: "pi", args: ["remove", PI_FFF_PACKAGE] }
      : target === "claude"
        ? {
            command: "claude",
            args: ["mcp", "remove", "-s", "user", FFF_SERVER_NAME],
          }
        : {
            command: "codex",
            args: ["mcp", "remove", FFF_SERVER_NAME],
          };
  return runCommand(command.command, command.args, homeDir, env);
}

async function isPiFffInstalled(
  homeDir: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const configured = env.PI_CODING_AGENT_DIR;
  const agentDir = configured
    ? path.resolve(homeDir, configured)
    : path.join(homeDir, ".pi", "agent");
  try {
    const settings = jsonObject(
      parseJsonText(
        await readFile(path.join(agentDir, "settings.json"), "utf8"),
      ),
    );
    const packages = jsonArray(settings?.packages);
    return packages !== undefined && packages.includes(PI_FFF_PACKAGE);
  } catch {
    return false;
  }
}

function fffTargetLabel(target: ReviewFffInstallTarget): string {
  return target === "pi"
    ? `Pi extension ${PI_FFF_PACKAGE}`
    : `${target} fff MCP`;
}

function findStdioConfig(
  value: JsonValue,
): { command: string; args: string[] } | null {
  if (!isJsonObject(value)) return null;
  const command = jsonString(value.command);
  const args = isJsonArray(value.args) ? value.args : undefined;
  if (command !== undefined && args !== undefined) {
    const argStrings = args.flatMap((arg) => jsonString(arg) ?? []);
    if (argStrings.length === args.length) {
      return { command, args: argStrings };
    }
  }
  for (const child of Object.values(value)) {
    const found = findStdioConfig(child);
    if (found) return found;
  }
  return null;
}

function readLabeledValue(lines: string[], label: string): string | null {
  const prefix = `${label}:`;
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  if (!line) return null;
  return line
    .slice(prefix.length)
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

async function runCommand(
  command: string,
  args: string[],
  homeDir: string,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; output: string }> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: homeDir,
      env: { ...env, HOME: homeDir },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
    });
    return { ok: true, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    // SAFETY: execFile rejects with an Error whose stdout and stderr fields
    // hold the child's output as strings; every field is read as optional so
    // any other rejection still yields a message.
    const failure = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      ok: false,
      output: `${failure.stdout ?? ""}${failure.stderr ?? failure.message ?? ""}`,
    };
  }
}
