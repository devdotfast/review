import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { writeFileAtomicAsync } from "../atomic-write";

export function reviewDesktopRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const devHome = env.DEV_REVIEW_HOME?.trim()
    ? path.resolve(env.DEV_REVIEW_HOME)
    : path.join(homedir(), ".dev");
  return path.join(devHome, "review-desktop");
}

export function reviewDesktopDiscoveryPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(reviewDesktopRoot(env), "server.json");
}

export function reviewDesktopStateDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(reviewDesktopRoot(env), "state");
}

export async function writePrivateJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFileAtomicAsync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
