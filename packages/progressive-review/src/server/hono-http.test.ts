import { describe, expect, it } from "vitest";

import {
  applyCorsHeaders,
  isAuthorizedRequest,
  jsonResponse,
  readBoundedRequestJson,
} from "./hono-http";

describe("Hono HTTP adapter", () => {
  it("preserves newline JSON, CORS, and timing-safe token inputs", async () => {
    const request = new Request("http://localhost/path?token=query-token", {
      headers: { origin: "vscode-file://review" },
    });
    const json = jsonResponse({ ok: true }, 200, { cacheControl: "no-store" });
    json.headers.set("vary", "Accept-Encoding");
    const response = applyCorsHeaders(request, json);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "vscode-file://review",
    );
    expect(response.headers.get("access-control-allow-private-network")).toBe(
      "true",
    );
    expect(response.headers.get("vary")).toBe("Accept-Encoding, Origin");
    await expect(response.text()).resolves.toBe('{"ok":true}\n');
    expect(isAuthorizedRequest(request, "query-token")).toBe(true);
    expect(isAuthorizedRequest(request, "wrong-token")).toBe(false);
    expect(
      isAuthorizedRequest(
        new Request("http://localhost/path?token=wrong", {
          headers: { "x-review-token": "header-token" },
        }),
        "header-token",
      ),
    ).toBe(true);
  });

  it("accepts JSON media types and an explicit empty-body fallback", async () => {
    await expect(
      readBoundedRequestJson(jsonRequest('{"ok":true}')),
    ).resolves.toEqual({ ok: true });
    await expect(
      readBoundedRequestJson(
        jsonRequest('{"ok":true}', "application/problem+json"),
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      readBoundedRequestJson(jsonRequest(""), undefined, {}),
    ).resolves.toEqual({});
  });

  it("rejects wrong content types, malformed JSON, and declared or streamed oversized bodies", async () => {
    await expect(
      readBoundedRequestJson(jsonRequest("{}", "text/plain")),
    ).rejects.toMatchObject({ statusCode: 415 });
    await expect(
      readBoundedRequestJson(jsonRequest("{")),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      readBoundedRequestJson(
        new Request("http://localhost/path", {
          method: "POST",
          headers: {
            "content-length": "5",
            "content-type": "application/json",
          },
          body: "{}",
        }),
        4,
      ),
    ).rejects.toMatchObject({ statusCode: 413 });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"'));
        controller.enqueue(new TextEncoder().encode('too large"}'));
        controller.close();
      },
    });
    await expect(
      readBoundedRequestJson(
        new Request("http://localhost/path", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: stream,
          duplex: "half",
        } as RequestInit),
        8,
      ),
    ).rejects.toMatchObject({ statusCode: 413 });
  });

  it("propagates aborted request bodies", async () => {
    const abort = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        abort.signal.addEventListener("abort", () => {
          controller.error(new Error("request aborted"));
        });
      },
    });
    const request = new Request("http://localhost/path", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
      signal: abort.signal,
    } as RequestInit);

    const reading = readBoundedRequestJson(request);
    abort.abort();
    await expect(reading).rejects.toThrow("request aborted");
  });
});

function jsonRequest(body: string, contentType = "application/json"): Request {
  return new Request("http://localhost/path", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}
