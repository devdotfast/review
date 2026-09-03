import { describe, expect, it } from "vitest";

import { TRACE_STORE_API_PREFIX } from "./store-api.js";
import { storeRoutePatterns, storeRoutes } from "./store-routes.js";

const repositoryId = 42;
const sessionId = "session_1234";

function relative(path: string): string {
  return path.slice(TRACE_STORE_API_PREFIX.length);
}

function match(path: string, pattern: RegExp): string[] {
  return [...(relative(path).match(pattern) ?? [])];
}

describe("trace store routes", () => {
  it("matches every builder with its server pattern", () => {
    expect(match(storeRoutes.stores(), storeRoutePatterns.stores)).toEqual([
      "/stores",
    ]);
    expect(
      match(storeRoutes.store(repositoryId), storeRoutePatterns.store),
    ).toEqual(["/stores/42", "42"]);
    expect(
      match(storeRoutes.sessions(repositoryId), storeRoutePatterns.sessions),
    ).toEqual(["/stores/42/sessions", "42"]);
    expect(
      match(
        storeRoutes.uploads(repositoryId, sessionId),
        storeRoutePatterns.uploads,
      ),
    ).toEqual(["/stores/42/sessions/session_1234/uploads", "42", sessionId]);
    expect(
      match(
        storeRoutes.uploadsComplete(repositoryId, sessionId),
        storeRoutePatterns.uploadsComplete,
      ),
    ).toEqual([
      "/stores/42/sessions/session_1234/uploads/complete",
      "42",
      sessionId,
    ]);
  });

  it("encodes session identifiers before it places them in a path", () => {
    expect(storeRoutes.uploads(repositoryId, "session/value")).toContain(
      "session%2Fvalue",
    );
  });
});
