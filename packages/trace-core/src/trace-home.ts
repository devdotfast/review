import os from "node:os";
import path from "node:path";

export const DEV_REVIEW_HOME_ENV = "DEV_REVIEW_HOME";

/**
 * The one resolver for the Review home directory. Every reader of
 * DEV_REVIEW_HOME calls this, so an untrimmed or empty value cannot make two
 * modules disagree about the directory. An empty value means "use the
 * default".
 */
export function devReviewHome(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const override = env[DEV_REVIEW_HOME_ENV]?.trim();

  return override ? path.resolve(override) : path.join(homeDir, ".dev");
}
