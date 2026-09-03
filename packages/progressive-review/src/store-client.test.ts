import { describe, expect, it, vi } from "vitest";

import { StoreClient } from "./store-client";

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
      "https://app.dev.fast/api/trace/v1/stores",
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
  });

  it("validates responses against the contract", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ nonsense: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new StoreClient({
      origin: "https://app.dev.fast",
      token: "tok",
      fetch,
    });
    await expect(client.createStore({ owner: "a", name: "b" })).rejects.toThrow(
      /response/i,
    );
  });
});
