import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type JsonValue,
  REVIEW_DESKTOP_DISCOVERY_VERSION,
  type ReviewDesktopDiscovery,
  isJsonObject,
  jsonNumber,
  jsonProperty,
  parseJsonText,
  parseReviewDesktopDiscovery,
} from "@dev.fast/review-protocol";

import {
  reviewDefaultInstancePath,
  reviewDevInstanceKey,
  reviewInstancesDir,
  reviewLegacyDiscoveryPath,
} from "./review-home-paths";

export class ReviewDesktopProtocolMismatchError extends Error {
  readonly name = "ReviewDesktopProtocolMismatchError";

  constructor(
    readonly actualVersion: number,
    readonly expectedVersion = REVIEW_DESKTOP_DISCOVERY_VERSION,
  ) {
    super(
      `Review Desktop uses protocol ${actualVersion}, but this Review CLI needs protocol ${expectedVersion}. Update Review and Review Desktop to compatible versions, then try again.`,
    );
  }
}

export class ReviewDesktopDiscoveryUnreadableError extends Error {
  readonly name = "ReviewDesktopDiscoveryUnreadableError";

  constructor(filePath: string, detail?: string) {
    super(
      `Review Desktop discovery is unreadable at ${filePath}. Restart Review Desktop and try again.${detail ? ` ${detail}` : ""}`,
    );
  }
}

/** One record, or null when the file does not exist. */
export async function readReviewDesktopDiscoveryFile(
  filePath: string,
): Promise<ReviewDesktopDiscovery | null> {
  let source: string;

  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw new ReviewDesktopDiscoveryUnreadableError(filePath, String(error));
  }

  let value: JsonValue;

  try {
    value = parseJsonText(source);
  } catch (error) {
    throw new ReviewDesktopDiscoveryUnreadableError(filePath, String(error));
  }

  try {
    return parseReviewDesktopDiscovery(value);
  } catch (error) {
    const version = isJsonObject(value)
      ? jsonNumber(jsonProperty(value, "version"))
      : undefined;

    if (
      version !== undefined &&
      Number.isInteger(version) &&
      version !== REVIEW_DESKTOP_DISCOVERY_VERSION
    ) {
      throw new ReviewDesktopProtocolMismatchError(version);
    }

    throw new ReviewDesktopDiscoveryUnreadableError(filePath, String(error));
  }
}

export async function isHealthyReviewDesktop(
  discovery: ReviewDesktopDiscovery,
  fetch = globalThis.fetch,
): Promise<boolean> {
  try {
    const response = await fetch(`${discovery.url}/health`, {
      signal: AbortSignal.timeout(1_500),
    });

    if (!response.ok) return false;
    const health = await response.json();

    return (
      isJsonObject(health) &&
      health.ok === true &&
      health.instanceId === discovery.instanceId &&
      health.desktopAttached === true
    );
  } catch {
    return false;
  }
}

/** The selected Desktop's record while it is running, else null. */
export function healthyReviewInstance(
  selection: ReviewInstanceSelection,
): ReviewDesktopDiscovery | null {
  return selection.instance?.healthy ? selection.instance.discovery : null;
}

export async function requireHealthyReviewDesktop(
  fetch = globalThis.fetch,
): Promise<ReviewDesktopDiscovery> {
  const selection = await selectReviewInstance({ fetch });
  const discovery = healthyReviewInstance(selection);

  if (!discovery) throw reviewInstanceUnavailable(selection);

  return discovery;
}

/** Shell-session override; agents inherit it through the bare shim. */
export const REVIEW_INSTANCE_ENV = "DEV_REVIEW_INSTANCE";

// Keys name files, so nothing else may select one.
function checkedInstanceKey(key: string, origin = "") {
  if (/^(?:stable|preview|dev-[A-Za-z0-9_.-]+)$/.test(key)) return key;
  throw new Error(
    `Unknown Whiteboard instance ${JSON.stringify(key)}${origin}. Use stable, preview, or a dev-… key from \`whiteboard instances\`.`,
  );
}

export type ReviewInstanceIdentity = Required<
  Pick<ReviewDesktopDiscovery, "key" | "channel">
> &
  Pick<ReviewDesktopDiscovery, "checkout" | "appPath" | "appVersion">;

/** Identity of the Desktop hosting this process, from the env electron-main passes. */
export function reviewInstanceIdentity(
  env: NodeJS.ProcessEnv,
): ReviewInstanceIdentity {
  const checkout = env.DEV_FAST_REVIEW_CHECKOUT?.trim();

  const channel = checkout
    ? "dev"
    : env.DEV_FAST_REVIEW_RELEASE_CHANNEL === "preview"
      ? "preview"
      : "stable";

  const identity: ReviewInstanceIdentity = {
    key: checkout ? reviewDevInstanceKey(checkout) : channel,
    channel,
  };

  if (checkout) identity.checkout = path.resolve(checkout);
  const appPath = env.DEV_FAST_REVIEW_APP_PATH?.trim();

  if (appPath) identity.appPath = appPath;
  const appVersion = env.DEV_FAST_REVIEW_APP_VERSION?.trim();

  if (appVersion) identity.appVersion = appVersion;

  return identity;
}

export interface ReviewInstance {
  key: string;
  filePath: string;
  discovery: ReviewDesktopDiscovery;
  healthy: boolean;
}

export interface ReviewInstanceDependencies {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  warn?: (message: string) => void;
}

