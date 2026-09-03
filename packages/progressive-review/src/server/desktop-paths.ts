import { mkdir } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomicAsync } from "../atomic-write";
import { devReviewHome } from "../review-storage";

export function reviewDesktopRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(devReviewHome(env), "review-desktop");
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

export async function writePrivateJsonAtomic<T>(
  filePath: string,
  value: T,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFileAtomicAsync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
