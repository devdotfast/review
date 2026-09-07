import path from "node:path";
import { fileURLToPath } from "node:url";

import { createGlobalReviewServer } from "./server/desktop-server";
import { GlobalReviewDesktopVerbRelay } from "./server/global-verb-relay";

/** Real HTTP/storage boundary with an attached desktop control channel. */
export async function startLifecycleTestServer() {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const relay = new GlobalReviewDesktopVerbRelay();
  relay.attach({
    signal: new AbortController().signal,
    write: () => {},
    close: () => {},
  });
  const server = createGlobalReviewServer({
    appPid: process.pid,
    packageRoot,
    toolingRoot: packageRoot,
    port: 0,
    relay,
  });
  await server.listen();
  return server;
}
