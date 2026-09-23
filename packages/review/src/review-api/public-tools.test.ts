import { randomUUID } from "node:crypto";

import { afterEach, expect, test } from "vitest";

import type { AuthoringTool } from "./agent-client.js";
import { ReviewApiClient } from "./client.js";
import { createReviewApi } from "./http.js";
import { callPublicTool, publicResult, publicTool } from "./public-tools.js";
import { ReviewStore } from "./store.js";

const stores: ReviewStore[] = [];

afterEach(() => stores.splice(0).forEach((store) => store.close()));

test("public session tools create, edit and retry against the unchanged review store", async () => {
  const store = new ReviewStore(":memory:", {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });

  stores.push(store);
  const app = createReviewApi(store);

  const client = new ReviewApiClient(
    { serverUrl: "http://test", token: "test" },
    async (url, init) => app.request(url.replace("/reviews-api", ""), init),
  );

  const tools = (await client.read<AuthoringTool[]>("/authoring")).map(
    publicTool,
  );

  const call = (name: string, input: Parameters<typeof callPublicTool>[2]) =>
    callPublicTool(client, tools.find((tool) => tool.name === name)!, input);

  const create = await call("session_create", {
    commandId: randomUUID(),
    title: "Public names",
    pins: { repositoryId: "repo", base: "base", head: "head" },
  });

  expect(create).toHaveProperty("sessionId");
  expect(create).not.toHaveProperty("reviewId");
  const sessionId = store.list()[0].reviewId;

  const literal =
    "Keep reviewId, sessionId and review_create verbatim in authored content.";

  const edit = {
    commandId: randomUUID(),
    sessionId,
    edit: { type: "insert", content: { type: "markdown", markdown: literal } },
  };

  const result = await call("session_edit", edit);
  expect(await call("session_edit", edit)).toEqual(result);
  expect(store.read(sessionId).version).toBe(1);
  expect(JSON.stringify(store.read(sessionId).document)).toContain(literal);

  const snapshot = await call("session_get", {
    sessionId,
    format: "json",
    full: true,
  });

  expect(snapshot).toHaveProperty("sessionId", sessionId);
  expect(JSON.stringify(snapshot)).toContain(literal);
  await expect(call("session_get", { reviewId: sessionId })).rejects.toThrow(
    "Use sessionId",
  );
});

test("response translation leaves authored and arbitrary payload fields intact", () => {
  const document = {
    reviewId: "literal",
    review: { reviewId: "also literal" },
  };

  expect(
    publicResult({
      reviewId: "id",
      review: { reviewId: "id", document },
      document,
    }),
  ).toEqual({
    sessionId: "id",
    session: { sessionId: "id", document },
    document,
  });
});