/** Every recorded Desktop, healthy or not; malformed records are skipped. */
export async function listReviewInstances(
  dependencies: ReviewInstanceDependencies = {},
): Promise<ReviewInstance[]> {
  return (await readReviewInstances(dependencies)).instances;
}

/** Records by key, plus the files that could not be read, by key. */
async function readReviewInstances(dependencies: ReviewInstanceDependencies) {
  const env = dependencies.env ?? process.env;
  const directory = reviewInstancesDir(env);
  const names = await readdir(directory).catch((): string[] => []);

  const files = names
    .filter((name) => name.endsWith(".json"))
    .map((name): [string, string] => [
      path.basename(name, ".json"),
      path.join(directory, name),
    ]);

  // A stable Desktop that predates instances wrote only the legacy file; it
  // stands in for stable only while no stable record exists at all.
  if (!names.includes("stable.json"))
    files.push(["stable", reviewLegacyDiscoveryPath(env)]);

  const records: Omit<ReviewInstance, "healthy">[] = [];
  const broken = new Map<string, Error>();

  for (const [key, filePath] of files) {
    try {
      const discovery = await readReviewDesktopDiscoveryFile(filePath);

      if (discovery) records.push({ key, filePath, discovery });
    } catch (error) {
      const problem = error instanceof Error ? error : new Error(String(error));
      broken.set(key, problem);
      dependencies.warn?.(`Skipping ${filePath}: ${problem.message}`);
    }
  }

  const instances = await Promise.all(
    records.map(async (record) => ({
      ...record,
      healthy: await isHealthyReviewDesktop(
        record.discovery,
        dependencies.fetch,
      ),
    })),
  );

  return { instances, broken };
}

export async function readDefaultReviewInstance(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const value = await readFile(reviewDefaultInstancePath(env), "utf8")
    .then((text) => text.trim())
    .catch(() => "");

  return value || undefined;
}

export async function writeDefaultReviewInstance(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const filePath = reviewDefaultInstancePath(env);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${checkedInstanceKey(key)}\n`);
}

export async function clearDefaultReviewInstance(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await rm(reviewDefaultInstancePath(env), { force: true });
}

export interface ReviewInstanceSelection {
  key: string;
  source: "env" | "default" | "only-running" | "fallback";
  /** The selected key's record, when one exists. */
  instance?: ReviewInstance;
  instances: ReviewInstance[];
  /** Why the selected key's record could not be read, when it has a broken one. */
  problem?: Error;
}

/** DEV_REVIEW_INSTANCE, then the machine default, then the only running Desktop, then stable. */
export async function selectReviewInstance(
  dependencies: ReviewInstanceDependencies = {},
): Promise<ReviewInstanceSelection> {
  const env = dependencies.env ?? process.env;
  const { instances, broken } = await readReviewInstances(dependencies);
  const fromEnv = env[REVIEW_INSTANCE_ENV]?.trim();

  const fromDefault = fromEnv
    ? undefined
    : await readDefaultReviewInstance(env);

  const running = instances.filter((instance) => instance.healthy);

  const [key, source]: [string, ReviewInstanceSelection["source"]] = fromEnv
    ? [checkedInstanceKey(fromEnv, ` from ${REVIEW_INSTANCE_ENV}`), "env"]
    : fromDefault
      ? [
          checkedInstanceKey(
            fromDefault,
            " as the machine default (`whiteboard instances clear` removes it)",
          ),
          "default",
        ]
      : running.length === 1
        ? [running[0]!.key, "only-running"]
        : ["stable", "fallback"];

  const selection: ReviewInstanceSelection = { key, source, instances };
  const instance = instances.find((instance) => instance.key === key);

  // A broken record is a diagnosis, not "not running": `app pick` must not
  // launch a second Desktop over it. With nothing selected explicitly, any
  // broken record may be the one Desktop that is running.
  const problem = instance
    ? undefined
    : fromEnv || fromDefault
      ? broken.get(key)
      : broken.values().next().value;

  if (instance) selection.instance = instance;

  if (problem) selection.problem = problem;

  return selection;
}

/** Never a redirect: names what is running and how to start or pick one. */
export function reviewInstanceUnavailable(
  selection: ReviewInstanceSelection,
): Error {
  if (selection.problem) return selection.problem;

  const running = selection.instances
    .filter((instance) => instance.healthy)
    .map((instance) => instance.key);

  const others = running.length
    ? ` Running: ${running.join(", ")}.`
    : " No Whiteboard is running.";

  if (selection.source === "fallback" && running.length > 1)
    return new Error(
      `Several Whiteboard instances are running and none is selected.${others} Choose one with \`whiteboard instances use <key>\`, or \`export ${REVIEW_INSTANCE_ENV}=<key>\` for this shell.`,
    );

  return new Error(
    `Whiteboard \`${selection.key}\` is not running. ${reviewInstanceStartHint(selection)}, or pick another instance with \`whiteboard instances\`.${others}`,
  );
}

export function reviewInstanceStartHint(
  selection: Pick<ReviewInstanceSelection, "key" | "instance">,
): string {
  if (!selection.key.startsWith("dev-"))
    return "Start it with `whiteboard app launch`";
  const checkout = selection.instance?.discovery.checkout;

  return checkout
    ? `Start it with \`pnpm dev\` in ${checkout}`
    : "Start it with `pnpm dev` in its checkout";
}
