// Login, logout, and identity for the hosted trace store.
//
// A device-flow login (ported from the dev CLI's auth/device.ts) stores a
// bearer token under $DEV_REVIEW_HOME/auth.json. Every store-bound command
// reads that file back through requireStoreClient.

import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";

import {
  type CliJsonOutput,
  emitJsonEvent,
  failWithJsonError,
  humanStream,
} from "./cli-output";
import { DEV_REVIEW_HOME_ENV } from "./review-storage";
import { writePrivateJsonAtomic } from "./server/desktop-paths";
import { StoreApiError, StoreClient } from "./store-client";

export const DEFAULT_STORE_ORIGIN = "https://app.dev.fast";

export interface StoreAuth {
  origin: string;
  token: string;
  login: string;
  savedAt: string;
}

/** Slow-down backoff added to the poll interval, per the OAuth device spec. */
const SLOW_DOWN_MS = 5_000;

export function storeAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env[DEV_REVIEW_HOME_ENV]?.trim()
    ? path.resolve(env[DEV_REVIEW_HOME_ENV])
    : path.join(homedir(), ".dev");
  return path.join(home, "auth.json");
}

export async function readStoreAuth(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoreAuth | null> {
  try {
    const raw = await readFile(storeAuthPath(env), "utf8");
    return JSON.parse(raw) as StoreAuth;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeStoreAuth(
  auth: StoreAuth,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await writePrivateJsonAtomic(storeAuthPath(env), auth);
}

export async function clearStoreAuth(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await rm(storeAuthPath(env), { force: true });
}

/** A client bound to the saved login. Throws when no login is saved. */
export async function requireStoreClient(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoreClient> {
  const auth = await readStoreAuth(env);
  if (!auth) throw new Error("Run `review login` first.");
  return new StoreClient({ origin: auth.origin, token: auth.token });
}

function storeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof StoreApiError ? error.message : fallback;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Opens a URL with macOS's `open`. Callers inject a stub in tests. */
async function defaultOpenUrl(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  spawn("open", [url], { stdio: "ignore", detached: true }).unref();
}

export async function runReviewLogin(input: {
  origin?: string;
  noBrowser?: boolean;
  json?: boolean;
  stdout: Writable;
  stderr: Writable;
  openUrl?: (url: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  const output: CliJsonOutput = {
    json: input.json,
    stdout: input.stdout,
    stderr: input.stderr,
  };
  const origin = input.origin ?? DEFAULT_STORE_ORIGIN;
  const openUrl = input.openUrl ?? defaultOpenUrl;
  const sleep = input.sleep ?? defaultSleep;
  const client = new StoreClient({ origin, fetch: input.fetch });

  let device: Awaited<ReturnType<StoreClient["deviceCode"]>>;
  try {
    device = await client.deviceCode();
  } catch (error) {
    return failWithJsonError(
      output,
      "login",
      storeErrorMessage(error, "Could not start the login."),
    );
  }

  humanStream(output).write(`Open ${device.verification_uri_complete}\n`);
  humanStream(output).write(`Code: ${device.user_code}\n`);
  emitJsonEvent(output, {
    event: "login",
    status: "pending",
    url: device.verification_uri_complete,
    userCode: device.user_code,
  });
  if (!input.noBrowser) {
    await openUrl(device.verification_uri_complete);
  }

  let intervalMs = Math.max(1, device.interval) * 1000;
  const expiresAt = Date.now() + device.expires_in * 1000;
  let token: string | undefined;
  while (Date.now() < expiresAt) {
    await sleep(intervalMs);
    let result: Awaited<ReturnType<StoreClient["deviceToken"]>>;
    try {
      result = await client.deviceToken(device.device_code);
    } catch (error) {
      return failWithJsonError(
        output,
        "login",
        storeErrorMessage(error, "The login failed."),
      );
    }
    if ("pending" in result) {
      if (result.pending === "slow_down") intervalMs += SLOW_DOWN_MS;
      continue;
    }
    token = result.access_token;
    break;
  }

  if (!token) {
    return failWithJsonError(
      output,
      "login",
      "The login expired. Run `review login` again.",
    );
  }

  const authedClient = new StoreClient({ origin, token, fetch: input.fetch });
  let login: string;
  try {
    login = (await authedClient.session()).user.name;
  } catch (error) {
    return failWithJsonError(
      output,
      "login",
      storeErrorMessage(error, "Could not read the login."),
    );
  }

  await writeStoreAuth(
    { origin, token, login, savedAt: new Date().toISOString() },
    input.env,
  );
  emitJsonEvent(output, { event: "login", status: "ok", login });
  humanStream(output).write(`You are logged in as ${login}.\n`);
  return 0;
}

export async function runReviewLogout(input: {
  stdout: Writable;
}): Promise<number> {
  const existing = await readStoreAuth();
  await clearStoreAuth();
  input.stdout.write(
    existing ? "You are logged out.\n" : "You were not logged in.\n",
  );
  return 0;
}

export async function runReviewWhoami(input: {
  json?: boolean;
  stdout: Writable;
  stderr: Writable;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  const output: CliJsonOutput = {
    json: input.json,
    stdout: input.stdout,
    stderr: input.stderr,
  };
  const auth = await readStoreAuth(input.env);
  if (!auth) {
    return failWithJsonError(output, "whoami", "Run `review login` first.");
  }
  const client = new StoreClient({
    origin: auth.origin,
    token: auth.token,
    fetch: input.fetch,
  });
  let login: string;
  try {
    login = (await client.session()).user.name;
  } catch (error) {
    return failWithJsonError(
      output,
      "whoami",
      storeErrorMessage(error, "Could not reach the hosted trace store."),
    );
  }
  emitJsonEvent(output, { event: "whoami", login, origin: auth.origin });
  humanStream(output).write(`Logged in to ${auth.origin} as ${login}.\n`);
  return 0;
}
