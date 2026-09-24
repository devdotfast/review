import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PostHogCaptureClient,
  type PostHogCaptureProperties,
} from "./posthog-capture-client";

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
            $process_person_profile: false,
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

  it("stamps dropped-event diagnostics with the default properties", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "review-queue-"));
    roots.push(root);

    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 200 }),
    );

    let now = Date.parse("2026-08-05T12:00:00.000Z");

    const client = new PostHogCaptureClient({
      apiKey: "test-key",
      fetch: fetchMock,
      queueDir: root,
      now: () => now,
    });

    await client.capture({ event: "old", distinctId: "install-1" });
    // Eight days later the queued event has expired.
    now += 8 * 24 * 60 * 60 * 1000;
    client.setDefaultProperties({ channel: "stable", surface: "cli" });
    await client.capture({ event: "fresh", distinctId: "install-1" });
    await client.flush();

    const sent = fetchMock.mock.calls.flatMap(
      ([, init]) =>
        JSON.parse(String(init?.body)).batch as Array<{
          event: string;
          properties: PostHogCaptureProperties;
        }>,
    );

    const dropped = sent.find(
      (event) => event.event === "review_telemetry_dropped",
    );

    expect(dropped?.properties).toMatchObject({
      reason: "expired",
      count: 1,
      channel: "stable",
      surface: "cli",
      distinct_id: "install-1",
      $process_person_profile: false,
    });
  });

  it("stamps dropped-event diagnostics with whatever defaults are known when a persisted queue flushes before any event set them", async () => {
    // Simulates a fresh process at startup: a previous run left an expired
    // queued event on disk, and this new client instance flushes it before
    // anything has called setDefaultProperties.
    const root = await mkdtemp(path.join(os.tmpdir(), "review-queue-"));
    roots.push(root);

    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 200 }),
    );

    let now = Date.parse("2026-08-05T12:00:00.000Z");

    const writer = new PostHogCaptureClient({
      apiKey: "test-key",
      fetch: fetchMock,
      queueDir: root,
      now: () => now,
    });

    await writer.capture({ event: "old", distinctId: "install-1" });

    // A brand-new client instance, as at process startup: setDefaultProperties
    // has never been called on it.
    now += 8 * 24 * 60 * 60 * 1000;

    const reader = new PostHogCaptureClient({
      apiKey: "test-key",
      fetch: fetchMock,
      queueDir: root,
      now: () => now,
    });

    // A fresh, unexpired event gives the flush something eligible to send
    // alongside the expired one's drop diagnostic.
    await reader.capture({ event: "fresh", distinctId: "install-1" });
    await expect(reader.flush()).resolves.toBeUndefined();

    const sent = fetchMock.mock.calls.flatMap(
      ([, init]) =>
        JSON.parse(String(init?.body)).batch as Array<{
          event: string;
          properties: PostHogCaptureProperties;
        }>,
    );

    const dropped = sent.find(
      (event) => event.event === "review_telemetry_dropped",
    );

    expect(dropped?.properties).toMatchObject({
      reason: "expired",
      count: 1,
      distinct_id: "install-1",
      $process_person_profile: false,
    });
  });

  it("sends nested JSON properties unchanged", async () => {
    const bodies: string[] = [];

    const client = new PostHogCaptureClient({
      apiKey: "phc_test",
      fetch: async (_url, init) => {
        bodies.push(String(init?.body));

        return new Response(null, { status: 200 });
      },
    });

    await client.capture({
      event: "$exception",
      distinctId: "install-1",
      properties: {
        $exception_list: [
          { type: "TypeError", stacktrace: { frames: [{ lineno: 1 }] } },
        ],
        gone: undefined,
      },
    });
    await client.flush(1_000);

    const batch = JSON.parse(bodies[0]).batch;
    expect(
      batch[0].properties.$exception_list[0].stacktrace.frames[0].lineno,
    ).toBe(1);
    expect("gone" in batch[0].properties).toBe(false);
  });

  it("keeps nested JSON properties through the on-disk queue", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "review-queue-"));
    roots.push(root);

    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 200 }),
    );

    const client = new PostHogCaptureClient({
      apiKey: "test-key",
      fetch: fetchMock,
      queueDir: root,
    });

    await client.capture({
      event: "$exception",
      distinctId: "install-1",
      properties: {
        $exception_list: [
          { type: "TypeError", stacktrace: { frames: [{ lineno: 1 }] } },
        ],
      },
    });
    await client.flush();

    const sent = fetchMock.mock.calls.flatMap(
      ([, init]) =>
        JSON.parse(String(init?.body)).batch as Array<{
          event: string;
          properties: PostHogCaptureProperties;
        }>,
    );

    expect(sent.map((event) => event.event)).toEqual(["$exception"]);
    expect(sent[0].properties.$exception_list).toEqual([
      { type: "TypeError", stacktrace: { frames: [{ lineno: 1 }] } },
    ]);
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
