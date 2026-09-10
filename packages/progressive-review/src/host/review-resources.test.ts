import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  HOST_COMMAND_DEFINITIONS,
  HOST_LIMITS,
  HOST_QUERY_DEFINITIONS,
  HostAssetSchema,
  type HostCommandName,
  HostCommandSchema,
  type HostMap,
  HostMapVersionSchema,
  type HostQueryName,
  HostQuerySchema,
  type HostSourceSpan,
  type JsonValue,
} from "@dev.fast/review-protocol";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { LocalEvidenceProvider } from "./evidence-provider";
import { type HostAccess, ReviewHost } from "./review-host";
import { ReviewHostStore } from "./review-host-store";
import { ReviewResources } from "./review-resources";

const directories: string[] = [];
const stores = new Set<ReviewHostStore>();
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function openStore(databasePath: string) {
  const store = new ReviewHostStore(databasePath);
  stores.add(store);
  return store;
}
function closeStore(store: ReviewHostStore) {
  store.close();
  stores.delete(store);
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { resolve, promise };
}
function git(repositoryPath: string, ...args: string[]) {
  return execFileSync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function commit(repositoryPath: string) {
  git(repositoryPath, "add", ".");
  git(repositoryPath, "commit", "-m", "Test resource source");
  return git(repositoryPath, "rev-parse", "HEAD");
}

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "review-resources-"));
  directories.push(directory);
  const repositoryPath = path.join(directory, "repository");
  mkdirSync(path.join(repositoryPath, "src"), { recursive: true });
  git(repositoryPath, "init", "-b", "main");
  git(repositoryPath, "config", "user.name", "Review Test");
  git(repositoryPath, "config", "user.email", "review@example.invalid");
  git(repositoryPath, "config", "commit.gpgsign", "false");
  writeFileSync(
    path.join(repositoryPath, "src/code.ts"),
    "export const answer = 1;\nexport const other = true;\n",
  );
  const base = commit(repositoryPath);
  writeFileSync(
    path.join(repositoryPath, "src/code.ts"),
    "export const answer = 2;\nexport const other = true;\n",
  );
  const head = commit(repositoryPath);
  const databasePath = path.join(directory, "review.db");
  const store = openStore(databasePath);
  const host = new ReviewHost(store);
  const author: HostAccess = {
    principal: { id: randomUUID(), kind: "agent", displayName: "Author" },
    permissions: new Set(["author", "read", "publish"]),
  };
  const human: HostAccess = {
    principal: { id: randomUUID(), kind: "human", displayName: "Reviewer" },
    permissions: new Set(["human", "register_repository", "read"]),
  };
  const envelope = {
    apiVersion: 1,
    hostId: store.hostId,
    workspaceId: store.workspaceId,
    clientId: randomUUID(),
  };
  const command = (
    type: HostCommandName,
    input: JsonValue,
    commandId: string = randomUUID(),
  ) => HostCommandSchema.parse({ ...envelope, type, input, commandId });
  const query = (type: HostQueryName, input: JsonValue) =>
    HostQuerySchema.parse({ ...envelope, type, input });
  const repository = HOST_COMMAND_DEFINITIONS[
    "repository.register"
  ].result.parse(
    (
      await host.command(
        human,
        command("repository.register", { path: repositoryPath }),
      )
    ).result,
  );
  const createReview = async () =>
    HOST_COMMAND_DEFINITIONS["review.create"].result.parse(
      (
        await host.command(
          author,
          command("review.create", {
            repositoryId: repository.id,
            title: "Retained resources",
            change: { kind: "range", baseRef: base, headRef: head },
          }),
        )
      ).result,
    ).review;
  const review = await createReview();
  const span: HostSourceSpan = {
    repositoryId: repository.id,
    commit: head,
    blob: git(repositoryPath, "rev-parse", `${head}:src/code.ts`),
    file: "src/code.ts",
    fromLine: 1,
    toLine: 1,
  };
  const map: HostMap = {
    schemaVersion: 1,
    elements: {
      app: {
        id: "app",
        parentId: null,
        kind: "component",
        label: "Application",
        description: "Reads storage",
        source: [span],
      },
      database: {
        id: "database",
        parentId: null,
        kind: "store",
        label: "Database",
        description: "Shared state",
        source: [],
        store: {
          storage: "relational",
          collections: { reviews: { label: "Reviews", fields: {} } },
        },
      },
    },
    relationships: {
      query: {
        id: "query",
        kind: "call",
        fromId: "app",
        toId: "database",
        label: "reads",
        evidence: span,
      },
    },
  };
  const mapRequest = (value: HostMap = map) =>
    command("map.create", {
      reviewId: review.id,
      documentVersion: 0,
      side: "head",
      map: value,
    });
  const createMap = async (value: HostMap = map) =>
    HostMapVersionSchema.parse(
      (await host.command(author, mapRequest(value))).result,
    );
  const event = {
    id: randomUUID(),
    ordinal: 5,
    at: "2026-09-10T12:00:00Z",
    kind: "assistant" as const,
    text: "The shared database removes per-review files.",
  };
  const traceRequest = () =>
    command("trace.ingest", {
      reviewId: review.id,
      label: "Selected author explanation",
      events: [event],
    });
  return {
    directory,
    repositoryPath,
    databasePath,
    store,
    host,
    author,
    human,
    review,
    repository,
    createReview,
    command,
    query,
    span,
    map,
    mapRequest,
    createMap,
    event,
    traceRequest,
  };
}

