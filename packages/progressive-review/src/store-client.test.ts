import type { JsonValue } from "@dev.fast/review-protocol";
import { storeRoutes } from "@dev.fast/trace-shared";
import { describe, expect, it, vi } from "vitest";

import {
  STORE_UPGRADE_REQUIRED_MESSAGE,
  StoreApiError,
  StoreClient,
} from "./store-client";

function jsonResponse(body: JsonValue, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("StoreClient", () => {
  it("sends the bearer token and parses the envelope on error", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "forbidden", message: "no" } }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    );
    const client = new StoreClient({
      origin: "https://app.dev.fast",
      token: "tok",
      fetch,
    });
    await expect(
      client.createStore({ owner: "a", name: "b" }),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer tok",
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      new URL(storeRoutes.stores(), "https://app.dev.fast").toString(),
    );
  });

  it("returns null for a 404 from findStore", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "not_found", message: "no" } }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    );
    const client = new StoreClient({
      origin: "https://app.dev.fast",
      token: "tok",
      fetch,
    });
    await expect(
      client.findStore({ owner: "a", name: "b" }),
    ).resolves.toBeNull();
  });

  it("maps device polling errors to pending states", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            error: "authorization_pending",
            error_description: "",
          }),
          { status: 400 },
        ),
    );
    const client = new StoreClient({ origin: "https://app.dev.fast", fetch });
    expect(await client.deviceToken("dc")).toEqual({
      pending: "authorization_pending",
    });

    const rejectingFetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "The device code is invalid.",
          }),
          { status: 400 },
        ),
    );
    const rejectingClient = new StoreClient({
      origin: "https://app.dev.fast",
      fetch: rejectingFetch,
    });
    await expect(rejectingClient.deviceToken("dc")).rejects.toSatisfy(
      (error) => {
        expect(error).toBeInstanceOf(StoreApiError);
        expect((error as StoreApiError).message).toMatch(/invalid/i);
        return true;
      },
    );
  });

  it("maps a response outside the contract to upgrade_required", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ nonsense: true }),
    );
    const client = new StoreClient({
      origin: "https://app.dev.fast",
      token: "tok",
      fetch,
    });
    await expect(
      client.createStore({ owner: "a", name: "b" }),
    ).rejects.toMatchObject({
      code: "upgrade_required",
      status: 200,
      message: STORE_UPGRADE_REQUIRED_MESSAGE,
    });
  });

  it("rejects a 0.1 store that begins an upload without an uploadId", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        storeId: "a".repeat(32),
        baseGeneration: 0,
        uploads: [],
      }),
    );
    const client = new StoreClient({
      origin: "https://app.dev.fast",
      token: "tok",
      fetch,
    });
    await expect(
      client.beginUpload(7, "session-1", { harness: "claude", objects: [] }),
    ).rejects.toMatchObject({ code: "upgrade_required" });
  });

  it("completes an upload by its id and returns the receipt", async () => {
    const receipt = {
      sessionId: "session-1",
      uploadId: "b".repeat(32),
      generation: 2,
      objects: [{ name: "main.jsonl.gz", size: 10, sha256: "0".repeat(64) }],
      commits: ["c".repeat(40)],
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(receipt),
    );
    const client = new StoreClient({
      origin: "https://app.dev.fast",
      token: "tok",
      fetch,
    });

    await expect(
      client.completeUpload(7, "session-1", "b".repeat(32), {
        commits: ["c".repeat(40)],
      }),
    ).resolves.toEqual(receipt);

    expect(fetch.mock.calls[0]?.[0]).toBe(
      new URL(
        storeRoutes.uploadComplete(7, "session-1", "b".repeat(32)),
        "https://app.dev.fast",
      ).toString(),
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ commits: ["c".repeat(40)] }),
    });
  });

  it("deletes a store and accepts the 202 receipt", async () => {
    const receipt = {
      repositoryId: 7,
      storeId: "a".repeat(32),
      status: "deleting",
      deletedAt: "2026-09-05T00:00:00.000Z",
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(receipt, 202),
    );
    const client = new StoreClient({
      origin: "https://app.dev.fast",
      token: "tok",
      fetch,
    });

    await expect(client.deleteStore(7)).resolves.toEqual(receipt);

    expect(fetch.mock.calls[0]?.[0]).toBe(
      new URL(storeRoutes.store(7), "https://app.dev.fast").toString(),
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "DELETE",
      headers: { authorization: "Bearer tok" },
    });
    expect(fetch.mock.calls[0]?.[1]?.body).toBeUndefined();
  });
});
