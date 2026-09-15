import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createGlobalReviewServer } from "../server/desktop-server.js";
import type { Pins } from "./document.js";
import { openLocalReviewStore } from "./local-data.js";

let directory: string, repository: string, database: string, pins: Pins;

let local: ReturnType<typeof openLocalReviewStore>;

const command = <Operation>(operation: Operation) => ({
  commandId: randomUUID(),
  operation,
});

const source = {
  side: "head" as const,
  file: "example.ts",
  fromLine: 1,
  toLine: 2,
};

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();

const insert = <Content>(reviewId: string, content: Content) =>
  local.store.execute(
    command({
      type: "edit",
      reviewId,
      edit: { type: "insert", content },
    }),
  );

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "review-local-data-"));
  repository = path.join(directory, "repository");
  database = path.join(directory, "reviews.db");
  vi.stubEnv("DEV_REVIEW_HOME", directory);
  mkdirSync(repository);
  git("init", "-q");
  git("config", "user.name", "Review Test");
  git("config", "user.email", "review-test@example.invalid");
  writeFileSync(
    path.join(repository, source.file),
    "export const value = 1;\n",
  );
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Base");
  writeFileSync(
    path.join(repository, source.file),
    "export const value = 2;\nexport const saved = true;\n",
  );
  writeFileSync(path.join(repository, "literal[1].ts"), "exact filename\n");
  writeFileSync(path.join(repository, "literal1.ts"), "wrong pattern match\n");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Head");
  writeFileSync(
    path.join(repository, source.file),
    "uncommitted text must never appear\n",
  );
  local = openLocalReviewStore(database);
  const registered = await local.data.register(repository);
  pins = await local.data.resolvePins(registered.id, "HEAD^", "HEAD");
});

