import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { openUrlInBrowser, runStoreLogin } from "@dev.fast/trace-core";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";

import { createShareFixture } from "../../test/fixtures/share/create.js";
import { ShareClient } from "./client.js";
import { exportShare } from "./export.js";
import { mountSharingHost } from "./host.js";
import { SharedReviewStore } from "./import.js";
import { fetchPinnedRepository } from "./repository.js";

afterEach(() => vi.unstubAllEnvs());

it("exposes the device URL while login is pending and allows retry after failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "share-login-"));
  vi.stubEnv("DEV_REVIEW_HOME", root);
  const fixture = await createShareFixture(root);
  const api = new Hono();
  const login = vi.fn<typeof runStoreLogin>();
  const openUrl = vi.fn<typeof openUrlInBrowser>(async () => {});
  mountSharingHost(
    api,
    fixture.store,
    fixture.data,
    new SharedReviewStore(path.join(root, "shared")),
    { login, openUrl },
  );
  let finish!: (code: number) => void;
  login.mockImplementation(async (options) => {
    await options!.openUrl!("https://app.dev.fast/device?user_code=ABCD");

    return new Promise<number>((resolve) => {
      finish = resolve;
    });
  });

  try {
    await api.request("/sharing/login", { method: "POST" });
    await vi.waitFor(async () => {
      expect(
        await (await api.request("/sharing/account")).json(),
      ).toMatchObject({
        pending: true,
        url: "https://app.dev.fast/device?user_code=ABCD",
      });
    });
    await api.request("/sharing/login", { method: "POST" });
    expect(login).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(
      "https://app.dev.fast/device?user_code=ABCD",
    );
    finish(1);
    await vi.waitFor(async () =>
      expect(
        await (await api.request("/sharing/account")).json(),
      ).toMatchObject({
        pending: false,
        error: "Sign-in did not finish. Try again.",
      }),
    );
    login.mockResolvedValue(0);
    await api.request("/sharing/login", { method: "POST" });
    await vi.waitFor(async () =>
      expect(await (await api.request("/sharing/account")).json()).toEqual({
        account: null,
        pending: false,
      }),
    );
  } finally {
    await fixture.data.close();
    fixture.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("reports download and checkout preparation without starting duplicate imports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "share-progress-"));
  vi.stubEnv("DEV_REVIEW_HOME", root);
  const fixture = await createShareFixture(root);
  const bundle = await exportShare(fixture);
  let download!: (bundle: Awaited<ReturnType<typeof exportShare>>) => void;

  const downloadSpy = vi
    .spyOn(ShareClient.prototype, "download")
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          download = resolve;
        }),
    );

  let fetched!: () => void;

  const gate = new Promise<void>((resolve) => {
    fetched = resolve;
  });

  const shared = new SharedReviewStore(
    path.join(root, "shared"),
    async (target, _url, pins) => {
      await gate;
      await fetchPinnedRepository(target, fixture.repo, pins);
    },
  );

  shared.connect(fixture.store, fixture.data);
  await shared.load();
  const api = new Hono();
  mountSharingHost(api, fixture.store, fixture.data, shared);
  const url = `https://app.dev.fast/s/${randomUUID()}#${"a".repeat(43)}`;

  const start = () =>
    api.request("/sharing/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });

  try {
    const response = await start();
    expect(response.status).toBe(202);
    const { reviewId } = await response.json();

    const status = async () =>
      (await api.request(`/sharing/import/${reviewId}`)).json();

    expect(await status()).toMatchObject({ stage: "downloading" });
    await start();
    expect(downloadSpy).toHaveBeenCalledTimes(1);
    download(bundle);
    await vi.waitFor(async () =>
      expect(await status()).toMatchObject({ stage: "fetching" }),
    );
    fetched();
    await vi.waitFor(
      async () =>
        expect(await status()).toMatchObject({
          stage: "ready",
          title: "Sharing pinned commits",
        }),
      { timeout: 10000 },
    );
  } finally {
    fetched();
    await shared.close();
    downloadSpy.mockRestore();
    await fixture.data.close();
    fixture.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("reports a revoke through onRevoked", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "share-revoke-"));
  vi.stubEnv("DEV_REVIEW_HOME", root);
  vi.stubEnv("DEV_REVIEW_SHARE_TOKEN", "token");
  const fixture = await createShareFixture(root);
  const api = new Hono();
  const revoked: string[] = [];

  const revoke = vi
    .spyOn(ShareClient.prototype, "revoke")
    .mockResolvedValue({});

  mountSharingHost(
    api,
    fixture.store,
    fixture.data,
    new SharedReviewStore(path.join(root, "shared")),
    { onRevoked: ({ shareId }) => revoked.push(shareId) },
  );

  try {
    const shareId = randomUUID();

    const response = await api.request("/sharing/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shareId }),
    });

    expect(response.status).toBe(200);
    expect(revoked).toEqual([shareId]);
  } finally {
    revoke.mockRestore();
    await fixture.data.close();
    fixture.store.close();
    await rm(root, { recursive: true, force: true });
  }
});
