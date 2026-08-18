import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { readBoundedJson } from "./http-json";

describe("readBoundedJson", () => {
  it("accepts JSON media types and an explicit empty-body fallback", async () => {
    await expect(
      readBoundedJson(
        request('{"ok":true}', "application/json; charset=utf-8"),
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      readBoundedJson(request('{"ok":true}', "application/problem+json")),
    ).resolves.toEqual({ ok: true });
    await expect(
      readBoundedJson(request("", "application/json"), undefined, {}),
    ).resolves.toEqual({});
  });

  it("rejects unsupported content types, invalid JSON, and oversized bodies", async () => {
    await expect(
      readBoundedJson(request("{}", "text/plain")),
    ).rejects.toMatchObject({ statusCode: 415 });
    await expect(
      readBoundedJson(request("{", "application/json")),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      readBoundedJson(request('{"value":"large"}', "application/json"), 4),
    ).rejects.toMatchObject({ statusCode: 413 });
  });
});

function request(body: string, contentType: string): IncomingMessage {
  return Object.assign(Readable.from([body]), {
    headers: {
      "content-length": String(Buffer.byteLength(body)),
      "content-type": contentType,
    },
  }) as IncomingMessage;
}
