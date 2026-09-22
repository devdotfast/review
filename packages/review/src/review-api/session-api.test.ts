import { randomUUID } from "node:crypto";

import type { JsonValue } from "@dev.fast/json";
import { afterEach, beforeEach, expect, it } from "vitest";

import { type AuthoringTool, callAuthoringTool } from "./agent-client.js";
import { ReviewApiClient } from "./client.js";
import { createReviewApi } from "./http.js";
import { ReviewStore } from "./store.js";

const pins = { repositoryId: "repo", base: "base", head: "head" };

let store: ReviewStore;

beforeEach(() => {
  store = new ReviewStore(":memory:", {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });
});

afterEach(() => store.close());

const api = () =>
  createReviewApi(
    store,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "session",
  );

const post = (app: ReturnType<typeof api>, route: string, value: JsonValue) =>
  app.request(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });

it("edits existing sessions and reuses persisted receipts without changing document content", async () => {
  const { reviewId } = await store.execute({
    commandId: randomUUID(),
    operation: { type: "create", title: "Review reviewId sessionId", pins },
  });

  const app = api();
  const commandId = randomUUID();

  const edit = {
    type: "insert",
    content: {
      type: "sequence",
      title: "Review",
      actors: { reviewId: "review_get", sessionId: "session_get" },
      steps: [
        {
          from: "reviewId",
          to: "sessionId",
          label: "reviewId",
          explanation: "Keep reviewId unchanged",
        },
      ],
    },
  };

  const response = await post(app, "/commands", {
    commandId,
    operation: { type: "edit", sessionId: reviewId, edit },
  });

  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.sessionId).toBe(reviewId);
  expect(result).not.toHaveProperty("reviewId");

  const retry = await store.execute({
    commandId,
    operation: { type: "edit", reviewId, edit },
  });

  expect(retry.version).toBe(result.version);
  expect(store.history(reviewId)).toHaveLength(2);
  const snapshot = await (await app.request(`/${reviewId}?full=true`)).json();
  expect(snapshot.sessionId).toBe(reviewId);
  expect(snapshot.document).toEqual(store.read(reviewId).document);
  expect(snapshot.title).toBe("Review reviewId sessionId");

  const text = await (
    await app.request(`/${reviewId}/inspect?full=true`)
  ).json();

  expect(text).toContain(`Session ${reviewId}`);
  expect(text).toContain("Actor reviewId: review_get");

  const tools: AuthoringTool[] = await (await app.request("/authoring")).json();

  const client = new ReviewApiClient(
    { serverUrl: "http://session.test", token: "test" },
    async (url, init) => app.request(url.replace("/reviews-api", ""), init),
  );

  const get = tools.find((tool) => tool.name === "session_get")!;
  expect(
    await callAuthoringTool(client, get, {
      sessionId: reviewId,
      full: true,
      format: "json",
    }),
  ).toEqual(snapshot);

  const old = await (
    await createReviewApi(store).request(`/${reviewId}?full=true`)
  ).json();

  expect(old.reviewId).toBe(reviewId);
  expect(old).not.toHaveProperty("sessionId");
});

it("advertises callable session tools and reports validation against the public field", async () => {
  const app = api();
  const tools = await (await app.request("/authoring")).json();

  const rename = tools.find(
    (tool: { name: string }) => tool.name === "session_rename",
  );

  expect(rename.inputSchema.properties.sessionId).toBeDefined();
  expect(rename.inputSchema.properties).not.toHaveProperty("reviewId");
  expect(rename.inputSchema.required).toContain("sessionId");

  const response = await post(app, rename.path, {
    commandId: randomUUID(),
    operation: { type: rename.commandType, title: "New title" },
  });

  expect(response.status).toBe(400);
  const error = await response.json();
  expect(
    error.issues.some(
      (issue: { path: string[] }) =>
        issue.path.join(".") === "operation.sessionId",
    ),
  ).toBe(true);
  expect(error.error).toContain("sessionId");

  const ambiguous = await post(app, "/commands", {
    commandId: randomUUID(),
    operation: {
      type: "rename",
      sessionId: "new",
      reviewId: "old",
      title: "New",
    },
  });

  expect(ambiguous.status).toBe(400);
  expect(store.list()).toHaveLength(0);
});

it("streams session metadata across edits and supports disconnecting", async () => {
  const { reviewId } = await store.execute({
    commandId: randomUUID(),
    operation: { type: "create", title: "Original", pins },
  });

  const app = api();

  const response = await app.request(
    `/watch?subscriptions=${encodeURIComponent(
      JSON.stringify([
        { sessionId: reviewId, mode: "textual" },
        { sessionId: null, mode: "textual" },
      ]),
    )}`,
  );

  expect(response.status).toBe(200);
  const reader = response.body!.getReader();

  try {
    const first = JSON.parse(
      new TextDecoder().decode((await reader.read()).value),
    );

    expect(first[0].value.sessionId).toBe(reviewId);
    expect(first[1].value[0].sessionId).toBe(reviewId);
    await post(app, "/commands", {
      commandId: randomUUID(),
      operation: { type: "rename", sessionId: reviewId, title: "Changed" },
    });

    const next = JSON.parse(
      new TextDecoder().decode((await reader.read()).value),
    );

    expect(next[0].value.title).toBe("Changed");
    expect(next[0].value).not.toHaveProperty("reviewId");
  } finally {
    await reader.cancel();
  }

  const single = await app.request(`/${reviewId}/watch`);
  const singleReader = single.body!.getReader();

  try {
    const value = JSON.parse(
      new TextDecoder().decode((await singleReader.read()).value),
    );

    expect(value.sessionId).toBe(reviewId);
  } finally {
    await singleReader.cancel();
  }
});

it("keeps legacy and session follow streams separate on the same transport", async () => {
  const { reviewId } = await store.execute({
    commandId: randomUUID(),
    operation: { type: "create", title: "Shared", pins },
  });

  const sessionApi = api();
  const legacyApi = createReviewApi(store);

  const transport = async (url: string, init?: RequestInit) =>
    url.includes("/sessions-api")
      ? sessionApi.request(url.replace("/sessions-api", ""), init)
      : legacyApi.request(url.replace("/reviews-api", ""), init);

  const connection = { serverUrl: "http://test", token: "test" };
  const legacy = new ReviewApiClient(connection, transport);

  const session = new ReviewApiClient(
    { ...connection, apiPath: "/sessions-api" },
    transport,
  );

  const abort = new AbortController();
  const oldValue = Promise.withResolvers<{ reviewId: string }>();
  const newValue = Promise.withResolvers<{ sessionId: string }>();

  const follows = [
    legacy.follow(reviewId, abort.signal, oldValue.resolve, oldValue.reject),
    session.follow(reviewId, abort.signal, newValue.resolve, newValue.reject),
  ];

  try {
    expect(await oldValue.promise).toHaveProperty("reviewId", reviewId);
    const value = await newValue.promise;
    expect(value).toHaveProperty("sessionId", reviewId);
    expect(value).not.toHaveProperty("reviewId");
  } finally {
    abort.abort();
    await Promise.all(follows);
  }
});
