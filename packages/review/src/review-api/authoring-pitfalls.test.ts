import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { type JsonValue, parseJsonText } from "@dev.fast/review-protocol";
import type { Hono } from "hono";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FIXTURE_IMAGE_ID,
  FIXTURE_MAP_ID,
  FIXTURE_TRACE_EVENT_ID,
  FIXTURE_TRACE_ID,
  readBlockFixtures,
} from "../fixtures/blocks/fixtures.js";
import { selectSource } from "../lens-selection.js";
import { type Pins, elements } from "./document.js";
import { createSessionApi } from "./http.js";
import { openLocalSessionStore } from "./local-data.js";

let directory: string, repository: string, pins: Pins, sessionId: string;

let local: ReturnType<typeof openLocalSessionStore>;

let app: Hono;

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();

const head = (file: string, fromLine: number, toLine = fromLine) => ({
  side: "head" as const,
  file,
  fromLine,
  toLine,
});

interface Reply {
  status: number;
  body: { error?: string; targetId?: string; sessionId?: string };
}

/** Post a command the way `review mcp` does and return status and body. */
async function post(route: string, body: JsonValue): Promise<Reply> {
  const response = await app.request(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return { status: response.status, body: await response.json() };
}

const insert = (content: JsonValue) =>
  post("/commands", {
    commandId: randomUUID(),
    operation: {
      type: "edit",
      sessionId,
      edit: { type: "insert", content },
    },
  });

/** Every rejection must leave the stored document byte-identical. */
async function expectRejected(
  send: () => Promise<Reply>,
  message: string | RegExp,
  status = 400,
) {
  const before = JSON.stringify(local.store.read(sessionId));
  const result = await send();

  expect({ status: result.status, body: result.body }).toMatchObject({
    status,
  });
  expect(result.body.error).toMatch(message);
  expect(JSON.stringify(local.store.read(sessionId))).toBe(before);
}

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "review-pitfalls-"));
  repository = path.join(directory, "repository");
  vi.stubEnv("DEV_WHITEBOARD_HOME", directory);
  mkdirSync(path.join(repository, "src"), { recursive: true });
  mkdirSync(path.join(repository, "assets"));
  git("init", "-q");
  git("config", "user.name", "Pitfall Test");
  git("config", "user.email", "pitfalls@example.invalid");
  writeFileSync(
    path.join(repository, "src/store.ts"),
    "export const value = 1;\n",
  );
  // The block fixtures reference order.ts, as the authored corpus does.
  writeFileSync(path.join(repository, "order.ts"), 'status = "draft";\n');
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Base");
  writeFileSync(
    path.join(repository, "src/store.ts"),
    "export function save(order) {\n  return db.insert(order);\n}\n",
  );
  writeFileSync(path.join(repository, "order.ts"), 'status = "queued";\n');
  writeFileSync(
    path.join(repository, "src/blank.ts"),
    "export const a = 1;\n\n\n// end\n",
  );
  writeFileSync(
    path.join(repository, "assets/logo.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
  );
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Head");
  local = openLocalSessionStore(path.join(directory, "reviews.db"));
  const registered = await local.data.register(repository);
  pins = await local.data.resolvePins(registered.id, "HEAD^", "HEAD");
  app = createSessionApi(local.store, local.data);

  const created = await post("/commands", {
    commandId: randomUUID(),
    operation: { type: "create", title: "Pitfalls", pins },
  });

  sessionId = created.body.sessionId!;
});