function counts(databasePath: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db
      .prepare(`SELECT
    (SELECT count(*) FROM host_maps) AS maps,
    (SELECT count(*) FROM host_map_versions) AS versions,
    (SELECT count(*) FROM host_traces) AS traces,
    (SELECT count(*) FROM host_assets) AS assets,
    (SELECT count(*) FROM host_asset_blobs) AS blobs,
    (SELECT count(*) FROM host_events) AS events,
    (SELECT count(*) FROM host_command_receipts) AS receipts`)
      .get();
  } finally {
    db.close();
  }
}

async function imageBytes(format: "png" | "jpeg" | "webp" = "png") {
  return sharp({
    create: { width: 2, height: 3, channels: 3, background: "#123456" },
  })
    .toFormat(format)
    .toBuffer();
}

describe("retained software map authority", () => {
  it("verifies source blobs once, keeps immutable versions, and can relabel a map offline without touching the document", async () => {
    const f = await fixture();
    const first = await f.createMap();
    expect(first).toMatchObject({
      revision: 0,
      repositoryId: f.repository.id,
      commit: f.span.commit,
    });
    const evidence = Object.values(f.store.mapEvidence(f.review.id, first.id));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.text).toBe("export const answer = 2;");
    renameSync(f.repositoryPath, path.join(f.directory, "offline-repository"));
    const second = HostMapVersionSchema.parse(
      (
        await f.host.command(
          f.author,
          f.command("map.mutate", {
            reviewId: f.review.id,
            mapId: first.mapId,
            expectedVersion: 0,
            operations: [
              {
                op: "element.put",
                element: {
                  ...first.elements.app!,
                  label: "Renamed application",
                },
              },
            ],
          }),
        )
      ).result,
    );
    expect(second).toMatchObject({ mapId: first.mapId, revision: 1 });
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(f.store.mapVersion(f.review.id, first.id)).toEqual(first);
    expect(f.store.document(f.review.id).version).toBe(0);
    closeStore(f.store);
    const restarted = openStore(f.databasePath);
    expect(restarted.currentMap(f.review.id, first.mapId)).toEqual(second);
    expect(restarted.mapVersion(f.review.id, first.id)).toEqual(first);
    expect(
      Object.values(restarted.mapEvidence(f.review.id, second.id)),
    ).toEqual(evidence);
  });

  it.each(["repository", "commit", "blob"] as const)(
    "rejects an unverified source %s claim without retaining a partial map",
    async (field) => {
      const f = await fixture();
      const bad = structuredClone(f.map);
      bad.elements.app!.source[0]![
        field === "repository" ? "repositoryId" : field
      ] = field === "repository" ? randomUUID() : "f".repeat(40);
      const baseline = counts(f.databasePath);
      await expect(f.createMap(bad)).rejects.toMatchObject({
        name: "HostDocumentValidationError",
      });
      expect(counts(f.databasePath)).toEqual(baseline);
    },
  );

  it.each(["cycle", "parent", "endpoint", "identity", "store"])(
    "rejects a map with an invalid %s",
    async (problem) => {
      const f = await fixture();
      const bad = structuredClone(f.map);
      if (problem === "cycle") {
        bad.elements.app!.parentId = "database";
        bad.elements.database!.parentId = "app";
      }
      if (problem === "parent") bad.elements.app!.parentId = "missing";
      if (problem === "endpoint") bad.relationships.query!.toId = "missing";
      if (problem === "identity") bad.elements.app!.id = "other";
      if (problem === "store") bad.elements.database!.kind = "component";
      const baseline = counts(f.databasePath);
      await expect(f.createMap(bad)).rejects.toMatchObject({
        name: "HostDocumentValidationError",
      });
      expect(counts(f.databasePath)).toEqual(baseline);
    },
  );

  it("makes equivalent mutations no-ops and bounds list pages to their original watermark and filters", async () => {
    const f = await fixture();
    const first = await f.createMap();
    const beforeNoop = f.store.cursor();
    const noop = HostMapVersionSchema.parse(
      (
        await f.host.command(
          f.author,
          f.command("map.mutate", {
            reviewId: f.review.id,
            mapId: first.mapId,
            expectedVersion: 0,
            operations: [{ op: "element.put", element: first.elements.app! }],
          }),
        )
      ).result,
    );
    expect(noop).toEqual(first);
    expect(f.store.cursor()).toBe(beforeNoop);
    const second = await f.createMap();
    const firstPage = f.store.maps(f.review.id, { limit: 1 });
    expect(firstPage.items[0]?.id).toBe(second.id);
    await f.createMap();
    const cursor = firstPage.nextCursor!;
    const next = f.store.maps(f.review.id, { cursor, limit: 1 });
    expect(next.items.map((map) => map.id)).toEqual([first.id]);
    expect(next.nextCursor).toBeNull();
    expect(() =>
      f.store.maps(f.review.id, { cursor, mapId: first.mapId }),
    ).toThrow(/cursor/i);
    expect(() => f.store.maps(f.review.id, { cursor: "not-json" })).toThrow(
      /cursor/i,
    );
    const other = await f.createReview();
    expect(() => f.store.maps(other.id, { cursor })).toThrow(/cursor/i);
  });

  it("rechecks map CAS after fresh source validation on a separate connection", async () => {
    const f = await fixture();
    const first = await f.createMap();
    const secondStore = openStore(f.databasePath);
    const entered = gate(),
      release = gate();
    const provider = new LocalEvidenceProvider((id) =>
      secondStore.repositoryPath(id),
    );
    const slow = new ReviewHost(secondStore, {
      evidence: {
        async resolve(...args: Parameters<LocalEvidenceProvider["resolve"]>) {
          const value = await provider.resolve(...args);
          entered.resolve();
          await release.promise;
          return value;
        },
      },
    });
    const pending = slow.command(
      f.author,
      f.command("map.mutate", {
        reviewId: f.review.id,
        mapId: first.mapId,
        expectedVersion: 0,
        operations: [
          {
            op: "element.put",
            element: {
              ...first.elements.app!,
              source: [f.span, { ...f.span, fromLine: 2, toLine: 2 }],
            },
          },
        ],
      }),
    );
    await entered.promise;
    const concurrent = await f.host.command(
      f.author,
      f.command("map.mutate", {
        reviewId: f.review.id,
        mapId: first.mapId,
        expectedVersion: 0,
        operations: [
          {
            op: "element.put",
            element: { ...first.elements.app!, label: "Concurrent" },
          },
        ],
      }),
    );
    const baseline = counts(f.databasePath);
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(counts(f.databasePath)).toEqual(baseline);
    expect(secondStore.currentMap(f.review.id, first.mapId)).toEqual(
      concurrent.result,
    );
  });
});

