import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { isJsonObject, parseJsonText } from "@dev.fast/review-protocol";

import { devReviewHome } from "./review-storage";
import { withFileLock } from "./with-file-lock";

export interface EnsureBundledToolInput {
  tool: string;
  sourcePath?: string;
  env?: NodeJS.ProcessEnv;
}

export type EnsureBundledToolResult = "staged" | "fresh" | "no-source";

interface ReviewToolIdentity {
  tool: string;
  platform: string;
  sha256: string;
}

export function reviewToolsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(devReviewHome(env), "review-tools");
}

export async function ensureBundledTool(
  input: EnsureBundledToolInput,
): Promise<EnsureBundledToolResult> {
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(input.tool)) {
    throw new Error(`Invalid bundled tool name: ${input.tool}`);
  }
  const sourcePath = input.sourcePath?.trim();
  if (!sourcePath) return "no-source";
  const source = path.resolve(sourcePath);
  if (!(await isExecutableFile(source))) return "no-source";

  const env = input.env ?? process.env;
  const platform = reviewToolPlatform();
  const executable = stagedToolPath(env, input.tool, platform);
  const destination = path.dirname(executable);
  const sha256 = await hashFile(source);
  const identity: ReviewToolIdentity = {
    tool: input.tool,
    platform,
    sha256,
  };
  if (installedToolMatches(destination, executable, identity)) return "fresh";

  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  return await withInstallLock(destination, async () => {
    if (installedToolMatches(destination, executable, identity)) return "fresh";
    const staging = `${destination}.staging-${process.pid}-${randomBytes(6).toString("hex")}`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      const stagedExecutable = path.join(
        staging,
        executableName(input.tool, platform),
      );
      await copyFile(source, stagedExecutable);
      if ((await hashFile(stagedExecutable)) !== sha256) {
        throw new Error(
          `The bundled ${input.tool} source changed while Review staged it.`,
        );
      }
      await chmod(stagedExecutable, 0o755);
      await writeToolStamp(staging, identity);
      await rm(destination, { recursive: true, force: true });
      await rename(staging, destination);
      return "staged";
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}

export async function ensureBundledRustAnalyzer(
  input: { env?: NodeJS.ProcessEnv } = {},
): Promise<EnsureBundledToolResult> {
  const env = input.env ?? process.env;
  return await ensureBundledTool({
    tool: "rust-analyzer",
    sourcePath: env.DEV_FAST_REVIEW_RUST_ANALYZER,
    env,
  });
}

export function stagedToolPath(
  env: NodeJS.ProcessEnv,
  tool: string,
  platform = reviewToolPlatform(),
): string {
  return path.join(
    reviewToolsRoot(env),
    tool,
    "bundled",
    platform,
    executableName(tool, platform),
  );
}

const INSTALL_LOCK_RETRY_MS = 100;
const INSTALL_LOCK_STALE_MS = 30 * 60_000;
const INSTALL_LOCK_TIMEOUT_MS = 120_000;
const INSTALL_LOCK_UNOWNED_GRACE_MS = 1_000;
const INSTALL_LOCK_HEARTBEAT_MS = 30_000;

async function withInstallLock<T>(
  destination: string,
  operation: () => Promise<T>,
): Promise<T> {
  const outcome = await withFileLock(
    `${destination}.install-lock`,
    {
      retryMs: INSTALL_LOCK_RETRY_MS,
      staleMs: INSTALL_LOCK_STALE_MS,
      timeoutMs: INSTALL_LOCK_TIMEOUT_MS,
      unownedGraceMs: INSTALL_LOCK_UNOWNED_GRACE_MS,
      heartbeatMs: INSTALL_LOCK_HEARTBEAT_MS,
    },
    operation,
  );
  if (!outcome.acquired) {
    throw new Error(
      `Timed out waiting for another Review process to install ${path.basename(destination)}.`,
    );
  }
  return outcome.result;
}

function installedToolMatches(
  destination: string,
  executable: string,
  identity: ReviewToolIdentity,
): boolean {
  if (!isExecutable(executable)) return false;
  try {
    const stamp = parseJsonText(
      fs.readFileSync(path.join(destination, "review-tool.json"), "utf8"),
    );
    return (
      isJsonObject(stamp) &&
      stamp.tool === identity.tool &&
      stamp.platform === identity.platform &&
      stamp.sha256 === identity.sha256
    );
  } catch {
    return false;
  }
}

async function writeToolStamp(
  destination: string,
  identity: ReviewToolIdentity,
): Promise<void> {
  await writeFile(
    path.join(destination, "review-tool.json"),
    `${JSON.stringify(identity, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function reviewToolPlatform(): string {
  const platform =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : process.platform;
  return `${platform}-${process.arch}`;
}

function executableName(name: string, platform: string): string {
  return platform.startsWith("win32-") ? `${name}.exe` : name;
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  const metadata = await stat(filePath).catch(() => undefined);
  return Boolean(metadata?.isFile() && isExecutable(filePath));
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(
    fs.createReadStream(filePath),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback();
      },
    }),
  );
  return hash.digest("hex");
}