afterEach(async () => {
  await local.store.close();
  await local.data.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

const lensBase = {
  type: "database_lens",
  title: "Storage",
  actors: { app: "App" },
  stores: {
    orders: {
      label: "Orders",
      storage: "relational",
      collections: {
        orders: {
          label: "orders",
          fields: { id: { label: "id", dataType: "uuid" } },
        },
      },
    },
  },
};

const operation = {
  kind: "write",
  store: "orders",
  collection: "orders",
  field: "id",
  actor: "app",
  label: "Insert",
  source: selectSource(head("src/store.ts", 1, 2)),
};

describe("lens rules the mount used to be the only guard for", () => {
  it("rejects a lens with no stores", () =>
    expectRejected(
      () =>
        insert({
          ...lensBase,
          stores: {},
          useCases: [{ label: "x", operations: [operation] }],
        }),
      "A database lens needs at least one store.",
    ));

  it("rejects a lens with no use cases", () =>
    expectRejected(
      () => insert({ ...lensBase, useCases: [] }),
      "A database lens needs at least one use case.",
    ));

  it("rejects a use case with no operations", () =>
    expectRejected(
      () => insert({ ...lensBase, useCases: [{ label: "x", operations: [] }] }),
      "A use case needs at least one operation.",
    ));

  it("rejects an operation naming an unknown actor, store, collection or field", async () => {
    for (const [patch, name] of [
      [{ actor: "worker" }, "worker"],
      [{ store: "cache" }, "cache"],
      [{ collection: "lines" }, "lines"],
      [{ field: "total" }, "total"],
    ] as const)
      await expectRejected(
        () =>
          insert({
            ...lensBase,
            useCases: [
              { label: "x", operations: [{ ...operation, ...patch }] },
            ],
          }),
        `Unknown component name: ${name}`,
      );
  });

  it("rejects a foreign key to a field that does not exist", () =>
    expectRejected(
      () =>
        insert({
          ...lensBase,
          stores: {
            orders: {
              ...lensBase.stores.orders,
              collections: {
                orders: {
                  label: "orders",
                  fields: {
                    id: { label: "id", dataType: "uuid" },
                    customer: {
                      label: "customer",
                      dataType: "uuid",
                      references: {
                        store: "orders",
                        collection: "orders",
                        field: "email",
                      },
                    },
                  },
                },
              },
            },
          },
          useCases: [{ label: "x", operations: [operation] }],
        }),
      "Unknown component name: email",
    ));
});

describe("diagram rules", () => {
  const sequence = (steps: JsonValue[]) => ({
    type: "sequence",
    title: "Save",
    actors: { app: "App", db: "Database" },
    steps,
  });

  it("rejects a step naming an actor the diagram does not declare", () =>
    expectRejected(
      () =>
        insert(
          sequence([
            { from: "app", to: "cache", label: "Write", explanation: "x" },
          ]),
        ),
      "Unknown component name: cache",
    ));

  it("rejects a step with none or two of source, explanation and code", async () => {
    await expectRejected(
      () => insert(sequence([{ from: "app", to: "db", label: "Write" }])),
      "A step needs exactly one of source, explanation, or code.",
    );
    await expectRejected(
      () =>
        insert(
          sequence([
            {
              from: "app",
              to: "db",
              label: "Write",
              explanation: "x",
              code: { text: "y" },
            },
          ]),
        ),
      "A step needs exactly one of source, explanation, or code.",
    );
  });

  it("rejects duplicate frame keys within a column", async () => {
    const baseSource = { ...head("src/store.ts", 1), side: "base" as const };

    await expectRejected(
      () =>
        insert({
          type: "call_stack_diff",
          title: "Save",
          base: [
            { key: "save", source: selectSource(baseSource) },
            { key: "save", source: selectSource(baseSource) },
          ],
          head: [],
        }),
      "Frame keys must be unique within base.",
    );
  });

  it("keeps each frame's source pin when both columns use the same snapshot", async () => {
    const baseSource = head("order.ts", 1);
    const headSource = head("src/store.ts", 2);

    const result = await insert({
      type: "call_stack_diff",
      title: "Two paths in the head snapshot",
      base: [{ source: selectSource(baseSource) }],
      head: [{ source: selectSource(headSource) }],
    });

    expect(result.status).toBe(200);
    expect(local.store.read(sessionId).document).toContainEqual(
      expect.objectContaining({
        type: "call_stack_diff",
        base: [expect.objectContaining({ source: selectSource(baseSource) })],
        head: [expect.objectContaining({ source: selectSource(headSource) })],
      }),
    );
  });
});

describe("source rules in every peek position", () => {
  const blank = head("src/blank.ts", 2, 3);

  it("rejects a whitespace-only range as a code peek, a step, a frame and a lens operation", async () => {
    const message = "src/blank.ts:2-3 contains only whitespace";

    await expectRejected(
      () => insert({ type: "code_peek", source: selectSource(blank) }),
      message,
    );
    await expectRejected(
      () =>
        insert({
          type: "sequence",
          title: "Save",
          actors: { app: "App" },
          steps: [
            {
              from: "app",
              to: "app",
              label: "Write",
              source: selectSource(blank),
            },
          ],
        }),
      message,
    );
    await expectRejected(
      () =>
        insert({
          type: "call_stack_diff",
          title: "Save",
          base: [],
          head: [{ source: selectSource(blank) }],
        }),
      message,
    );
    await expectRejected(
      () =>
        insert({
          ...lensBase,
          useCases: [
            {
              label: "x",
              operations: [{ ...operation, source: selectSource(blank) }],
            },
          ],
        }),
      message,
    );
  });

  it("accepts a prose link to the same blank lines", async () => {
    const result = await insert({
      type: "markdown",
      markdown: "See [the gap](whiteboard-source:head/src/blank.ts#L2-L3).",
    });

    expect(result.status).toBe(200);
  });

  it("rejects bad paths and ranges", async () => {
    await expectRejected(
      () =>
        insert({
          type: "code_peek",
          source: selectSource(head("../etc/passwd", 1)),
        }),
      "Source file must be a repository-relative path.",
    );
    await expectRejected(
      () =>
        insert({
          type: "code_peek",
          source: selectSource(head("src/store.ts", 1, 99)),
        }),
      /exceeds the pinned file/,
    );
    await expectRejected(
      () =>
        insert({
          type: "code_peek",
          source: selectSource(head("src/store.ts", 3, 1)),
        }),
      "Source range ends before it starts.",
    );
    await expectRejected(
      () =>
        insert({
          type: "code_peek",
          source: selectSource(head("src/missing.ts", 1)),
        }),
      "File is unavailable at the pinned commit.",
      404,
    );
    await expectRejected(
      () =>
        insert({
          type: "code_peek",
          source: selectSource(head("assets/logo.png", 1)),
        }),
      "Binary files cannot be used as code references.",
    );
  });

  it("rejects relative file links without saving and accepts the corrected source link", async () => {
    await expectRejected(
      () => insert({ type: "markdown", markdown: "[store](src/store.ts#L1)" }),
      /Unsupported Markdown link "src\/store.ts#L1".*Use \[label\]\(whiteboard-source:head\/path#L10-L24\)/,
    );

    const result = await insert({
      type: "markdown",
      markdown: "[store](whiteboard-source:head/src/store.ts#L1)",
    });

    expect(result.status).toBe(200);
  });

  it("rejects malformed and badly encoded prose source links", async () => {
    await expectRejected(
      () =>
        insert({
          type: "markdown",
          markdown: "[x](whiteboard-source:head/src/store.ts)",
        }),
      "Use whiteboard-source:head/path#L10-L24 (or base) for a source link.",
    );
    await expectRejected(
      () =>
        insert({
          type: "markdown",
          markdown: "[x](whiteboard-source:head/src/%E0%A4%A.ts#L1)",
        }),
      "Invalid URL encoding in source link.",
    );
  });
});

describe("edit protocol rules", () => {
  it("rejects content that supplies its own id", () =>
    expectRejected(
      () => insert({ id: "block-9", type: "divider" }),
      "IDs are assigned by the server.",
    ));

  it("rejects a patch that touches a structural field and accepts a null that removes an optional one", async () => {
    const inserted = await insert({ type: "code", text: "x", caption: "Old" });
    const targetId = inserted.body.targetId!;

    await expectRejected(
      () =>
        post("/commands", {
          commandId: randomUUID(),
          operation: {
            type: "edit",
            sessionId,
            edit: { type: "update", targetId, changes: { type: "markdown" } },
          },
        }),
      "Cannot patch type; use structural edits or replace.",
    );

    const cleared = await post("/commands", {
      commandId: randomUUID(),
      operation: {
        type: "edit",
        sessionId,
        edit: { type: "update", targetId, changes: { caption: null } },
      },
    });

    expect(cleared.status).toBe(200);
    expect(local.store.read(sessionId).document[0]).not.toHaveProperty(
      "caption",
    );
  });
});

describe("the fixtures are what the API accepts", () => {
  it("inserts every fixture block through the API with real resources and reads it back", async () => {
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

    const trace = {
      id: randomUUID(),
      repositoryId: pins.repositoryId,
      kind: "trace",
      trace: {
        label: "Fixture conversation",
        events: [
          {
            id: FIXTURE_TRACE_EVENT_ID,
            role: "assistant",
            text: "Please queue the order once the row is written.",
          },
        ],
      },
    };

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
                  save: {
                    codeElements: {
                      value: {
                        sourceRanges: [
                          { file: "src/store.ts", fromLine: 1, toLine: 2 },
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

    for (const upload of [image, trace, map]) {
      const uploaded = await post("/resources", upload);

      expect({ status: uploaded.status, body: uploaded.body }).toMatchObject({
        status: 200,
      });
    }

    const resourceIds = {
      [FIXTURE_IMAGE_ID]: image.id,
      [FIXTURE_TRACE_ID]: trace.id,
      [FIXTURE_MAP_ID]: map.id,
    };

    // Ids are assigned by the store; placeholder resource ids become real uploads.
    const substitute = (value: JsonValue): JsonValue =>
      parseJsonText(
        JSON.stringify(value, (key, child) =>
          key === "id"
            ? undefined
            : Object.hasOwn(resourceIds, String(child))
              ? resourceIds[String(child) as keyof typeof resourceIds]
              : child,
        ),
      );

    for (const [type, samples] of await readBlockFixtures())
      for (const sample of samples) {
        const result = await insert(substitute(sample));

        expect({ type, status: result.status, body: result.body }).toEqual({
          type,
          status: 200,
          body: result.body,
        });

        const written = elements(local.store.read(sessionId).document).find(
          (element) => element.id === result.body.targetId,
        );

        expect(written?.type).toBe(type);
      }
  });
});
