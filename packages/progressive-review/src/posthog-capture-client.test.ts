import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PostHogCaptureClient } from "./posthog-capture-client";

describe("PostHogCaptureClient", () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sends the PostHog batch payload shape", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 200 }),
    );
    const client = new PostHogCaptureClient({
      apiKey: "test-key",
      fetch: fetchMock,
      now: () => Date.parse("2026-08-05T12:00:00.000Z"),
    });

    await client.capture({
      event: "review_command_succeeded",
      distinctId: "install-1",
      properties: { command_path: "info", exit_code: 0, ignored: undefined },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://us.i.posthog.com/batch/");
    expect(JSON.parse(String(init.body))).toEqual({
      api_key: "test-key",
      batch: [
        {
          event: "review_command_succeeded",
          properties: {
            command_path: "info",
            exit_code: 0,
            distinct_id: "install-1",
          },
          timestamp: "2026-08-05T12:00:00.000Z",
        },
      ],
    });
  });

  it("uses env overrides for the key and host", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "review-queue-"));
    roots.push(root);
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 200 }),
    );
    const client = PostHogCaptureClient.fromEnv(
      {
        DEV_REVIEW_HOME: root,
        PROGRESSIVE_REVIEW_POSTHOG_KEY: "env-key",
        PROGRESSIVE_REVIEW_POSTHOG_HOST: "https://posthog.example.com/",
      },
      { fetch: fetchMock },
    );

    await client.capture({ event: "event", distinctId: "install-1" });
    await client.flush();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://posthog.example.com/batch/");
    expect(JSON.parse(String(init.body)).api_key).toBe("env-key");
  });

  it("disables capture when no key is embedded or set in the env", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "review-queue-"));
    roots.push(root);
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 200 }),
    );
    const client = PostHogCaptureClient.fromEnv(
      { DEV_REVIEW_HOME: root },
      { fetch: fetchMock },
    );

    expect(client.enabled).toBe(false);
    await client.capture({ event: "event", distinctId: "install-1" });
    await client.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps queued events after a retryable failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "review-queue-"));
    roots.push(root);
    let now = Date.parse("2026-08-05T12:00:00.000Z");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const client = new PostHogCaptureClient({
      apiKey: "test-key",
      fetch: fetchMock,
      queueDir: root,
      now: () => now,
      idFactory: () => "event-1",
    });

    await client.capture({ event: "event", distinctId: "install-1" });
    await client.flush();
    expect((await readdir(root)).some((file) => file.endsWith(".json"))).toBe(
      true,
    );

    now += 2_000;
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      (await readdir(root)).filter((file) => file.endsWith(".json")),
    ).toEqual([]);

    await client.capture({ event: "event", distinctId: "install-1" });
    await client.discard();
    expect(
      (await readdir(root)).filter((file) => file.endsWith(".json")),
    ).toEqual([]);
  });

  it("does not send without a key and swallows network errors", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error("network down");
    });
    const disabled = new PostHogCaptureClient({ fetch: fetchMock });
    await disabled.capture({ event: "event", distinctId: "install-1" });
    expect(disabled.enabled).toBe(false);

    const enabled = new PostHogCaptureClient({
      apiKey: "test-key",
      fetch: fetchMock,
    });
    await expect(
      enabled.capture({ event: "event", distinctId: "install-1" }),
    ).resolves.toBeUndefined();
  });
});
