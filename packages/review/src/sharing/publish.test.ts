import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readStoreAuth, writeStoreAuth } from "@dev.fast/trace-core";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";

import { createShareFixture } from "../../test/fixtures/share/create.js";
import { ReviewInputError } from "../review-api/document.js";
import { mountSharingHost } from "./host.js";
import { SharedReviewStore } from "./import.js";

it.each([
  { verified: true, protocol: "dev-fast-review" },
  { verified: true, protocol: "dev-fast-review-preview" },
  { verified: false, protocol: "dev-fast-review" },
])(
  "overlaps share setup with verification and gates objects ($verified, $protocol)",
  async ({ verified, protocol }) => {
    const root = await mkdtemp(path.join(tmpdir(), "sharing-publish-"));
    const fixture = await createShareFixture(root);
    vi.stubEnv("DEV_REVIEW_HOME", root);
    vi.stubEnv("DEV_FAST_REVIEW_APP_URL_PROTOCOL", protocol);
    const check = Promise.withResolvers<typeof fixture.repository>();
    const registered = Promise.withResolvers<void>();
    const shareId = randomUUID();
    const requests: string[] = [];
    const published: unknown[] = [];
    let manifest: { objects: { id: string }[] };

    const signed = (id: string) => ({
      url: `https://objects.test/${id}`,
      headers: {},
      expiresAt: "2099",
    });

    try {
      await writeStoreAuth({
        origin: "https://app.dev.fast",
        token: "fixture",
        login: "fixture",
        savedAt: new Date().toISOString(),
      });
      const api = new Hono();
      api.onError((error, context) =>
        context.json(
          { error: error.message },
          error instanceof ReviewInputError ? error.status : 500,
        ),
      );
      mountSharingHost(
        api,
        fixture.store,
        fixture.data,
        new SharedReviewStore(path.join(root, "shared")),
        {
          readRepository: async () => fixture.repository,
          verifyRepository: () => check.promise,
          onPublished: (event) => published.push(event),
          fetch: async (input, init) => {
            const url = new URL(String(input));
            requests.push(`${init?.method} ${url.pathname}`);

            if (url.hostname === "objects.test") {
              if (url.pathname === "/manifest")
                manifest = JSON.parse(
                  Buffer.from(init?.body as Uint8Array).toString(),
                );

              return new Response(null);
            }

            if (url.pathname === "/api/shares")
              return Response.json({ shareId, upload: signed("manifest") });

            if (url.pathname.endsWith("/manifest")) {
              registered.resolve();

              return Response.json({
                registered: true,
                uploads: Object.fromEntries(
                  manifest.objects.map(({ id }) => [id, signed(id)]),
                ),
              });
            }

            if (url.pathname.endsWith("/link"))
              return new Response(null, { status: 409 });

            if (init?.method === "DELETE")
              return Response.json({ revoked: true });

            return Response.json({
              shareId,
              url: `https://app.dev.fast/s/${shareId}#${"x".repeat(43)}`,
            });
          },
        },
      );

      const response = api.request("/sharing/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewId: fixture.reviewId }),
      });

      await registered.promise;
      expect(requests.filter((r) => r.startsWith("PUT"))).toEqual([
        "PUT /manifest",
      ]);

      if (verified) check.resolve(fixture.repository);
      else
        check.reject(
          new ReviewInputError(
            "Push the reviewed commits to GitHub before sharing.",
            409,
          ),
        );
      const result = await response;
      expect(result.status).toBe(verified ? 200 : 422);
      const version = fixture.store.read(fixture.reviewId).version;
      expect(published).toEqual(
        verified ? [{ reviewId: fixture.reviewId, version }] : [],
      );

      expect(requests.filter((r) => r.startsWith("PUT")).length).toBe(
        verified ? manifest!.objects.length + 1 : 1,
      );
      expect(requests.includes(`POST /api/shares/${shareId}/complete`)).toBe(
        verified,
      );
      expect(requests.includes(`DELETE /api/shares/${shareId}`)).toBe(
        !verified,
      );
      expect(await result.json()).toMatchObject(
        verified
          ? {
              shareId,
              url: `https://app.dev.fast/s/${shareId}${protocol === "dev-fast-review-preview" ? "?app=preview" : ""}#${"x".repeat(43)}`,
            }
          : { error: "Push the reviewed commits to GitHub before sharing." },
      );
    } finally {
      vi.unstubAllEnvs();
      await fixture.data.close();
      await fixture.store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("signs the user out when the share service rejects the stored token", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sharing-publish-"));
  const fixture = await createShareFixture(root);
  vi.stubEnv("DEV_REVIEW_HOME", root);

  try {
    await writeStoreAuth({
      origin: "https://app.dev.fast",
      token: "expired",
      login: "fixture",
      savedAt: new Date().toISOString(),
    });
    const api = new Hono();
    api.onError((error, context) =>
      context.json(
        { error: error.message },
        error instanceof ReviewInputError ? error.status : 500,
      ),
    );
    mountSharingHost(
      api,
      fixture.store,
      fixture.data,
      new SharedReviewStore(path.join(root, "shared")),
      {
        readRepository: async () => fixture.repository,
        verifyRepository: async () => fixture.repository,
        fetch: async () => new Response("unauthorized", { status: 401 }),
      },
    );

    const response = await api.request("/sharing/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewId: fixture.reviewId }),
    });

    expect(await response.json()).toEqual({
      error: "Your sign-in has expired. Sign in again to share.",
    });
    expect(response.status).toBe(401);
    expect(await readStoreAuth()).toBeNull();
  } finally {
    vi.unstubAllEnvs();
    await fixture.data.close();
    await fixture.store.close();
    await rm(root, { recursive: true, force: true });
  }
});
