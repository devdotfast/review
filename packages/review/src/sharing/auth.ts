import { DEFAULT_STORE_ORIGIN, readStoreAuth } from "@dev.fast/trace-core";

import { SessionInputError } from "../review-api/document.js";

/** CI credentials stay in the server environment and are never persisted to a profile. */
export async function readSharingAuth(env: NodeJS.ProcessEnv = process.env) {
  if (env.DEV_WHITEBOARD_SHARE_TOKEN === undefined) {
    if (env.DEV_WHITEBOARD_SHARE_ORIGIN !== undefined)
      throw new SessionInputError(
        "DEV_WHITEBOARD_SHARE_ORIGIN requires DEV_WHITEBOARD_SHARE_TOKEN.",
      );

    return readStoreAuth(env);
  }

  const token = env.DEV_WHITEBOARD_SHARE_TOKEN.trim();

  if (!token)
    throw new SessionInputError("DEV_WHITEBOARD_SHARE_TOKEN is empty.");
  let url: URL;

  try {
    url = new URL(env.DEV_WHITEBOARD_SHARE_ORIGIN ?? DEFAULT_STORE_ORIGIN);
  } catch {
    throw new SessionInputError(
      "DEV_WHITEBOARD_SHARE_ORIGIN must be a bare HTTPS origin.",
    );
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new SessionInputError(
      "DEV_WHITEBOARD_SHARE_ORIGIN must be a bare HTTPS origin.",
    );

  return { origin: url.origin, token };
}
