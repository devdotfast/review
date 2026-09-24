import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { openLocalReviewStore } from "../review-api/local-data";
import { createGlobalReviewServer } from "./desktop-server";

afterEach(() => vi.unstubAllEnvs());

const exists = (file: string) =>
  readFile(file, "utf8").then(
    () => true,
    () => false,
  );

it.each([
  ["stable", ["instances/stable.json", "server.json"]],
  ["preview", ["instances/preview.json"]],
] as const)(
  "writes the %s Desktop's records on listen and removes them on close",
  async (key, records) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "review-record-"));
    const devHome = path.join(root, "review");
    vi.stubEnv("DEV_REVIEW_HOME", devHome);
    await mkdir(devHome, { recursive: true });
    const local = openLocalReviewStore(path.join(devHome, "review-api.db"));

    const server = createGlobalReviewServer({
      reviewStore: local.store,
      reviewData: local.data,
      appPid: process.pid,
      packageRoot: root,
      toolingRoot: root,
      port: 0,
      token: "record-test-token",
      identity: { key, channel: key },
    });

    const files = records.map((record) =>
      path.join(devHome, "review-desktop", record),
    );

    try {
      await server.listen();

      for (const file of files)
        expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
          key,
          instanceId: server.discovery.instanceId,
          url: server.url,
        });

      // A pre-instance CLI reads only server.json; nothing but stable writes it.
      expect(
        await exists(path.join(devHome, "review-desktop", "server.json")),
      ).toBe(key === "stable");
    } finally {
      await server.close();
      await local.data.close();
      await local.store.close();
    }

    for (const file of files) expect(await exists(file)).toBe(false);
  },
);