afterEach(async () => {
  await local.store.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("reads pinned Git objects, rejects invalid evidence before saving, and retains registrations across restart", async () => {
  const review = await local.store.execute(
    command({ type: "create", title: "Pinned", pins }),
  );

  await insert(review.reviewId, { type: "code_peek", source });
  expect(await local.data.quote(pins, source)).toMatchObject({
    commit: pins.head,
    text: "export const value = 2;\nexport const saved = true;",
  });
  expect(await local.data.file(pins, "base", source.file)).toMatchObject({
    text: "export const value = 1;\n",
  });
  const diff = await local.data.changes(pins, source.file);
  expect(diff).toContain("+export const value = 2;");
  expect(diff).not.toContain("uncommitted");
  const literal = await local.data.changes(pins, "literal[1].ts");
  expect(literal).toContain("+exact filename");
  expect(literal).not.toContain("wrong pattern match");
  await expect(
    insert(review.reviewId, {
      type: "code_peek",
      source: { ...source, toLine: 3 },
    }),
  ).rejects.toThrow(/exceeds/);
  await expect(local.data.file(pins, "head", "../outside.ts")).rejects.toThrow(
    /relative/,
  );
  await expect(
    local.store.execute(
      command({
        type: "repin",
        reviewId: review.reviewId,
        pins: { ...pins, head: "HEAD" },
      }),
    ),
  ).rejects.toThrow(/resolved commit/);
  expect(local.store.read(review.reviewId).version).toBe(1);
  await local.store.close();
  local = openLocalReviewStore(database);
  expect((await local.data.register(repository)).id).toBe(pins.repositoryId);
  expect(local.store.read(review.reviewId).document).toHaveLength(1);
  expect(await local.data.quote(pins, source)).toMatchObject({
    commit: pins.head,
  });
});

it.skipIf(spawnSync("jj", ["--version"]).status !== 0)(
  "uses the same pinned-file contract in a jj checkout",
  async () => {
    execFileSync("jj", ["git", "init", "--colocate", repository], {
      stdio: "pipe",
    });
    expect(
      await local.data.resolvePins(pins.repositoryId, pins.base, pins.head),
    ).toEqual(pins);
    expect(await local.data.quote(pins, source)).toMatchObject({
      commit: pins.head,
      text: "export const value = 2;\nexport const saved = true;",
    });
    const diff = await local.data.changes(pins, "literal[1].ts");
    expect(diff).toContain("+exact filename");
    expect(diff).not.toContain("wrong pattern match");
  },
);

it("decodes images and checks trace/map evidence before accepting components", async () => {
  const review = await local.store.execute(
    command({ type: "create", title: "Resources", pins }),
  );

  const image = {
    id: randomUUID(),
    repositoryId: pins.repositoryId,
    kind: "image",
    base64: (
      await sharp({
        create: { width: 2, height: 2, channels: 3, background: "red" },
      })
        .png()
        .toBuffer()
    ).toString("base64"),
  };

  await local.data.upload(image);
  await insert(review.reviewId, {
    type: "image",
    assetId: image.id,
    alt: "Red square",
  });
  await expect(
    local.data.upload({ ...image, id: randomUUID(), base64: "not an image" }),
  ).rejects.toThrow(/valid single/);

  const trace = {
    id: randomUUID(),
    repositoryId: pins.repositoryId,
    kind: "trace",
    trace: {
      label: "Author",
      events: [
        { id: "answer", role: "assistant", text: "Keep the old components." },
      ],
    },
  };

  await local.data.upload(trace);
  await insert(review.reviewId, {
    type: "trace_quote",
    traceId: trace.id,
    eventId: "answer",
    text: "old components",
  });
  await expect(
    insert(review.reviewId, {
      type: "trace_quote",
      traceId: trace.id,
      eventId: "answer",
      text: "Redesign everything",
    }),
  ).rejects.toThrow(/does not match/);
  await expect(
    local.data.upload({
      ...trace,
      trace: { ...trace.trace, label: "Different content" },
    }),
  ).rejects.toThrow(/already used/);

  const map = {
    id: randomUUID(),
    repositoryId: pins.repositoryId,
    kind: "map",
    pins,
    side: "head",
    model: {
      systems: {
        app: {
          label: "App",
          containers: {
            api: {
              components: {
                example: {
                  codeElements: {
                    value: {
                      sourceRanges: [
                        { file: source.file, fromLine: 1, toLine: 2 },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  await local.data.upload(map);
  await expect(
    local.data.upload({
      ...map,
      id: randomUUID(),
      model: {
        systems: { app: { label: { not: "text" } } },
      },
    }),
  ).rejects.toThrow(Error);
  await expect(
    local.data.upload({
      ...map,
      id: randomUUID(),
      model: {
        systems: {
          app: {
            sourceRanges: [{ file: source.file, fromLine: 1, toLine: 2 }],
          },
        },
      },
    }),
  ).rejects.toThrow(Error);
  await insert(review.reviewId, {
    type: "software_map",
    mapVersionId: map.id,
    focusElementId: "app",
  });
  await expect(
    insert(review.reviewId, {
      type: "software_map",
      mapVersionId: map.id,
      focusElementId: "missing",
    }),
  ).rejects.toThrow(/focus/);
  await expect(
    local.data.upload({
      ...map,
      id: randomUUID(),
      model: {
        systems: {
          app: {
            containers: {
              api: {
                components: {
                  bad: {
                    codeElements: {
                      value: {
                        sourceRanges: [
                          { file: source.file, fromLine: 1, toLine: 99 },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  ).rejects.toThrow(/exceeds/);
  await expect(
    insert(review.reviewId, {
      type: "image",
      assetId: trace.id,
      alt: "Not an image",
    }),
  ).rejects.toThrow(/component type/);
  expect(local.store.read(review.reviewId).document).toHaveLength(3);
  await local.store.close();
  local = openLocalReviewStore(database);
  expect(await local.data.upload(image)).toMatchObject({ id: image.id });
  expect(
    (await sharp(Buffer.from(local.store.resource(image.id).data)).metadata())
      .width,
  ).toBe(2);
  await local.data.validateResource(
    pins,
    local.store.read(review.reviewId).document[2]!,
  );

  const other = local.store.registerRepository(
    path.join(directory, "other-repository"),
  );

  await expect(
    local.data.validateResource(
      { ...pins, repositoryId: other.id },
      local.store.read(review.reviewId).document[0]!,
    ),
  ).rejects.toThrow(/different repository/);
});

it("exposes real source and resource operations through the authenticated desktop server", async () => {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );

  const server = createGlobalReviewServer({
    appPid: process.pid,
    packageRoot,
    toolingRoot: packageRoot,
    port: 0,
    token: "test-token",
    discoveryPath: path.join(directory, "desktop.json"),
    reviewStore: local.store,
    reviewData: local.data,
  });

  try {
    await server.listen();
    const url = server.url + "/reviews-api";

    const headers = {
      "content-type": "application/json",
      "x-review-token": "test-token",
    };

    const post = <Payload>(route: string, value: Payload) =>
      fetch(url + route, {
        method: "POST",
        headers,
        body: JSON.stringify(value),
      });

    expect(
      await (await post("/repositories", { path: repository })).json(),
    ).toEqual({ id: pins.repositoryId, name: "repository" });
    expect(
      await (
        await post("/pins", {
          repositoryId: pins.repositoryId,
          base: "HEAD^",
          head: "HEAD",
        })
      ).json(),
    ).toEqual(pins);

    const review = await (
      await post("/commands", command({ type: "create", title: "HTTP", pins }))
    ).json();

    const quote = await post(`/${review.reviewId}/source`, { source });
    expect(quote.status).toBe(200);
    expect(await quote.json()).toMatchObject({
      commit: pins.head,
      text: expect.stringContaining("value = 2"),
    });

    const resource = {
      id: randomUUID(),
      repositoryId: pins.repositoryId,
      kind: "trace",
      trace: { label: "Test", events: [] },
    };

    expect((await post("/resources", resource)).status).toBe(200);
    expect((await fetch(url + "/resources/" + resource.id)).status).toBe(401);

    const response = await fetch(url + "/resources/" + resource.id, {
      headers,
    });

    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toMatchObject({
      provenance: "client_supplied",
      events: [],
    });
    expect(
      (
        await post(`/${review.reviewId}/source`, {
          source: { ...source, toLine: 99 },
        })
      ).status,
    ).toBe(400);
  } finally {
    await server.close();
  }
});