describe("retained trace and image evidence", () => {
  it("retains selected trace event IDs/ordinals with client-supplied provenance and publishes no excerpt text in events", async () => {
    const f = await fixture();
    const before = f.store.cursor();
    const request = f.command("trace.ingest", {
      reviewId: f.review.id,
      label: "Selected events",
      events: [
        { ...f.event, id: randomUUID(), ordinal: 10, text: "Later event" },
        f.event,
      ],
    });
    const response = await f.host.command(f.author, request);
    const trace = HOST_COMMAND_DEFINITIONS["trace.ingest"].result.parse(
      response.result,
    );
    expect(trace).toMatchObject({
      provenance: "client_supplied",
      sessionId: null,
      version: 0,
    });
    const retained = HOST_QUERY_DEFINITIONS["trace.get"].result.parse(
      (
        await f.host.query(
          f.author,
          f.query("trace.get", { reviewId: f.review.id, traceId: trace.id }),
        )
      ).result,
    );
    expect(retained.events.map((event) => event.ordinal)).toEqual([5, 10]);
    expect(retained.events[0]).toMatchObject({
      id: f.event.id,
      text: f.event.text,
      traceId: trace.id,
    });
    expect(
      JSON.stringify(f.host.events(f.author, f.store.workspaceId, before)),
    ).not.toContain(f.event.text);
    closeStore(f.store);
    const restarted = new ReviewHost(openStore(f.databasePath));
    expect(await restarted.command(f.author, request)).toEqual(response);
    expect(restarted.store.trace(f.review.id, trace.id)).toEqual(retained);
  });

  it("rejects duplicate trace identities, oversized UTF-8 text and cross-review parents", async () => {
    const f = await fixture();
    const baseline = counts(f.databasePath);
    for (const events of [
      [f.event, { ...f.event, ordinal: 9 }],
      [f.event, { ...f.event, id: randomUUID() }],
    ])
      await expect(
        f.host.command(
          f.author,
          f.command("trace.ingest", {
            reviewId: f.review.id,
            label: "Duplicate",
            events,
          }),
        ),
      ).rejects.toMatchObject({ name: "HostDocumentValidationError" });
    await expect(
      f.host.command(
        f.author,
        f.command("trace.ingest", {
          reviewId: f.review.id,
          label: "Large",
          events: [{ ...f.event, text: "é".repeat(100_000) }],
        }),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
    expect(counts(f.databasePath)).toEqual(baseline);
    const trace = HOST_COMMAND_DEFINITIONS["trace.ingest"].result.parse(
      (await f.host.command(f.author, f.traceRequest())).result,
    );
    const other = await f.createReview();
    await expect(
      f.host.command(
        f.author,
        f.command("trace.ingest", {
          reviewId: other.id,
          parentTraceId: trace.id,
          label: "Unrelated",
          events: [f.event],
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.each(["png", "jpeg", "webp"] as const)(
    "fully decodes and retains %s bytes and verified dimensions in the shared database",
    async (format) => {
      const f = await fixture();
      const bytes = await imageBytes(format);
      const request = f.command("asset.upload", {
        reviewId: f.review.id,
        mimeType: `image/${format}`,
        base64: bytes.toString("base64"),
      });
      const response = await f.host.command(f.author, request);
      const asset = HostAssetSchema.parse(response.result);
      expect(asset).toMatchObject({
        mimeType: `image/${format}`,
        width: 2,
        height: 3,
        byteLength: bytes.length,
      });
      const read = HOST_QUERY_DEFINITIONS["asset.get"].result.parse(
        (
          await f.host.query(
            f.author,
            f.query("asset.get", { reviewId: f.review.id, assetId: asset.id }),
          )
        ).result,
      );
      expect(Buffer.from(read.base64, "base64")).toEqual(bytes);
      const duplicate = HostAssetSchema.parse(
        (
          await f.host.command(
            f.author,
            f.command("asset.upload", {
              reviewId: f.review.id,
              mimeType: `image/${format}`,
              base64: bytes.toString("base64"),
            }),
          )
        ).result,
      );
      expect(duplicate.id).not.toBe(asset.id);
      expect(duplicate.sha256).toBe(asset.sha256);
      expect(counts(f.databasePath)).toMatchObject({ assets: 2, blobs: 1 });
      closeStore(f.store);
      const restarted = new ReviewHost(openStore(f.databasePath));
      expect(await restarted.command(f.author, request)).toEqual(response);
      expect(
        Buffer.from(restarted.store.asset(f.review.id, asset.id).bytes),
      ).toEqual(bytes);
    },
  );

  it("accepts supported image bodies above 2 MiB while enforcing the retained 5 MiB limit", async () => {
    const f = await fixture();
    const bytes = await sharp(randomBytes(1100 * 1100 * 3), {
      raw: { width: 1100, height: 1100, channels: 3 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(bytes.length).toBeGreaterThan(HOST_LIMITS.commandBytes);
    expect(bytes.length).toBeLessThan(HOST_LIMITS.assetBytes);
    const asset = HostAssetSchema.parse(
      (
        await f.host.command(
          f.author,
          f.command("asset.upload", {
            reviewId: f.review.id,
            mimeType: "image/png",
            base64: bytes.toString("base64"),
          }),
        )
      ).result,
    );
    expect(asset.byteLength).toBe(bytes.length);
    expect(() =>
      f.command("asset.upload", {
        reviewId: f.review.id,
        mimeType: "image/png",
        base64: Buffer.alloc(HOST_LIMITS.assetBytes + 3).toString("base64"),
      }),
    ).toThrow(/base64/);
  });

  it("rejects SVG, MIME mismatches, malformed raster data and noncanonical base64 without writes", async () => {
    const f = await fixture();
    const bytes = await imageBytes();
    const baseline = counts(f.databasePath);
    for (const input of [
      {
        mimeType: "image/png",
        base64: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"/>',
        ).toString("base64"),
      },
      { mimeType: "image/jpeg", base64: bytes.toString("base64") },
      {
        mimeType: "image/png",
        base64: bytes.subarray(0, 32).toString("base64"),
      },
      { mimeType: "image/png", base64: "AB==" },
    ])
      await expect(
        f.host.command(
          f.author,
          f.command("asset.upload", { reviewId: f.review.id, ...input }),
        ),
      ).rejects.toMatchObject({ name: "HostDocumentValidationError" });
    expect(counts(f.databasePath)).toEqual(baseline);
  });

  it("rejects a valid raster exceeding the pixel limit before retaining its compressed body", async () => {
    const f = await fixture();
    const bytes = await sharp({
      create: { width: 5000, height: 4001, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const baseline = counts(f.databasePath);
    await expect(
      f.host.command(
        f.author,
        f.command("asset.upload", {
          reviewId: f.review.id,
          mimeType: "image/png",
          base64: bytes.toString("base64"),
        }),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
    expect(counts(f.databasePath)).toEqual(baseline);
  });
});

describe("resource ownership, document dependencies and atomicity", () => {
  it("retains rich document dependencies across publication, later resource revisions, source loss and restart", async () => {
    const f = await fixture();
    const map = await f.createMap();
    const trace = HOST_COMMAND_DEFINITIONS["trace.ingest"].result.parse(
      (await f.host.command(f.author, f.traceRequest())).result,
    );
    const asset = HostAssetSchema.parse(
      (
        await f.host.command(
          f.author,
          f.command("asset.upload", {
            reviewId: f.review.id,
            mimeType: "image/png",
            base64: (await imageBytes()).toString("base64"),
          }),
        )
      ).result,
    );
    await f.host.command(
      f.author,
      f.command("document.mutate", {
        reviewId: f.review.id,
        expectedDocumentVersion: 0,
        operations: [
          {
            op: "node.insert",
            node: {
              id: "map",
              type: "software_map",
              mapVersionId: map.id,
              focusElementId: "app",
            },
            placement: { parentId: null, afterId: null },
          },
          {
            op: "node.insert",
            node: {
              id: "trace",
              type: "trace_quote",
              traceId: trace.id,
              eventId: f.event.id,
              text: "removes per-review files",
            },
            placement: { parentId: null, afterId: "map" },
          },
          {
            op: "node.insert",
            node: {
              id: "image",
              type: "image",
              assetId: asset.id,
              alt: "Storage diagram",
            },
            placement: { parentId: null, afterId: "trace" },
          },
        ],
      }),
    );
    const checkpoint = HOST_COMMAND_DEFINITIONS["review.publish"].result.parse(
      (
        await f.host.command(
          f.author,
          f.command("review.publish", {
            reviewId: f.review.id,
            expectedDocumentVersion: 1,
            expectedReviewVersion: 0,
            mapVersions: { base: null, head: map.id },
          }),
        )
      ).result,
    );
    await f.host.command(
      f.author,
      f.command("map.mutate", {
        reviewId: f.review.id,
        mapId: map.mapId,
        expectedVersion: 0,
        operations: [
          {
            op: "element.put",
            element: { ...map.elements.app!, label: "Changed later" },
          },
        ],
      }),
    );
    renameSync(f.repositoryPath, path.join(f.directory, "offline-repository"));
    closeStore(f.store);
    const store = openStore(f.databasePath);
    const host = new ReviewHost(store);
    expect(store.checkpoint(f.review.id, checkpoint.id).mapVersions.head).toBe(
      map.id,
    );
    expect(store.mapVersion(f.review.id, map.id)).toEqual(map);
    expect(store.trace(f.review.id, trace.id).events[0]?.text).toBe(
      f.event.text,
    );
    expect(store.asset(f.review.id, asset.id).asset).toEqual(asset);
    const validated = HOST_QUERY_DEFINITIONS["document.validate"].result.parse(
      (
        await host.query(
          f.author,
          f.query("document.validate", {
            reviewId: f.review.id,
            expectedDocumentVersion: 1,
            operations: [
              {
                op: "node.replace",
                node: {
                  id: "image",
                  type: "image",
                  assetId: asset.id,
                  alt: "Retained storage diagram",
                },
              },
            ],
          }),
        )
      ).result,
    );
    expect(validated.valid).toBe(true);
  });

  it("rejects cross-review resource references, fake quotations and maps on the wrong published side", async () => {
    const f = await fixture();
    const map = await f.createMap();
    const trace = HOST_COMMAND_DEFINITIONS["trace.ingest"].result.parse(
      (await f.host.command(f.author, f.traceRequest())).result,
    );
    const other = await f.createReview();
    await expect(
      f.host.query(
        f.author,
        f.query("map.get", { reviewId: other.id, mapVersionId: map.id }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      f.host.command(
        f.author,
        f.command("document.mutate", {
          reviewId: other.id,
          expectedDocumentVersion: 0,
          operations: [
            {
              op: "node.insert",
              node: { id: "map", type: "software_map", mapVersionId: map.id },
              placement: { parentId: null, afterId: null },
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ name: "HostDocumentValidationError" });
    await expect(
      f.host.command(
        f.author,
        f.command("document.mutate", {
          reviewId: f.review.id,
          expectedDocumentVersion: 0,
          operations: [
            {
              op: "node.insert",
              node: {
                id: "quote",
                type: "trace_quote",
                traceId: trace.id,
                eventId: f.event.id,
                text: "a quotation the agent never said",
              },
              placement: { parentId: null, afterId: null },
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ name: "HostDocumentValidationError" });
    await expect(
      f.host.command(
        f.author,
        f.command("review.publish", {
          reviewId: f.review.id,
          expectedDocumentVersion: 0,
          expectedReviewVersion: 0,
          mapVersions: { base: map.id, head: null },
        }),
      ),
    ).rejects.toMatchObject({ name: "HostDocumentValidationError" });
    expect(f.store.checkpoints(f.review.id)).toEqual([]);
  });

  it("rolls back resource versions, retained bytes, events and receipts as one transaction", async () => {
    const f = await fixture();
    const resources = new ReviewResources(
      f.store,
      new LocalEvidenceProvider((id) => f.store.repositoryPath(id)),
    );
    const mutations = await Promise.all([
      resources.prepare({
        type: "map.create",
        input: {
          reviewId: f.review.id,
          documentVersion: 0,
          side: "head",
          map: f.map,
        },
      }),
      resources.prepare({
        type: "trace.ingest",
        input: { reviewId: f.review.id, label: "Excerpt", events: [f.event] },
      }),
      resources.prepare({
        type: "asset.upload",
        input: {
          reviewId: f.review.id,
          mimeType: "image/png",
          base64: (await imageBytes()).toString("base64"),
        },
      }),
    ]);
    const baseline = counts(f.databasePath);
    expect(() => mutations[0]!()).toThrow(/command transaction/);
    expect(() =>
      f.store.command(
        {
          clientId: "test",
          commandId: randomUUID(),
          request: { type: "fault-injection" },
        },
        () => {
          for (const mutation of mutations) mutation();
          throw new Error("Transaction aborted");
        },
      ),
    ).toThrow(/Transaction aborted/);
    expect(counts(f.databasePath)).toEqual(baseline);
  });

  it("detects corruption of retained maps, traces, and image bytes at read time", async () => {
    const f = await fixture();
    const map = await f.createMap();
    const trace = HOST_COMMAND_DEFINITIONS["trace.ingest"].result.parse(
      (await f.host.command(f.author, f.traceRequest())).result,
    );
    const asset = HostAssetSchema.parse(
      (
        await f.host.command(
          f.author,
          f.command("asset.upload", {
            reviewId: f.review.id,
            mimeType: "image/png",
            base64: (await imageBytes()).toString("base64"),
          }),
        )
      ).result,
    );
    const db = new DatabaseSync(f.databasePath);
    try {
      db.prepare(
        "UPDATE host_map_versions SET record_json=json_set(record_json,'$.elements.app.label','Corrupt') WHERE id=?",
      ).run(map.id);
      db.prepare(
        "UPDATE host_traces SET record_json=json_set(record_json,'$.events[0].text','Corrupt') WHERE id=?",
      ).run(trace.id);
      db.prepare("UPDATE host_asset_blobs SET bytes=x'00' WHERE hash=?").run(
        asset.sha256,
      );
    } finally {
      db.close();
    }
    expect(() => f.store.mapVersion(f.review.id, map.id)).toThrow(/integrity/);
    expect(() => f.store.trace(f.review.id, trace.id)).toThrow(/integrity/);
    expect(() => f.store.asset(f.review.id, asset.id)).toThrow(/integrity/);
  });
});
