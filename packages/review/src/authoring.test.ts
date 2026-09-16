import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import {
  type StoreRefData,
  collectionSchema,
  createReviewDefinitionSession,
  hydrateStoreRef,
  resolveTargetRef,
  storeRefData,
} from "./authoring";
import { defineSoftwareMap } from "./software-map-model";

function reviewMap() {
  return defineSoftwareMap({
    systems: {
      review: {
        label: "Review",
        containers: {
          canvas: { label: "Canvas" },
        },
      },
    },
  });
}

describe("Review definition session", () => {
  it("round-trips store handles through JSON data", () => {
    const session = createReviewDefinitionSession({
      softwareMap: null,
      baseSoftwareMap: null,
    });

    const stores = session.defineStores({
      db: {
        kind: "relational",
        label: "DB",
        tables: {
          orders: {
            label: "orders",
            schema: {
              id: { type: "text", pk: true },
              status: { type: "text" },
            },
          },
        },
      },
    });

    const data = JSON.parse(
      JSON.stringify(storeRefData(stores.db)),
    ) as StoreRefData;

    expect(data.tables?.orders?.target).toMatchObject({
      __kind: "db-target-ref",
      storeId: "db",
      collectionId: "orders",
      path: [],
    });

    const hydrated = hydrateStoreRef(data);
    expect(collectionSchema(hydrated.tables!.orders!)).toEqual({
      id: { type: "text", pk: true },
      status: { type: "text" },
    });
    expect(resolveTargetRef(hydrated.tables!.orders!.status)).toMatchObject({
      collectionId: "orders",
      path: ["status"],
    });
  });

  it("reports map-dependent document components when no map is materialized", async () => {
    const session = createReviewDefinitionSession({
      softwareMap: null,
      baseSoftwareMap: null,
      mapDependentComponents: ["SoftwareMap"],
    });

    await expect(session.ready()).resolves.toBeUndefined();
    expect(session.diagnostics).toEqual([
      {
        code: "software-map-unavailable",
        level: "info",
        component: "SoftwareMap",
        message:
          "Document uses SoftwareMap but no software map is materialized for this repo; author one with `review map` or remove the section.",
        remediation: "review map",
      },
    ]);
  });

  it("keeps map-free definitions usable when no map is materialized", async () => {
    const session = createReviewDefinitionSession({
      softwareMap: null,
      baseSoftwareMap: null,
    });

    const anchors = session.defineAnchors({
      startup: {
        title: "Startup",
        peek: { file: "src/example.ts", fromLine: 1, toLine: 3 },
      },
    });

    await expect(session.ready()).resolves.toBeUndefined();
    expect(anchors.startup.title).toBe("Startup");
    expect(session.diagnostics).toEqual([]);
  });

  it("reports software-map paths without rejecting definitions when the map is absent", () => {
    const session = createReviewDefinitionSession({
      softwareMap: null,
      baseSoftwareMap: null,
    });

    const actors = session.defineActors({
      browser: {
        label: "Browser",
        softwareMapPath: "review.browser",
      },
    });

    expect(actors.browser.softwareMapPath).toBe("review.browser");
    expect(session.diagnostics).toEqual([
      {
        code: "software-map-unavailable",
        level: "info",
        message:
          "Definition references softwareMapPath but no software map is materialized for this repo; author one with `review map` or remove the reference.",
        remediation: "review map",
        path: ["browser", "softwareMapPath"],
      },
    ]);
  });

  it("can defer range resolution for client definitions", async () => {
    const map = reviewMap();

    const session = createReviewDefinitionSession({
      softwareMap: map,
      baseSoftwareMap: map,
    });

    const anchors = session.defineAnchors({
      startup: {
        title: "Startup",
        peek: { file: "src/example.ts", fromLine: 1, toLine: 3 },
      },
    });

    await expect(session.ready()).resolves.toBeUndefined();
    expect(anchors.startup.peek).toEqual({
      side: "head",
      file: "src/example.ts",
      fromLine: 1,
      toLine: 3,
    });
  });

  it("validates range anchors before the document module becomes ready", async () => {
    const validateCodePeek = vi.fn<() => Promise<void>>(async () => {});

    const map = reviewMap();

    const session = createReviewDefinitionSession({
      softwareMap: map,
      baseSoftwareMap: map,
      validateCodePeek,
    });

    const anchors = session.defineAnchors({
      startup: {
        title: "Startup",
        peek: { file: "src/example.ts", fromLine: 1, toLine: 3 },
        softwareMapPath: "review.canvas",
      },
    });

    await session.ready();
    expect(validateCodePeek).toHaveBeenCalledWith(
      { file: "src/example.ts", fromLine: 1, toLine: 3 },
      { anchorId: "startup" },
    );
    expect(anchors.startup.peek).toEqual({
      side: "head",
      file: "src/example.ts",
      fromLine: 1,
      toLine: 3,
    });
  });

  it("rejects nonexistent software-map paths at the define boundary", () => {
    const map = reviewMap();

    const session = createReviewDefinitionSession({
      softwareMap: map,
      baseSoftwareMap: map,
    });

    expect(() =>
      session.defineActors({
        browser: {
          label: "Browser",
          softwareMapPath: "review.missing",
        },
      }),
    ).toThrow(ZodError);
  });

  it.each([
    ["defineActors", { browser: { label: "Browser", extra: true } }],
    [
      "defineAnchors",
      { request: { title: "Request", detail: "Request path", extra: true } },
    ],
    [
      "defineStores",
      { app: { kind: "relational", label: "App", extra: true } },
    ],
  ] as const)("rejects unknown keys in %s", (method, input) => {
    const map = reviewMap();

    const session = createReviewDefinitionSession({
      softwareMap: map,
      baseSoftwareMap: map,
    });

    expect(() => {
      if (method === "defineActors") session.defineActors(input as never);

      if (method === "defineAnchors") session.defineAnchors(input as never);

      if (method === "defineStores") session.defineStores(input as never);
    }).toThrow(ZodError);
  });

  it("surfaces range resolution failures from the module readiness barrier", async () => {
    const map = reviewMap();

    const session = createReviewDefinitionSession({
      softwareMap: map,
      baseSoftwareMap: map,
      validateCodePeek: async () => {
        throw new Error("Source range exceeds the file length");
      },
    });

    session.defineAnchors({
      missing: {
        title: "Missing",
        peek: { file: "src/example.ts", fromLine: 1, toLine: 3 },
      },
    });

    await expect(session.ready()).rejects.toThrow(
      "Code range could not be resolved in the pinned worktree: Source range exceeds the file length",
    );
  });

  it("allows anchors to use validated source outside the diff", async () => {
    const map = reviewMap();

    const session = createReviewDefinitionSession({
      softwareMap: map,
      baseSoftwareMap: map,
      validateCodePeek: async () => {},
    });

    session.defineAnchors({
      empty: {
        title: "Empty",
        peek: { file: "src/example.ts", fromLine: 1, toLine: 3 },
      },
    });

    await expect(session.ready()).resolves.toBeUndefined();
  });
});
