import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";

import { afterEach, expect, it } from "vitest";

import { createShareFixture } from "../../test/fixtures/share/create.js";
import {
  ShareClient,
  SharePreflightError,
  readBoundedBytes,
} from "./client.js";
import { exportShare } from "./export.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

it("uploads concurrently, retries without overwriting stored bytes, and keeps account credentials off storage", async () => {
  const root = await mkdtemp("/tmp/share-client-");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const fixture = await createShareFixture(root);
  cleanup.push(async () => {
    await fixture.data.close();
    fixture.store.close();
  });

  const bundle = await exportShare(fixture),
    shareId = randomUUID(),
    capability = "x".repeat(43),
    requestId = randomUUID();

  const objects = new Map<string, Uint8Array>();
  let failed = false;
  let creations = 0;
  let puts = 0;
  let active = 0;
  let peak = 0;
  let existing = 0;

  const requests: Array<{ url: URL; headers: Headers; method?: string }> = [];
  const creationIds: string[] = [];

  const network: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      headers = new Headers(init?.headers);

    requests.push({ url, headers, method: init?.method });

    if (url.hostname === "objects.test") {
      if (init?.method === "PUT") {
        if (url.pathname !== "/manifest") {
          active++;
          peak = Math.max(peak, active);
          await Promise.resolve();
          active--;
        }

        if (objects.has(url.pathname)) {
          existing++;

          return new Response(null, { status: 412 });
        }

        if (url.pathname === "/" + bundle.manifest.objects[1]!.id && !failed) {
          failed = true;

          return new Response(null, { status: 503 });
        }

        objects.set(
          url.pathname,
          Uint8Array.from(Buffer.from(init.body as Uint8Array)),
        );
        puts++;

        return new Response(null, { status: 200 });
      }

      return new Response(Uint8Array.from(objects.get(url.pathname)!));
    }

    if (url.pathname.startsWith("/api/shared/")) {
      if (!url.pathname.includes("/objects/"))
        return Response.json({
          manifest: bundle.manifest,
          sender: { login: "real-sender" },
          sharedAt: 123,
        });

      return Response.json({
        url: `https://objects.test/${url.pathname.split("/").at(-1)}`,
        expiresAt: "2099",
      });
    }

    const signed = (id: string) => ({
      url: `https://objects.test/${id}`,
      headers: {},
      expiresAt: "2099",
    });

    if (url.pathname === "/api/shares") {
      creationIds.push(JSON.parse(String(init?.body)).requestId);
      creations++;

      return Response.json({ shareId, upload: signed("manifest") });
    }

    if (url.pathname.endsWith("/manifest"))
      return Response.json({
        registered: true,
        uploads: Object.fromEntries(
          bundle.manifest.objects.map(({ id }) => [id, signed(id)]),
        ),
      });

    if (url.pathname.endsWith("/link"))
      return Response.json({
        shareId,
        url: `https://app.dev.fast/s/${shareId}#${capability}`,
      });

    expect(url.pathname.endsWith("/complete")).toBe(true);
    expect(active).toBe(0);

    for (const { id } of bundle.manifest.objects)
      expect(objects.has("/" + id)).toBe(true);

    return Response.json({
      shareId,
      url: `https://app.dev.fast/s/${shareId}#${capability}`,
    });
  };

  const sender = new ShareClient(
    "https://app.dev.fast",
    "account-secret",
    network,
  );

  await expect(sender.create(bundle, requestId)).rejects.toThrow("503");
  const result = await sender.create(bundle, requestId);
  expect(creations).toBe(2);
  expect(puts).toBe(bundle.objects.size + 1);
  expect(existing).toBeGreaterThan(0);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(4);

  const received = await new ShareClient(
    "https://app.dev.fast",
    undefined,
    network,
  ).download(shareId, capability);

  expect(received.manifest).toEqual(bundle.manifest);
  expect(received.attribution?.login).toBe("real-sender");

  for (const [id, bytes] of bundle.objects)
    expect(Buffer.from(received.objects.get(id)!)).toEqual(Buffer.from(bytes));
  await expect(
    sender.create(bundle, requestId, async () => {
      throw new Error("Pins disappeared");
    }),
  ).rejects.toThrow("Pins disappeared");
  expect(requests.some(({ method }) => method === "DELETE")).toBe(false);
  expect(result.shareId).toBe(shareId);
  expect(creationIds).toEqual([requestId, requestId, requestId]);

  for (const { url, headers } of requests) {
    const recipient = url.pathname.startsWith("/api/shared/");
    expect(headers.get("authorization")).toBe(
      url.hostname === "objects.test" || recipient
        ? null
        : "Bearer account-secret",
    );
    expect(headers.get("x-review-share-token")).toBe(
      recipient ? capability : null,
    );
    expect(url.href).not.toContain(capability);
  }
});

it("stops a streamed response as soon as it exceeds the declared size", async () => {
  let cancelled = false;

  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(16));
    },
    cancel() {
      cancelled = true;
    },
  });

  await expect(readBoundedBytes(new Response(body), 8)).rejects.toThrow(
    "limit",
  );
  expect(cancelled).toBe(true);
});

it.each([409, 503])(
  "rejects missing upload URLs before waiting for Git and only revokes confirmed unpublished shares (%s)",
  async (lookupStatus) => {
    const root = await mkdtemp("/tmp/share-client-");
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const fixture = await createShareFixture(root);
    cleanup.push(async () => {
      await fixture.data.close();
      fixture.store.close();
    });
    const bundle = await exportShare(fixture);
    const shareId = randomUUID();
    let revoked = false;
    let checked = false;

    const sender = new ShareClient(
      "https://app.dev.fast",
      "account",
      async (input, init) => {
        const url = new URL(String(input));

        if (url.hostname === "objects.test") return new Response(null);

        if (url.pathname === "/api/shares")
          return Response.json({
            shareId,
            upload: {
              url: "https://objects.test/manifest",
              headers: {},
              expiresAt: "2099",
            },
          });

        if (url.pathname.endsWith("/manifest"))
          return Response.json({ registered: true, uploads: {} });

        if (url.pathname.endsWith("/link"))
          return new Response(null, { status: lookupStatus });

        if (init?.method === "DELETE") revoked = true;

        return Response.json({ revoked: true });
      },
    );

    const result = sender.create(bundle, randomUUID(), async () => {
      checked = true;
    });

    await expect(result).rejects.toBeInstanceOf(SharePreflightError);
    expect(checked).toBe(false);
    expect(revoked).toBe(lookupStatus === 409);
  },
);
