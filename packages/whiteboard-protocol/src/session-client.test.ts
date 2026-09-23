import { expect, it } from "vitest";

import { SessionApiClient } from "./whiteboard-api-client.js";

const connection = {
  serverUrl: "http://localhost:1234",
  token: "test-token",
  apiPath: "/sessions-api",
} as const;

it("edits through session metadata without renaming authored fields", async () => {
  const document = [
    {
      type: "diagram",
      props: { sessionId: "authored", reviewId: "also-authored" },
    },
  ];

  const client = new SessionApiClient(connection, async (url, init) => {
    expect(url).toBe("http://localhost:1234/sessions-api/commands");
    expect(JSON.parse(String(init?.body))).toEqual({
      commandId: "retry-id",
      operation: { sessionId: "existing-id", type: "replace", document },
    });

    return Response.json({ sessionId: "existing-id", version: 2, document });
  });

  expect(
    await client.post("/commands", {
      commandId: "retry-id",
      operation: { sessionId: "existing-id", type: "replace", document },
    }),
  ).toEqual({ sessionId: "existing-id", version: 2, document });
});

it("decodes catalog and document subscriptions while preserving authored metadata", async () => {
  const authored = { sessionId: "authored", reviewId: "authored-review" };

  const client = new SessionApiClient(connection, async (url) => {
    expect(JSON.parse(new URL(url).searchParams.get("subscriptions")!)).toEqual(
      [{ sessionId: null }, { sessionId: "existing-id" }],
    );

    return new Response(
      JSON.stringify([
        { value: [{ sessionId: "existing-id", title: "Session" }] },
        { value: { sessionId: "existing-id", document: authored } },
      ]) + "\n",
    );
  });

  const stream = client.watch(
    [{ sessionId: null }, { sessionId: "existing-id" }],
    new AbortController().signal,
  );

  expect((await stream.next()).value).toEqual([
    { value: [{ sessionId: "existing-id", title: "Session" }] },
    { value: { sessionId: "existing-id", document: authored } },
  ]);
  expect((await stream.next()).done).toBe(true);
});

it("leaves JSON resources and public session clients unchanged", async () => {
  const authored = {
    sessionId: "authored",
    content: { reviewId: "author-value" },
  };

  const send = async () => Response.json(authored);
  expect(
    await new SessionApiClient(connection, send).read("/id/resources/data"),
  ).toEqual(authored);

  const publicClient = new SessionApiClient(
    {
      serverUrl: connection.serverUrl,
      token: connection.token,
      apiPath: "/sessions-api",
    },
    send,
  );

  expect(await publicClient.read("/id")).toEqual(authored);
});
