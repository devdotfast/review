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

/** The selected instance's record, or null when it has none. */
export async function readReviewDesktopDiscovery(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReviewDesktopDiscovery | null> {
  return (await selectReviewInstance({ env })).instance?.discovery ?? null;
}

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

export interface ReviewDesktopHealthDependencies {
  readDiscovery?: typeof readReviewDesktopDiscovery;
  fetch?: typeof globalThis.fetch;
}

export async function readHealthyReviewDesktopDiscovery(
  dependencies: ReviewDesktopHealthDependencies = {},
): Promise<ReviewDesktopDiscovery | null> {
  const readDiscovery =
    dependencies.readDiscovery ?? readReviewDesktopDiscovery;

  const discovery = await readDiscovery();

  return discovery &&
    (await isHealthyReviewDesktop(discovery, dependencies.fetch))
    ? discovery
    : null;
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

export async function requireHealthyReviewDesktop(
  retryCommand: string,
  dependencies: ReviewDesktopHealthDependencies = {},
): Promise<ReviewDesktopDiscovery> {
  const discovery = await readHealthyReviewDesktopDiscovery(dependencies);

  if (discovery) return discovery;

  if (dependencies.readDiscovery)
    throw new Error(
      `Review Desktop is not ready. Run \`review app launch\`, then retry \`${retryCommand}\`.`,
    );

  throw reviewInstanceUnavailable(
    await selectReviewInstance({ fetch: dependencies.fetch }),
  );
}

/** Shell-session override; agents inherit it through the bare shim. */
export const REVIEW_INSTANCE_ENV = "DEV_REVIEW_INSTANCE";

// Keys name files, so nothing else may select one.
function checkedInstanceKey(key: string) {
  if (/^(?:stable|preview|dev-[A-Za-z0-9_.-]+)$/.test(key)) return key;
  throw new Error(
    `Unknown Whiteboard instance ${JSON.stringify(key)}. Use stable, preview, or a dev-… key from \`whiteboard instances\`.`,
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
  const env = dependencies.env ?? process.env;
  const directory = reviewInstancesDir(env);
  const names = await readdir(directory).catch(() => []);

  const files = names
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(directory, name));

  const records: Omit<ReviewInstance, "healthy">[] = [];

  for (const filePath of [...files, reviewLegacyDiscoveryPath(env)]) {
    try {
      const discovery = await readReviewDesktopDiscoveryFile(filePath);

      if (!discovery) continue;

      // The file name is the key; a stable Desktop that predates instances
      // wrote only the legacy file.
      const key = filePath.startsWith(directory)
        ? path.basename(filePath, ".json")
        : "stable";

      if (records.some((record) => record.key === key)) continue;
      records.push({ key, filePath, discovery });
    } catch (error) {
      dependencies.warn?.(
        `Skipping ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return Promise.all(
    records.map(async (record) => ({
      ...record,
      healthy: await isHealthyReviewDesktop(
        record.discovery,
        dependencies.fetch,
      ),
    })),
  );
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
}

/** DEV_REVIEW_INSTANCE, then the machine default, then the only running Desktop, then stable. */
export async function selectReviewInstance(
  dependencies: ReviewInstanceDependencies = {},
): Promise<ReviewInstanceSelection> {
  const env = dependencies.env ?? process.env;
  const instances = await listReviewInstances(dependencies);
  const fromEnv = env[REVIEW_INSTANCE_ENV]?.trim();

  const fromDefault = fromEnv
    ? undefined
    : await readDefaultReviewInstance(env);

  const running = instances.filter((instance) => instance.healthy);

  const [key, source]: [string, ReviewInstanceSelection["source"]] = fromEnv
    ? [checkedInstanceKey(fromEnv), "env"]
    : fromDefault
      ? [checkedInstanceKey(fromDefault), "default"]
      : running.length === 1
        ? [running[0]!.key, "only-running"]
        : ["stable", "fallback"];

  return {
    key,
    source,
    instance: instances.find((instance) => instance.key === key),
    instances,
  };
}

/** Never a redirect: names what is running and how to start or pick one. */
export function reviewInstanceUnavailable(
  selection: ReviewInstanceSelection,
): Error {
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
