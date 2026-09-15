import path from "node:path";

import { devReviewHome } from "./review-storage";

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
