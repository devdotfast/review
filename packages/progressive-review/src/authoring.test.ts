import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import {
  type CodePeekResolution,
  createReviewDefinitionSession,
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

function resolvedCodePeek(): CodePeekResolution {
  const sourceId = "source-range:src/example.ts:1-1";
  return {
    snapshot: {
      roots: [{ kind: "source", sourceId }],
      resolved: {
        [sourceId]: {
          source: {
            id: sourceId,
            name: "example.ts L1-L1",
            kind: "source-range",
            file: "src/example.ts",
            line: 1,
            endLine: 1,
          },
          lines: [[{ t: "export function example() {}", k: "t" }]],
        },
      },
    },
    diff: {
      orientation: "head",
      files: [
        {
          path: "src/example.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch:
            "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-export function example() {}\n+export function example() { return true; }",
        },
      ],
    },
  };
}

describe("Review definition session", () => {
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
    expect(anchors.startup.peek.resolution).toBeNull();
  });

  it("resolves range anchors before the document module becomes ready", async () => {
    const resolveCodePeek = vi.fn<() => Promise<CodePeekResolution>>(async () =>
      resolvedCodePeek(),
    );
    const map = reviewMap();
    const session = createReviewDefinitionSession({
      softwareMap: map,
      baseSoftwareMap: map,
      resolveCodePeek,
    });

    const anchors = session.defineAnchors({
      startup: {
        title: "Startup",
        peek: { file: "src/example.ts", fromLine: 1, toLine: 3 },
        softwareMapPath: "review.canvas",
      },
    });

    expect(anchors.startup.peek.resolution).toBeNull();
    await session.ready();
    expect(resolveCodePeek).toHaveBeenCalledWith(
      { file: "src/example.ts", fromLine: 1, toLine: 3 },
      { anchorId: "startup" },
    );
    expect(anchors.startup.peek.resolution).toEqual(resolvedCodePeek());
  });

  it("rejects nonexistent software-map paths at the define boundary", () => {
    const map = reviewMap();
    const session = createReviewDefinitionSession({
      softwareMap: map,
      baseSoftwareMap: map,
      resolveCodePeek: async () => ({
        snapshot: { roots: [], resolved: {} },
      }),
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
      resolveCodePeek: async () => {
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

  it("allows anchors to use resolved source outside the diff", async () => {
    const map = reviewMap();
    const emptyResolution = resolvedCodePeek();
    emptyResolution.diff = undefined;
    const session = createReviewDefinitionSession({
      softwareMap: map,
      baseSoftwareMap: map,
      resolveCodePeek: async () => emptyResolution,
    });
    session.defineAnchors({
      empty: {
        title: "Empty",
        peek: { file: "src/example.ts", fromLine: 1, toLine: 3 },
      },
    });

    await expect(session.ready()).resolves.toBeUndefined();
  });

  it("rejects anchors whose code peek resolves without source", async () => {
    const map = reviewMap();
    const session = createReviewDefinitionSession({
      softwareMap: map,
      baseSoftwareMap: map,
      resolveCodePeek: async () => ({
        snapshot: { roots: [], resolved: {} },
      }),
    });
    session.defineAnchors({
      empty: {
        title: "Empty",
        peek: { file: "src/example.ts", fromLine: 1, toLine: 3 },
      },
    });

    await expect(session.ready()).rejects.toThrow(
      "Code reference resolved without source",
    );
  });
});
