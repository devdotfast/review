import { readFileSync } from "node:fs";

import type { Edge as ReactFlowEdge } from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";

import { testReviewSession } from "../review-session-test-utils";
import { collapseInlineC4Node, projectInlineC4 } from "./c4-projection";
import { defineSoftwareModel } from "./model";
import {
  C4LayoutQueue,
  C4_MAP_HOTKEY_GROUPS,
  type InlineC4LayoutResult,
  type SoftwareMapNodeSnapshot,
  type SoftwareMapRelationshipSnapshot,
  type SoftwareMapResolvedSnapshot,
  buildSoftwareMapChangeSummaries,
  c4DisplayedSnapshotForCurrentState,
  c4EdgeEndpointBubbles,
  c4EdgePointsFromSections,
  c4LayoutSignature,
  c4MapReactFlowInteractionProps,
  c4PreviousInlineLayoutForRelationships,
  c4SpatialDirectionForKey,
  c4ViewportForNodeReveal,
  clearSoftwareMapNavigationStateForTests,
  createC4MapFlow,
  createC4MapFlowFromLayout,
  findSpatialC4Node,
  firstSoftwareMapChildNodeId,
  fitC4MapView,
  focusC4MapNode,
  focusC4MapNodeAndKeyboard,
  initialSoftwareMapExpandedNodeIds,
  parentSoftwareMapNodeId,
  positionC4EdgeLabels,
  rememberSoftwareMapNavigationState,
  restoreSoftwareMapNavigationState,
  runInlineC4Layout,
  runSerializedC4Layout,
  scheduleC4NodeMeasurements,
  seedSoftwareMapDefaultExpandedNodeIds,
  selectedSoftwareMapNodeIdForNodes,
  shouldApplySoftwareMapModifiedOnly,
  shouldAutoFocusC4MapKeyboardTarget,
  shouldShowSoftwareMapFloatingActions,
  softwareMapAncestorPaths,
  softwareMapChildNodeIdForDrill,
  softwareMapLiveDiagram,
  softwareMapNavigationKey,
  softwareMapNodeDiffPeeks,
  softwareMapNodeForKeyboardExpansion,
  softwareMapNodeIdForDrill,
  softwareMapNodeLabelPath,
  softwareMapNodeTargetPayload,
  softwareMapOverlayClassName,
  softwareMapRelationshipLabelPath,
  softwareMapResolvedDataInputForModel,
  softwareMapSnapshotFromInlineC4Projection,
  softwareMapViewportFocusNodeId,
  softwareMapViewportFocusTargetReady,
  toggledSoftwareMapExpandedNodeIds,
  toggledSoftwareMapViewportFocusRequest,
  visibleSoftwareMapChangeCount,
} from "./SoftwareMap";

function sourceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end);
  if (from === -1) throw new Error(`marker not found: ${start}`);
  if (to === -1) throw new Error(`marker not found: ${end}`);
  return source.slice(from, to);
}

type C4LayoutBoxForTest = {
  x: number;
  y: number;
  width: number;
  height: number;
};

describe("SoftwareMap inline C4 helpers", () => {
  it("derives coverage and source-range diffs for an aggregate map node", () => {
    const model = defineSoftwareModel({
      systems: {
        product: {
          containers: {
            runtime: {
              components: {
                api: {
                  coverage: {
                    files: [
                      {
                        path: "src/api.ts",
                        ranges: [{ fromLine: 8, toLine: 14 }],
                      },
                    ],
                  },
                },
                worker: {
                  codeElements: {
                    run: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                    },
                  },
                },
                removedJob: {
                  coverage: { files: ["src/removed-job.ts"] },
                },
              },
            },
          },
        },
      },
    });
    const summaries = buildSoftwareMapChangeSummaries(
      model,
      new Map([["product.runtime.worker.run", { additions: 2, deletions: 1 }]]),
      new Map([
        [
          "product.runtime.api",
          {
            additions: 1,
            deletions: 1,
            files: [
              {
                file: "src/api.ts",
                additions: 1,
                deletions: 1,
                hunks: [
                  {
                    startLine: 10,
                    lines: [
                      {
                        kind: "remove" as const,
                        oldLine: 10,
                        newLine: null,
                        text: "oldApi();",
                      },
                      {
                        kind: "add" as const,
                        oldLine: null,
                        newLine: 10,
                        text: "newApi();",
                      },
                    ],
                  },
                  {
                    startLine: 510,
                    lines: [
                      {
                        kind: "add" as const,
                        oldLine: null,
                        newLine: 510,
                        text: "newFarAwayApi();",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        [
          "product.runtime.removedJob",
          {
            additions: 0,
            deletions: 2,
            files: [
              {
                file: "src/removed-job.ts",
                additions: 0,
                deletions: 2,
                hunks: [
                  {
                    startLine: 20,
                    lines: [
                      {
                        kind: "remove" as const,
                        oldLine: 20,
                        newLine: null,
                        text: "runOldJob();",
                      },
                      {
                        kind: "remove" as const,
                        oldLine: 21,
                        newLine: null,
                        text: "finishOldJob();",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      ]),
    );

    const peeks = softwareMapNodeDiffPeeks({
      model,
      elementPath: "product.runtime",
      changeSummaries: summaries,
    });

    expect(peeks).toEqual([
      {
        file: "src/api.ts",
        fromLine: 10,
        toLine: 10,
        graph: "head",
      },
      {
        file: "src/api.ts",
        fromLine: 510,
        toLine: 510,
        graph: "head",
      },
      {
        file: "src/example.ts",
        fromLine: 1,
        toLine: 1,
        graph: "head",
      },
      {
        file: "src/removed-job.ts",
        fromLine: 20,
        toLine: 21,
        graph: "base",
      },
    ]);
  });

  it("keeps resolved inputs independent of expanded components", () => {
    const model = defineSoftwareModel({
      systems: {
        app: {
          label: "App",
          containers: {
            runtime: {
              label: "Runtime",
              components: {
                api: {
                  label: "API",
                  coverage: { globs: ["src/api/**"] },
                },
                ui: {
                  label: "UI",
                  coverage: { globs: ["src/ui/**"] },
                },
              },
            },
          },
        },
      },
    });

    const collapsed = softwareMapResolvedDataInputForModel(model);
    expect(collapsed.codeElements).toEqual([]);
    expect(collapsed.coverageClaims).toHaveLength(2);

    const expanded = softwareMapResolvedDataInputForModel(model, {
      expandedElementPaths: new Set(["app.runtime.api"]),
    });
    expect(expanded.codeElements).toEqual([]);
    expect(expanded.coverageClaims).toHaveLength(2);
  });

  it("derives ancestors for map-backed side peek focus requests", () => {
    expect(
      softwareMapAncestorPaths(
        "progressiveReview.reviewApp.databaseLens.persistOperation",
      ),
    ).toEqual([
      "progressiveReview",
      "progressiveReview.reviewApp",
      "progressiveReview.reviewApp.databaseLens",
    ]);
  });

  it("keeps authored-only maps visible when modified-only debug filtering is enabled", () => {
    expect(
      shouldApplySoftwareMapModifiedOnly({
        showModifiedOnly: true,
        resolvedDataReady: true,
        resolvedDataInput: {
          codeElements: [],
          coverageClaims: [],
        },
      }),
    ).toBe(false);
  });

  it("hides zero-value map diff counts", () => {
    expect(visibleSoftwareMapChangeCount(0)).toBe(0);
    expect(visibleSoftwareMapChangeCount(-1)).toBe(0);
    expect(visibleSoftwareMapChangeCount(Number.NaN)).toBe(0);
    expect(visibleSoftwareMapChangeCount(3)).toBe(3);
  });

  it("lets page wheel scrolling pass through inline C4 canvases", () => {
    const source = readFileSync(new URL("./SoftwareMap.tsx", import.meta.url), {
      encoding: "utf8",
    });

    expect(c4MapReactFlowInteractionProps("inline")).toEqual({
      panOnScroll: false,
      preventScrolling: false,
      zoomOnPinch: false,
      zoomOnScroll: false,
    });
    expect(source).toContain(
      'interactionMode={showChrome ? "inline" : "standalone"}',
    );
  });

  it("keeps full-canvas map interactions enabled outside inline review content", () => {
    expect(c4MapReactFlowInteractionProps("standalone")).toEqual({
      panOnScroll: false,
      preventScrolling: true,
      zoomOnPinch: true,
      zoomOnScroll: true,
    });
    expect(shouldAutoFocusC4MapKeyboardTarget("inline")).toBe(false);
    expect(shouldAutoFocusC4MapKeyboardTarget("standalone")).toBe(true);
  });

  it("resets figure margin so expanded maps stay inside the viewport", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(/\.software-map-frame\s*{[^}]*\bmargin:\s*0;/s);
  });

  it("keeps expanded map portals inside the active review theme scope", () => {
    const classNames = softwareMapOverlayClassName({
      theme: "light",
      nodeTint: "slate",
    }).split(" ");

    expect(classNames).toEqual([
      "software-map-overlay",
      "review-canvas-root",
      "review-app",
      "review-app--theme-light",
      "review-app--tint-slate",
    ]);
  });

  it("drives expanded map overlay background from theme tokens", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-overlay\s*{[^}]*background:\s*var\(--bg\);/s,
    );
    expect(styles).not.toMatch(
      /\.software-map-overlay\s*{[^}]*background:\s*#[0-9a-f]{3,8}/is,
    );
  });

  it("keeps the expanded map overlay above the sticky topbar", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    // The topbar sits at --review-debug-layer; the overlay portals to the end
    // of <body>, so an equal z-index paints it (and its close button) on top.
    // The variable is scoped to .review-app, which the body-level portal never
    // inherits from, so the rule must carry a literal fallback.
    expect(styles).toMatch(
      /\.software-map-overlay\s*{[^}]*z-index:\s*var\(--review-debug-layer,\s*2147483000\);/s,
    );
  });

  it("stacks C4 groups below relationship edges and cards", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-c4-canvas \.react-flow__node-softwareMapC4Group\s*{[^}]*\bz-index:\s*0 !important;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-canvas \.react-flow__edges\s*{[^}]*\bz-index:\s*1;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-canvas \.react-flow__node-softwareMapC4\s*{[^}]*\bz-index:\s*2 !important;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-canvas\s*\.react-flow__node-softwareMapC4:has\(\s*\.software-map-c4-node-shell:hover > \.comment-hover-button\s*\)\s*{[^}]*\bz-index:\s*40 !important;/s,
    );
    expect(styles).not.toMatch(
      /\.software-map-c4-canvas \.react-flow__node[^,{]*:hover\s*{[^}]*\bz-index:/s,
    );
    expect(styles).not.toMatch(
      /\.react-flow__node-softwareMapC4Group:has\([^)]*comment-hover-button[^)]*\)\s*{[^}]*\bz-index:/s,
    );
  });

  it("uses shared map panel surfaces for expanded group shells", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-c4-group-shell\s*{[^}]*border:\s*1px solid var\(--map-line-2\);/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-group-shell--softwareSystem\s*{[^}]*background:\s*var\(--map-panel-1\)/s,
    );
    expect(styles).not.toMatch(
      /--software-map-c4-group-border|#f5b97c|#7c9cf5|#8ab7c6|#6fc7a8|#b6a8f5/i,
    );
  });

  it("renders data stores as flat map cards", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-node,\s*\.software-map-c4-node-shell > \.software-map-node,\s*\.software-map-c4-node-shell > \.software-map-node--codeElement,\s*\.software-map-c4-node-shell > \.software-map-node--dataStore,\s*\.software-map-node--codeElement,\s*\.software-map-node--dataStore\s*{[^}]*padding:\s*12px 14px !important;[^}]*border:\s*1px solid var\(--map-card-line\) !important;[^}]*border-radius:\s*10px !important;[^}]*background:\s*var\(--map-card\) !important;[^}]*box-shadow:\s*none !important;/s,
    );
    expect(styles).not.toMatch(
      /\.software-map-node--dataStore::before|\.software-map-node--dataStore::after/s,
    );
    expect(styles).toMatch(
      /\.software-map-node-storage-outline,\s*\.software-map-node-storage-folder,\s*\.software-map-node--codeElement::before\s*{[^}]*display:\s*none !important;/s,
    );
  });

  it("carries artifact store kind through C4 snapshots for folder rendering", async () => {
    const model = defineSoftwareModel({
      systems: {
        product: {
          dataStores: {
            artifactStore: {
              kind: "artifactStore",
              label: "Artifact store",
            },
          },
        },
      },
    });
    const snapshot = softwareMapSnapshotFromInlineC4Projection({
      projection: projectInlineC4({
        model,
        expandedNodeIds: new Set(["product"]),
      }),
    });

    expect(
      snapshot.nodes?.find((node) => node.id === "product.artifactStore"),
    ).toMatchObject({
      type: "dataStore",
      dataStoreKind: "artifactStore",
    });

    const flow = await createC4MapFlow(snapshot);
    expect(
      flow.nodes.find((node) => node.id === "product.artifactStore")?.data.node,
    ).toMatchObject({
      type: "dataStore",
      dataStoreKind: "artifactStore",
    });
  });

  it("passes C4 node expansion callbacks through flow node data", async () => {
    const model = defineSoftwareModel({
      systems: {
        product: {
          containers: {
            web: { label: "Web" },
          },
        },
      },
    });
    const snapshot = softwareMapSnapshotFromInlineC4Projection({
      projection: projectInlineC4({
        model,
        expandedNodeIds: new Set(["product"]),
      }),
    });
    const onExpandNode = vi.fn<(node: SoftwareMapNodeSnapshot) => void>();
    const onCollapseNode = vi.fn<(node: SoftwareMapNodeSnapshot) => void>();
    const onDrillNode = vi.fn<(node: SoftwareMapNodeSnapshot) => void>();

    const flow = await createC4MapFlow(snapshot, {
      onExpandNode,
      onCollapseNode,
      onDrillNode,
    });
    const nodeData = flow.nodes.find((node) => node.id === "product")?.data;

    expect(nodeData?.onExpandNode).toBe(onExpandNode);
    expect(nodeData?.onCollapseNode).toBe(onCollapseNode);
    expect(nodeData?.onDrillNode).toBe(onDrillNode);
  });

  it("marks C4 flow nodes with a stable keyboard node id attribute", async () => {
    const model = defineSoftwareModel({
      systems: {
        product: {
          containers: {
            web: { label: "Web" },
          },
        },
      },
    });
    const snapshot = softwareMapSnapshotFromInlineC4Projection({
      projection: projectInlineC4({
        model,
        expandedNodeIds: new Set(["product"]),
      }),
    });

    const flow = await createC4MapFlow(snapshot);
    const node = flow.nodes.find((candidate) => candidate.id === "product");

    expect(node?.domAttributes).toMatchObject({
      "data-software-map-node-id": "product",
    });
  });

  it("renders inline C4 code nodes as compact monospace symbol headers", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-node--codeElement\s*{[^}]*\bmin-height:\s*34px;/s,
    );
    expect(styles).toMatch(
      /\.software-map-node--codeElement\s*{[^}]*\bwidth:\s*max-content;/s,
    );
    expect(styles).toMatch(
      /\.software-map-node--codeElement\s*{[^}]*\bmax-width:\s*420px;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-measure-node--codeElement\s*{[^}]*\bwidth:\s*max-content;/s,
    );
    expect(styles).toMatch(
      /\.software-map-code-element-head code\s*{[^}]*font-family:\s*"Geist Mono", ui-monospace, monospace;/s,
    );
    expect(styles).toMatch(
      /\.software-map-code-element-head\s*{[^}]*\bwidth:\s*max-content;/s,
    );
    expect(styles).toMatch(
      /\.software-map-code-element-head code\s*{[^}]*\bflex:\s*0 1 auto;/s,
    );
    expect(styles).toMatch(
      /\.software-map-code-element-head \.software-map-change-badge\s*{[^}]*\bwidth:\s*auto;/s,
    );
  });

  it("measures ordinary inline C4 nodes to their content width", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-c4-measure-node\s*{[^}]*\bwidth:\s*max-content;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-measure-node > \.software-map-node\s*{[^}]*\bwidth:\s*max-content;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-measure-node > \.software-map-node\s*{[^}]*\bmin-height:\s*0;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-measure-node > \.software-map-node\s*{[^}]*\bmax-width:\s*340px;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-measure-node--dataStore\s*{[^}]*\bwidth:\s*280px;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-measure-node--dataStore > \.software-map-node\s*{[^}]*\bwidth:\s*100%;/s,
    );
  });

  it("renders schema collection nodes without duplicate outer card chrome", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-node--dataStoreCollection\s*{[^}]*\bborder-width:\s*0;/s,
    );
    expect(styles).toMatch(
      /\.software-map-node--dataStoreCollection\s*{[^}]*\bbackground:\s*var\(--transparent\);/s,
    );
    expect(styles).toMatch(
      /\.software-map-node--dataStoreCollection \.software-map-node-kicker,\s*\.software-map-node--dataStoreCollection \.software-map-node-label--world,[^{]+{[^}]*\bdisplay:\s*none;/s,
    );
    expect(styles).toMatch(
      /\.software-map-node--dataStoreCollection \.software-map-data-store-schema\s*{[^}]*\bmargin:\s*0;/s,
    );
  });

  it("overlays map status messages without resizing the canvas", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-status\s*{[^}]*\bposition:\s*absolute;/s,
    );
    expect(styles).toMatch(/\.software-map-status\s*{[^}]*\btop:\s*14px;/s);
    expect(styles).toMatch(/\.software-map-status\s*{[^}]*\bleft:\s*14px;/s);
    expect(styles).toMatch(/\.software-map-status\s*{[^}]*\bmargin:\s*0;/s);
  });

  it("hides map floating refresh actions while a side peek is open", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.review-app--peek-open\s+\.software-map-floating-actions\s*{[^}]*display:\s*none;/s,
    );
  });

  it("hides map floating refresh actions while the code inspector is open", () => {
    expect(
      shouldShowSoftwareMapFloatingActions({
        showChrome: false,
        showFloatingActions: true,
        hasCodeInspector: false,
        hasRefreshAction: true,
      }),
    ).toBe(true);
    expect(
      shouldShowSoftwareMapFloatingActions({
        showChrome: false,
        showFloatingActions: true,
        hasCodeInspector: true,
        hasRefreshAction: true,
      }),
    ).toBe(false);
  });

  it("keeps C4 graph layout swaps atomic while new snapshots are measured", () => {
    const source = readFileSync(
      new URL("./SoftwareMap.tsx", import.meta.url),
      "utf8",
    );
    const canvasSource = sourceBetween(
      source,
      "function C4MapCanvas",
      "function runInlineC4Layout",
    );

    expect(canvasSource).toContain("C4DisplayedLayoutState");
    expect(canvasSource).toContain("displayedSnapshot");
    expect(canvasSource).toContain("measuredNodes");
    expect(canvasSource).toContain("layoutSnapshot");
    expect(canvasSource).toContain("setLayoutState({");
    expect(canvasSource).toContain("Refreshing layout...");
    expect(canvasSource).toMatch(
      /createC4MapFlowFromLayout\(displayedSnapshot,\s*layout,/s,
    );
    expect(canvasSource).toMatch(
      /<C4NodeMeasurementLayer\s+nodes={measuredNodes}/s,
    );
  });

  it("keeps hidden C4 measurement nodes off the live ResizeObserver loop", () => {
    const source = readFileSync(
      new URL("./SoftwareMap.tsx", import.meta.url),
      "utf8",
    );
    const measurementLayerSource = sourceBetween(
      source,
      "function C4NodeMeasurementLayer",
      "function scheduleC4NodeMeasurements",
    );

    expect(source).toContain("const followUpMeasurements = [120, 500]");
    expect(measurementLayerSource).not.toContain("new ResizeObserver");
  });

  it("measures C4 nodes even when animation frames are paused for a hidden editor tab", () => {
    const measure = vi.fn<() => void>();
    const cancel = scheduleC4NodeMeasurements(measure, {
      requestFrame: vi.fn<(callback: FrameRequestCallback) => number>(() => 17),
      cancelFrame: vi.fn<(frame: number) => void>(),
      setTimer: vi.fn<(callback: () => void, delay: number) => number>(
        () => 23,
      ),
      clearTimer: vi.fn<(timer: number) => void>(),
    });

    expect(measure).toHaveBeenCalledTimes(1);
    cancel();
  });

  it("serializes C4 layouts while follow-up measurements settle", async () => {
    const queue = new C4LayoutQueue();
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run(async () => {
      calls.push("first:start");
      await firstGate;
      calls.push("first:end");
      return 1;
    });
    const second = queue.run(async () => {
      calls.push("second");
      return 2;
    });

    await Promise.resolve();
    expect(calls).toEqual(["first:start"]);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(calls).toEqual(["first:start", "first:end", "second"]);
  });

  it("serializes libavoid work shared by separate map canvases", async () => {
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runSerializedC4Layout(async () => {
      calls.push("first:start");
      await firstGate;
      calls.push("first:end");
      return 1;
    });
    const second = runSerializedC4Layout(async () => {
      calls.push("second");
      return 2;
    });

    await Promise.resolve();
    expect(calls).toEqual(["first:start"]);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(calls).toEqual(["first:start", "first:end", "second"]);
  });

  it("styles selected node diffs as embedded CodePeek panels", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );
    const source = readFileSync(
      new URL("./SoftwareMap.tsx", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-body--with-inspector\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) 10px\s*var\(--software-map-inspector-width,\s*420px\);/s,
    );
    expect(styles).toMatch(
      /\.software-map-code-inspector-resizer\s*{[^}]*min-height:\s*0;/s,
    );
    expect(styles).toMatch(
      /\.software-map-code-inspector\s*{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\);/s,
    );
    expect(styles).toMatch(
      /\.software-map-code-inspector-header\s*{[^}]*justify-content:\s*space-between;/s,
    );
    expect(styles).toMatch(
      /\.software-map-code-inspector-title strong\s*{[^}]*text-overflow:\s*ellipsis;/s,
    );
    expect(styles).toMatch(
      /\.software-map-code-inspector-actions\s*{[^}]*display:\s*flex;/s,
    );
    expect(styles).toMatch(
      /\.software-map-code-inspector-diffs\s*{[^}]*overflow:\s*auto;/s,
    );
    expect(source).toContain("useRightPanelResize");
    expect(source).toContain('label: "Resize code inspector"');
    expect(source).toContain('? "code-inspector-width-expanded"');
    expect(source).toContain(': "code-inspector-width"');
    expect(source).toContain(
      'className="side-panel-resizer software-map-code-inspector-resizer"',
    );
    expect(source).toContain('aria-label="Close code inspector"');
    expect(source).toContain('"Collapse all diffs"');
    expect(source).toContain('"codicon-fold"');
    expect(source).toContain('"codicon-unfold"');
    expect(source).toContain("additions={node.additions}");
    expect(source).toContain("deletions={node.deletions}");
    expect(source).toContain("softwareMapNodeTypeLabel(node)");
    expect(source).toContain(
      "<strong title={node.label}>{node.label}</strong>",
    );
    expect(source).toContain("onCloseCodeInspector={handleCloseCodeInspector}");
    expect(source).toContain("softwareMapNodeDiffPeeks({");
    expect(source).toContain(
      "<CodePeekGroup peeks={diffPeeks} collapsed={diffsCollapsed} />",
    );
    expect(source).not.toContain('theme="dark"');
  });

  it("keeps SoftwareMap minimaps on the active theme tokens", () => {
    const softwareMapSource = readFileSync(
      new URL("./SoftwareMap.tsx", import.meta.url),
      "utf8",
    );

    expect(softwareMapSource).toContain('maskColor="var(--minimap-mask)"');
    expect(softwareMapSource).toContain('maskStrokeColor="var(--rule-soft)"');
    expect(softwareMapSource).toContain('backgroundColor: "var(--surface)"');
    expect(softwareMapSource).toContain('border: "1px solid var(--rule)"');
    expect(softwareMapSource).toContain("nodeStrokeColor=");
    expect(softwareMapSource).toContain('"var(--selection)"');
    expect(softwareMapSource).toContain('"var(--rule-soft)"');
  });

  it("renders software map hotkeys as a shallow bottom tab", () => {
    const softwareMapSource = readFileSync(
      new URL("./SoftwareMap.tsx", import.meta.url),
      "utf8",
    );
    const hotkeysSource = readFileSync(
      new URL("./hotkeys-tab.tsx", import.meta.url),
      "utf8",
    );
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(softwareMapSource).toContain("<SoftwareMapHotkeysTab");
    expect(softwareMapSource).toContain("C4_MAP_HOTKEY_GROUPS");
    expect(hotkeysSource).toContain(
      'aria-label="Minimize software map hotkeys"',
    );
    expect(hotkeysSource).toContain('aria-label="Show software map hotkeys"');
    expect(hotkeysSource).toContain("stopSoftwareMapHotkeysKeyDown");
    expect(styles).toMatch(
      /\.software-map-code-hotkeys\s*{[^}]*bottom:\s*0;[^}]*left:\s*50%;[^}]*height:\s*30px;/s,
    );
    expect(styles).toContain(
      "width: var(--software-map-hotkeys-width, max-content);",
    );
    expect(styles).toContain("max-width: calc(100% - 24px);");
    expect(styles).toContain("width 180ms cubic-bezier(0.2, 0.8, 0.2, 1)");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toMatch(
      /\.software-map-code-hotkeys\s*{[^}]*border-radius:\s*8px 8px 0 0;/s,
    );
    expect(styles).toMatch(
      /\.software-map-code-hotkeys-strip\s*{[^}]*overflow-x:\s*auto;/s,
    );
    expect(C4_MAP_HOTKEY_GROUPS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "c4-navigation",
          items: expect.arrayContaining([
            expect.objectContaining({
              keys: ["h", "j", "k", "l", "Arrows"],
              label: "select",
            }),
            expect.objectContaining({ keys: ["f"], label: "fit" }),
          ]),
        }),
        expect.objectContaining({
          id: "c4-structure",
          items: expect.arrayContaining([
            expect.objectContaining({ keys: ["Enter"], label: "expand/drill" }),
            expect.objectContaining({ keys: ["Tab"], label: "toggle" }),
            expect.objectContaining({ keys: ["Esc"], label: "parent" }),
          ]),
        }),
      ]),
    );
  });

  it("uses single-tone accent borders for selected map nodes", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-node\.selected,\s*\.software-map-node\.selected\.software-map-node--added,\s*\.software-map-node\.selected\.software-map-node--removed,\s*\.software-map-node\.selected\.software-map-node--modified\s*{[^}]*border:\s*2px solid var\(--accent\) !important;[^}]*background:\s*var\(--map-active-fill\) !important;[^}]*box-shadow:\s*none !important;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-group-shell\.selected,\s*\.software-map-c4-group-shell\.selected\.software-map-c4-group-shell--added,\s*\.software-map-c4-group-shell\.selected\.software-map-c4-group-shell--removed,\s*\.software-map-c4-group-shell\.selected\.software-map-c4-group-shell--modified\s*{[^}]*border:\s*2px solid var\(--accent\) !important;[^}]*background:\s*var\(--map-active-fill\) !important;[^}]*box-shadow:\s*none !important;/s,
    );
    expect(styles).toMatch(
      /\.software-map-node\.software-map-node--added\s*{[^}]*border:\s*1\.5px solid var\(--map-added\) !important;/s,
    );
    expect(styles).toMatch(
      /\.software-map-node\.software-map-node--modified\s*{[^}]*border:\s*1\.5px solid var\(--map-changed\) !important;/s,
    );
    expect(styles).toMatch(
      /\.software-map-node\.software-map-node--removed\s*{[^}]*border:\s*1\.5px dashed var\(--map-removed\) !important;[^}]*opacity:\s*0\.75;/s,
    );
    expect(styles).not.toMatch(/0 0 0 [23]px var\(--selection\)/);
  });

  it("keeps connection handles hidden and renders always-visible source bubbles", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );
    const source = readFileSync(
      new URL("./SoftwareMap.tsx", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-c4-handle\s*{[^}]*width:\s*1px;[^}]*height:\s*1px;[^}]*border:\s*0;[^}]*background:\s*var\(--transparent\);[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s,
    );
    expect(styles).not.toMatch(
      /\.software-map-c4-(?:node|group)-shell:hover\s+\.software-map-c4-handle/,
    );
    expect(source).toMatch(/c4EdgeEndpointBubbles\(\s*points,/);
    expect(source).toContain('"software-map-c4-edge-endpoint"');
    expect(source).not.toMatch(/endpoint:\s*"target"/);
    expect(styles).toMatch(
      /\.software-map-c4-edge-endpoint\s*{[^}]*width:\s*11px\s*!important;[^}]*height:\s*11px\s*!important;[^}]*border:\s*1\.5px solid var\(--map-edge\)\s*!important;[^}]*background:\s*var\(--map-panel-2\)\s*!important;[^}]*opacity:\s*1;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-edge-endpoint--hovered\s*{[^}]*border:\s*2px solid var\(--map-card\)\s*!important;[^}]*background:\s*var\(--accent\)\s*!important;[^}]*opacity:\s*1;/s,
    );
  });

  it("maps each connected edge to its routed source bubble only", () => {
    const points = [
      { x: 215, y: 84 },
      { x: 280, y: 84 },
      { x: 280, y: 196 },
      { x: 410, y: 196 },
    ];
    const relationship = { from: "source-node", to: "target-node" };

    expect(c4EdgeEndpointBubbles(points, relationship, "source-node")).toEqual([
      { endpoint: "source", x: 215, y: 84, hovered: true },
    ]);
    expect(c4EdgeEndpointBubbles(points, relationship, "target-node")).toEqual([
      { endpoint: "source", x: 215, y: 84, hovered: false },
    ]);
    expect(c4EdgeEndpointBubbles([], relationship, "source-node")).toEqual([]);
    expect(
      c4EdgeEndpointBubbles(
        points,
        { from: "source-node", kind: "implied" },
        "source-node",
      ),
    ).toEqual([]);
  });

  it("renders selected implied edges as dashed, unlabelled, bubble-free edges", async () => {
    const flow = await createC4MapFlow({
      viewType: "inlineC4",
      selectedNodeId: "source",
      nodes: [
        { id: "source", label: "Source", type: "container" },
        { id: "target", label: "Target", type: "container" },
      ],
      relationships: [
        {
          id: "elided:source->target",
          from: "source",
          to: "target",
          kind: "implied",
          hideLabel: true,
        },
      ],
    });
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );
    const source = readFileSync(
      new URL("./SoftwareMap.tsx", import.meta.url),
      "utf8",
    );

    expect(flow.edges).toEqual([
      expect.objectContaining({
        label: undefined,
        className: expect.stringContaining("software-map-c4-edge--implied"),
        style: expect.objectContaining({
          stroke: "var(--accent)",
          strokeDasharray: "2 8",
          strokeLinecap: "round",
        }),
        markerEnd: expect.objectContaining({ color: "var(--accent)" }),
      }),
    ]);
    expect(source).not.toContain("GhostWaypointBeads");
    expect(styles).not.toContain("software-map-c4-ghost-beads");
  });

  it("uses the accent for edges and labels attached to a selected node", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-c4-canvas\s+\.software-map-c4-edge--selected-node\s+\.react-flow__edge-path\s*{[^}]*stroke:\s*var\(--accent\)\s*!important;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-edge-label--selected-node\s*{[^}]*border-color:\s*var\(--accent\)\s*!important;/s,
    );
    expect(styles).not.toMatch(
      /\.software-map-c4-canvas marker (?:path|polyline)[^{]*{[^}]*var\(--map-edge\)\s*!important/s,
    );
  });

  it("composes selected and changed chrome without replacing the selected frame", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    for (const [status, border] of [
      ["added", "1\\.5px solid var\\(--map-added\\)"],
      ["modified", "1\\.5px solid var\\(--map-changed\\)"],
      ["removed", "1\\.5px dashed var\\(--map-removed\\)"],
    ] as const) {
      expect(styles).toMatch(
        new RegExp(
          `\\.software-map-c4-group-shell--${status}\\s*{[^}]*border:\\s*${border} !important;`,
          "s",
        ),
      );
      expect(styles).toMatch(
        new RegExp(
          `\\.software-map-node\\.software-map-node--${status}\\s*{[^}]*border:\\s*${border} !important;`,
          "s",
        ),
      );
    }

    expect(styles).toMatch(
      /\.software-map-c4-group-shell\.selected,\s*\.software-map-c4-group-shell\.selected\.software-map-c4-group-shell--added,\s*\.software-map-c4-group-shell\.selected\.software-map-c4-group-shell--removed,\s*\.software-map-c4-group-shell\.selected\.software-map-c4-group-shell--modified\s*{[^}]*border:\s*2px solid var\(--accent\) !important;[^}]*box-shadow:\s*none !important;/s,
    );
    expect(styles).toMatch(
      /\.software-map-node\.selected,\s*\.software-map-node\.selected\.software-map-node--added,\s*\.software-map-node\.selected\.software-map-node--removed,\s*\.software-map-node\.selected\.software-map-node--modified\s*{[^}]*border:\s*2px solid var\(--accent\) !important;[^}]*box-shadow:\s*none !important;/s,
    );
    expect(styles).toMatch(
      /\.software-map-node--removed \.software-map-node-label--world\s*{[^}]*text-decoration:\s*line-through;/s,
    );
    expect(styles).not.toMatch(
      /\.software-map-(?:c4-group-shell|node)\.selected[^}]*border:\s*1\.5px/s,
    );
  });

  it("allows the full-canvas Map tab to hide inline SoftwareMap chrome", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );
    const appSource = readFileSync(
      new URL("../App.tsx", import.meta.url),
      "utf8",
    );
    const source = readFileSync(
      new URL("./SoftwareMap.tsx", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.software-map-frame--chrome-hidden\s*{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);/s,
    );
    expect(appSource).toContain(
      '{softwareMapEnabled && activeView === "map" && (',
    );
    expect(appSource).toContain("Experimental");
    expect(appSource).toContain("showChrome={false}");
    expect(appSource).not.toContain("Add an inline");
    expect(source).toContain("showChrome = true");
    expect(source).toContain("{showChrome && (");
  });

  it("keeps inline software map chrome outside the body viewport", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );
    const source = readFileSync(
      new URL("./SoftwareMap.tsx", import.meta.url),
      "utf8",
    );

    expect(source.indexOf('className="software-map-header"')).toBeLessThan(
      source.indexOf('"software-map-body"'),
    );
    expect(styles).toMatch(
      /\.software-map-frame\s*{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\);[^}]*overflow:\s*hidden;/s,
    );
    expect(styles).toMatch(
      /\.software-map-body\s*{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s,
    );
    expect(styles).toMatch(
      /\.software-map-canvas\s*{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s,
    );
  });

  it("persists selected node and expanded node ids by model identity", () => {
    const session = testReviewSession();
    clearSoftwareMapNavigationStateForTests(session);
    const key = softwareMapNavigationKey({
      title: "CI SoftwareMap",
      view: "inline",
    });

    rememberSoftwareMapNavigationState(session, key, {
      modelKey: "model:a",
      expandedNodeIds: ["devFastCi", "devFastCi.ciWorker"],
      selectedNodeId: "devFastCi.ciWorker",
      expanded: true,
    });

    expect(restoreSoftwareMapNavigationState(session, key, "model:a")).toEqual({
      modelKey: "model:a",
      expandedNodeIds: ["devFastCi", "devFastCi.ciWorker"],
      selectedNodeId: "devFastCi.ciWorker",
      expanded: true,
    });
    expect(restoreSoftwareMapNavigationState(session, key, "model:b")).toEqual({
      modelKey: "model:b",
      expandedNodeIds: [],
      selectedNodeId: null,
      expanded: false,
    });
  });

  it("defaults every non-component expandable node to expanded", () => {
    const model = defineSoftwareModel({
      systems: {
        app: {
          containers: {
            web: {
              components: {
                ui: {
                  codeElements: {
                    render: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                    },
                  },
                },
              },
            },
          },
          dataStores: {
            graph: {
              tables: {
                nodes: { schema: { id: { type: "string", pk: true } } },
              },
            },
          },
        },
      },
    });

    expect([...initialSoftwareMapExpandedNodeIds(model)].sort()).toEqual([
      "app",
      "app.graph",
      "app.web",
    ]);
  });

  it("seeds nested default expansion once the complete model is available", () => {
    const initialModel = defineSoftwareModel({
      systems: {
        app: {
          containers: {
            web: {},
          },
        },
      },
    });
    const completeModel = defineSoftwareModel({
      systems: {
        app: {
          containers: {
            web: {
              components: {
                ui: {
                  codeElements: {
                    render: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const initialExpandedNodeIds =
      initialSoftwareMapExpandedNodeIds(initialModel);
    expect([...initialExpandedNodeIds]).toEqual(["app"]);

    const expandedNodeIds = seedSoftwareMapDefaultExpandedNodeIds({
      expandedNodeIds: initialExpandedNodeIds,
      model: completeModel,
      defaultExpansionActive: true,
    });
    expect([...expandedNodeIds].sort()).toEqual(["app", "app.web"]);

    const projection = projectInlineC4({
      model: completeModel,
      expandedNodeIds,
    });
    expect(projection.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "app", isExpanded: true }),
        expect.objectContaining({ id: "app.web", isExpanded: true }),
        expect.objectContaining({
          id: "app.web.ui",
          isExpanded: false,
        }),
      ]),
    );
    expect(projection.visibleNodeIds.has("app.web.ui.render")).toBe(false);
  });

  it("does not re-expand a default node after the user collapses it", () => {
    const model = defineSoftwareModel({
      systems: {
        app: {
          containers: {
            web: {
              components: {
                ui: {
                  codeElements: {
                    render: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(
      [
        ...seedSoftwareMapDefaultExpandedNodeIds({
          expandedNodeIds: new Set(["app"]),
          model,
          defaultExpansionActive: false,
        }),
      ].sort(),
    ).toEqual(["app"]);
  });

  it("updates the first map layout when resolved children and edges arrive", async () => {
    const initialModel = defineSoftwareModel({
      systems: {
        app: {
          containers: {
            api: {},
            worker: {},
          },
        },
      },
    });
    const resolvedModel = defineSoftwareModel({
      systems: {
        app: {
          containers: {
            api: {
              components: {
                routes: {},
              },
            },
            worker: {
              components: {
                jobs: {},
              },
            },
          },
        },
      },
      relationships: [
        {
          kind: "semantic",
          from: "app.api.routes",
          to: "app.worker.jobs",
          label: "sends jobs",
        },
      ],
    });
    const initialExpandedNodeIds =
      initialSoftwareMapExpandedNodeIds(initialModel);
    const initialSnapshot = softwareMapSnapshotFromInlineC4Projection({
      projection: projectInlineC4({
        model: initialModel,
        expandedNodeIds: initialExpandedNodeIds,
      }),
    });
    const initialLayout = await runInlineC4Layout(
      initialSnapshot.nodes ?? [],
      initialSnapshot.relationships ?? [],
    );

    const resolvedExpandedNodeIds = seedSoftwareMapDefaultExpandedNodeIds({
      expandedNodeIds: initialExpandedNodeIds,
      model: resolvedModel,
      defaultExpansionActive: true,
    });
    const resolvedSnapshot = softwareMapSnapshotFromInlineC4Projection({
      projection: projectInlineC4({
        model: resolvedModel,
        expandedNodeIds: resolvedExpandedNodeIds,
      }),
    });
    const resolvedLayout = await runInlineC4Layout(
      resolvedSnapshot.nodes ?? [],
      resolvedSnapshot.relationships ?? [],
      undefined,
      c4PreviousInlineLayoutForRelationships({
        previousLayout: initialLayout.inlineLayout,
        previousRelationships: initialSnapshot.relationships ?? [],
        currentRelationships: resolvedSnapshot.relationships ?? [],
      }),
    );
    const flow = createC4MapFlowFromLayout(
      resolvedSnapshot,
      resolvedLayout.layout,
    );

    expect(resolvedSnapshot.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "app", expanded: true }),
        expect.objectContaining({ id: "app.api", expanded: true }),
        expect.objectContaining({ id: "app.worker", expanded: true }),
        expect.objectContaining({ id: "app.api.routes", expanded: false }),
        expect.objectContaining({
          id: "app.worker.jobs",
          expanded: false,
        }),
      ]),
    );
    expect(flow.edges).toHaveLength(1);
    expect(
      new Set(
        flow.nodes
          .filter((node) => node.id === "app.api" || node.id === "app.worker")
          .map((node) => node.position.y),
      ).size,
    ).toBe(2);
  });

  it("defaults selection to the first visible node when selected id is missing", () => {
    const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }];

    expect(
      selectedSoftwareMapNodeIdForNodes({
        nodes,
        selectedNodeId: "c",
      }),
    ).toBe("c");
    expect(
      selectedSoftwareMapNodeIdForNodes({
        nodes,
        selectedNodeId: "missing",
      }),
    ).toBe("a");
  });

  it("keeps rendered C4 selection current while reusing an existing layout", () => {
    const layoutSnapshot: SoftwareMapResolvedSnapshot = {
      viewType: "inlineC4",
      selectedNodeId: "root",
      nodes: [
        { id: "root", label: "Root", type: "softwareSystem" },
        {
          id: "root.child",
          label: "Child",
          type: "container",
          parentId: "root",
        },
      ],
      relationships: [],
    };
    const currentSnapshot: SoftwareMapResolvedSnapshot = {
      ...layoutSnapshot,
      selectedNodeId: "root.child",
    };

    const displayed = c4DisplayedSnapshotForCurrentState(
      layoutSnapshot,
      currentSnapshot,
    );

    expect(displayed.selectedNodeId).toBe("root.child");
    expect(layoutSnapshot.selectedNodeId).toBe("root");
  });

  it("selects the first immediate child after expanding an inline C4 node", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveReview: {
          label: "Progressive Review",
          containers: {
            runtime: { label: "Runtime" },
            reviewApp: {
              label: "Review App",
              components: {
                softwareMap: { label: "SoftwareMap" },
              },
            },
          },
        },
      },
    });
    const projection = projectInlineC4({
      model,
      expandedNodeIds: new Set([
        "progressiveReview",
        "progressiveReview.reviewApp",
      ]),
      selectedNodeId: "progressiveReview",
    });
    const nodes =
      softwareMapSnapshotFromInlineC4Projection({
        projection,
      }).nodes ?? [];

    expect(
      firstSoftwareMapChildNodeId({
        nodes,
        parentId: "progressiveReview",
      }),
    ).toBe("progressiveReview.runtime");
    expect(
      firstSoftwareMapChildNodeId({
        nodes,
        parentId: "progressiveReview.reviewApp",
      }),
    ).toBe("progressiveReview.reviewApp.softwareMap");
  });

  it("prefers the remembered immediate child when drilling into an inline C4 level", () => {
    const nodes = [
      { id: "progressiveReview", parentId: null },
      { id: "progressiveReview.runtime", parentId: "progressiveReview" },
      { id: "progressiveReview.reviewApp", parentId: "progressiveReview" },
      {
        id: "progressiveReview.reviewApp.softwareMap",
        parentId: "progressiveReview.reviewApp",
      },
    ];

    expect(
      softwareMapChildNodeIdForDrill({
        nodes,
        parentId: "progressiveReview",
        rememberedChildNodeId: "progressiveReview.reviewApp",
      }),
    ).toBe("progressiveReview.reviewApp");
    expect(
      softwareMapChildNodeIdForDrill({
        nodes,
        parentId: "progressiveReview",
        rememberedChildNodeId: "progressiveReview.reviewApp.softwareMap",
      }),
    ).toBe("progressiveReview.runtime");
    expect(
      softwareMapChildNodeIdForDrill({
        nodes,
        parentId: "progressiveReview",
        rememberedChildNodeId: null,
      }),
    ).toBe("progressiveReview.runtime");
    expect(
      softwareMapNodeIdForDrill({
        node: { id: "progressiveReview", expanded: false },
        nodes,
        preferredChildNodeId: "progressiveReview.reviewApp",
      }),
    ).toBe("progressiveReview");
    expect(
      softwareMapNodeIdForDrill({
        node: { id: "progressiveReview", expanded: true },
        nodes,
        preferredChildNodeId: "progressiveReview.reviewApp",
      }),
    ).toBe("progressiveReview.reviewApp");
  });

  it("selects the visible parent when escaping an inline C4 level", () => {
    const nodes = [
      { id: "progressiveReview", parentId: null },
      { id: "progressiveReview.reviewApp", parentId: "progressiveReview" },
      {
        id: "progressiveReview.reviewApp.softwareMap",
        parentId: "progressiveReview.reviewApp",
      },
    ];

    expect(
      parentSoftwareMapNodeId({
        nodes,
        nodeId: "progressiveReview.reviewApp.softwareMap",
      }),
    ).toBe("progressiveReview.reviewApp");
    expect(
      parentSoftwareMapNodeId({
        nodes,
        nodeId: "progressiveReview",
      }),
    ).toBe(null);
    expect(
      parentSoftwareMapNodeId({
        nodes: [{ id: "orphan", parentId: "missing" }],
        nodeId: "orphan",
      }),
    ).toBe(null);
  });

  it("toggles inline C4 expansion in place for tab navigation", () => {
    expect(
      [
        ...toggledSoftwareMapExpandedNodeIds({
          expandedNodeIds: new Set(["progressiveReview"]),
          node: {
            path: "progressiveReview.reviewApp",
            expandable: true,
            expanded: false,
          },
        }),
      ].sort(),
    ).toEqual(["progressiveReview", "progressiveReview.reviewApp"]);

    expect([
      ...toggledSoftwareMapExpandedNodeIds({
        expandedNodeIds: new Set([
          "progressiveReview",
          "progressiveReview.reviewApp",
          "progressiveReview.reviewApp.softwareMap",
        ]),
        node: {
          path: "progressiveReview.reviewApp",
          expandable: true,
          expanded: true,
        },
      }),
    ]).toEqual(["progressiveReview"]);

    expect([
      ...toggledSoftwareMapExpandedNodeIds({
        expandedNodeIds: new Set(["progressiveReview"]),
        node: {
          path: "progressiveReview.reviewApp.softwareMap.render",
          expandable: false,
          expanded: false,
        },
      }),
    ]).toEqual(["progressiveReview"]);

    const collapseFocus = toggledSoftwareMapViewportFocusRequest({
      id: "progressiveReview.reviewApp",
      expanded: true,
    });
    expect(collapseFocus).toEqual({
      nodeId: "progressiveReview.reviewApp",
      requireExpanded: false,
    });
    expect(
      softwareMapViewportFocusTargetReady({
        node: { id: "progressiveReview.reviewApp", expanded: false },
        viewportFocusNodeId: collapseFocus.nodeId,
        requireExpanded: collapseFocus.requireExpanded,
      }),
    ).toBe(true);
  });

  it("repairs child selection to the collapsed parent and requests parent focus", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveReview: {
          label: "Progressive Review",
          containers: {
            reviewApp: {
              label: "Review App",
              components: {
                softwareMap: { label: "SoftwareMap" },
              },
            },
          },
        },
      },
    });
    const expandedNodeIds = new Set([
      "progressiveReview",
      "progressiveReview.reviewApp",
    ]);
    const expandedSnapshot = softwareMapSnapshotFromInlineC4Projection({
      projection: projectInlineC4({
        model,
        expandedNodeIds,
        selectedNodeId: "progressiveReview.reviewApp.softwareMap",
      }),
    });
    const parent = expandedSnapshot.nodes?.find(
      (node) => node.id === "progressiveReview.reviewApp",
    );

    expect(parent).toBeTruthy();
    const selectedNodeId = parent!.id;
    const viewportFocusRequest = {
      nodeId: parent!.id,
      requireExpanded: false,
    };
    const collapsedExpandedNodeIds = collapseInlineC4Node(
      expandedNodeIds,
      parent!.path!,
    );
    const collapsedSnapshot = softwareMapSnapshotFromInlineC4Projection({
      projection: projectInlineC4({
        model,
        expandedNodeIds: collapsedExpandedNodeIds,
        selectedNodeId,
      }),
    });

    expect([...collapsedExpandedNodeIds]).toEqual(["progressiveReview"]);
    expect(selectedNodeId).toBe("progressiveReview.reviewApp");
    expect(viewportFocusRequest).toEqual({
      nodeId: "progressiveReview.reviewApp",
      requireExpanded: false,
    });
    expect(
      collapsedSnapshot.nodes?.some(
        (node) => node.id === "progressiveReview.reviewApp.softwareMap",
      ),
    ).toBe(false);
    expect(
      selectedSoftwareMapNodeIdForNodes({
        nodes: collapsedSnapshot.nodes ?? [],
        selectedNodeId,
      }),
    ).toBe("progressiveReview.reviewApp");
    expect(
      softwareMapViewportFocusTargetReady({
        node: { id: "progressiveReview.reviewApp", expanded: false },
        viewportFocusNodeId: viewportFocusRequest.nodeId,
        requireExpanded: viewportFocusRequest.requireExpanded,
      }),
    ).toBe(true);
  });

  it("resolves the selected C4 node for first-keypress tab expansion", () => {
    const nodes = [
      {
        id: "progressiveReview",
        expandable: true,
        expanded: false,
        path: "progressiveReview",
      },
      {
        id: "progressiveReview.reviewApp",
        expandable: true,
        expanded: false,
        path: "progressiveReview.reviewApp",
      },
    ];
    const selected = softwareMapNodeForKeyboardExpansion({
      nodes,
      selectedNodeId: "progressiveReview.reviewApp",
    });

    expect(selected?.id).toBe("progressiveReview.reviewApp");
    expect([
      ...toggledSoftwareMapExpandedNodeIds({
        expandedNodeIds: new Set(["progressiveReview"]),
        node: selected!,
      }),
    ]).toEqual(["progressiveReview", "progressiveReview.reviewApp"]);
  });

  it("falls back to the focused React Flow node when selection has not flushed before Tab", () => {
    const nodes = [
      {
        id: "progressiveReview",
        expandable: true,
        expanded: true,
        path: "progressiveReview",
      },
    ];
    const selected = softwareMapNodeForKeyboardExpansion({
      nodes,
      selectedNodeId: null,
      focusedNodeId: "progressiveReview",
    });

    expect(selected?.id).toBe("progressiveReview");
    expect([
      ...toggledSoftwareMapExpandedNodeIds({
        expandedNodeIds: new Set(["progressiveReview"]),
        node: selected!,
      }),
    ]).toEqual([]);
  });

  it("does not fall through to focused node when selected node is non-expandable", () => {
    const selected = softwareMapNodeForKeyboardExpansion({
      nodes: [
        { id: "selected-code", expandable: false },
        { id: "focused-parent", expandable: true },
      ],
      selectedNodeId: "selected-code",
      focusedNodeId: "focused-parent",
    });

    expect(selected).toBeNull();
  });

  it("frames a pending expanded group instead of the newly selected child", () => {
    const nodes = [
      { id: "progressiveReview" },
      { id: "progressiveReview.runtime" },
    ];

    expect(
      softwareMapViewportFocusNodeId({
        nodes,
        viewportFocusNodeId: "progressiveReview",
      }),
    ).toBe("progressiveReview");
    expect(
      softwareMapViewportFocusNodeId({
        nodes,
        viewportFocusNodeId: null,
      }),
    ).toBe(null);
    expect(
      softwareMapViewportFocusTargetReady({
        node: { id: "progressiveReview", expanded: false },
        viewportFocusNodeId: "progressiveReview",
      }),
    ).toBe(false);
    expect(
      softwareMapViewportFocusTargetReady({
        node: { id: "progressiveReview", expanded: false },
        viewportFocusNodeId: "progressiveReview",
        requireExpanded: false,
      }),
    ).toBe(true);
    expect(
      softwareMapViewportFocusTargetReady({
        node: { id: "progressiveReview", expanded: true },
        viewportFocusNodeId: "progressiveReview",
      }),
    ).toBe(true);
  });

  it("only completes C4 viewport focus after fitBounds is available", () => {
    const node = {
      id: "progressiveReview",
      position: { x: 24, y: 36 },
      data: {
        node: {
          id: "progressiveReview",
          label: "Progressive Review",
          type: "softwareSystem",
        },
      },
      type: "softwareMapC4",
      width: 320,
      height: 180,
    };
    const fitBounds = vi.fn<() => void>();

    expect(focusC4MapNode(null, node as never)).toBe(false);
    expect(fitBounds).not.toHaveBeenCalled();

    expect(focusC4MapNode({ fitBounds } as never, node as never)).toBe(true);
    expect(fitBounds).toHaveBeenCalledWith(
      { x: 24, y: 36, width: 320, height: 180 },
      expect.objectContaining({ padding: expect.any(Number) }),
    );

    fitBounds.mockClear();
    expect(
      focusC4MapNode(
        { fitBounds } as never,
        {
          ...node,
          width: 280,
          height: 112,
          style: { width: 1740, height: 665 },
        } as never,
      ),
    ).toBe(true);
    expect(fitBounds).toHaveBeenCalledWith(
      { x: 24, y: 36, width: 1740, height: 665 },
      expect.objectContaining({ padding: expect.any(Number) }),
    );
  });

  it("restores C4 keyboard focus after viewport focus succeeds", () => {
    const node = {
      id: "progressiveReview",
      position: { x: 24, y: 36 },
      data: {
        node: {
          id: "progressiveReview",
          label: "Progressive Review",
          type: "softwareSystem",
        },
      },
      type: "softwareMapC4",
      width: 320,
      height: 180,
    };
    const fitBounds = vi.fn<() => void>();
    const keyboardTarget = {
      focus: vi.fn<(options?: FocusOptions) => void>(),
    };
    const focusKeyboardTarget = vi.fn<(element: HTMLElement | null) => void>(
      (element) => {
        element?.focus({ preventScroll: true });
      },
    );

    expect(
      focusC4MapNodeAndKeyboard(
        { fitBounds } as never,
        node as never,
        keyboardTarget as never,
        focusKeyboardTarget,
      ),
    ).toBe(true);
    expect(fitBounds).toHaveBeenCalledWith(
      { x: 24, y: 36, width: 320, height: 180 },
      expect.objectContaining({ padding: expect.any(Number) }),
    );
    expect(focusKeyboardTarget).toHaveBeenCalledWith(keyboardTarget);
    expect(keyboardTarget.focus).toHaveBeenCalledWith({ preventScroll: true });

    fitBounds.mockClear();
    keyboardTarget.focus.mockClear();
    focusKeyboardTarget.mockClear();
    expect(
      focusC4MapNodeAndKeyboard(
        null,
        node as never,
        keyboardTarget as never,
        focusKeyboardTarget,
      ),
    ).toBe(false);
    expect(fitBounds).not.toHaveBeenCalled();
    expect(focusKeyboardTarget).not.toHaveBeenCalled();
    expect(keyboardTarget.focus).not.toHaveBeenCalled();
  });

  it("renders C4 detail in world space without zoom-specific overlays", () => {
    const source = readFileSync(new URL("./SoftwareMap.tsx", import.meta.url), {
      encoding: "utf8",
    });
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    expect(source).not.toContain("C4NodeLabelOverlay");
    expect(source).not.toContain("descriptionThresholds");
    expect(styles).not.toContain("detail-compact");
    expect(styles).not.toContain("compact-screen-scale");
  });

  it("fits the C4 viewport with the same padding as the React Flow control", () => {
    const fitView = vi.fn<() => void>();

    expect(fitC4MapView(null)).toBe(false);
    expect(fitView).not.toHaveBeenCalled();

    expect(fitC4MapView({ fitView } as never)).toBe(true);
    expect(fitView).toHaveBeenCalledWith({
      padding: 0.18,
      duration: expect.any(Number),
    });
  });

  it("refits the C4 viewport when a new expanded layout or canvas resize is applied", () => {
    const source = readFileSync(new URL("./SoftwareMap.tsx", import.meta.url), {
      encoding: "utf8",
    });

    expect(source).toMatch(
      /useEffect\(\(\) => \{[^}]*if \(!flowInstance \|\| !layout\) return;[^}]*requestAnimationFrame\(\(\) => \{[^}]*fitC4MapView\(flowRef\.current\);/s,
    );
    expect(source).toContain("const canvas = keyboardTargetRef.current");
    expect(source).toContain(
      "const resizeObserver = new ResizeObserver(scheduleFit)",
    );
    expect(source).toContain("resizeObserver.observe(canvas)");
  });

  it("does not move the viewport when keyboard navigation lands on a visible C4 node", () => {
    expect(
      c4ViewportForNodeReveal({
        nodeBounds: { x: 40, y: 50, width: 120, height: 80 },
        viewport: { x: 0, y: 0, zoom: 1 },
        viewportSize: { width: 400, height: 300 },
        padding: 8,
      }),
    ).toBe(null);
  });

  it("pans minimally when keyboard navigation lands on a clipped C4 node", () => {
    expect(
      c4ViewportForNodeReveal({
        nodeBounds: { x: 340, y: 250, width: 80, height: 60 },
        viewport: { x: 0, y: 0, zoom: 1 },
        viewportSize: { width: 400, height: 300 },
        padding: 8,
      }),
    ).toEqual({ x: -28, y: -18, zoom: 1 });
  });

  it("zooms out only as much as needed when keyboard navigation lands on a large C4 node", () => {
    const viewport = c4ViewportForNodeReveal({
      nodeBounds: { x: 0, y: 50, width: 500, height: 100 },
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportSize: { width: 400, height: 300 },
      padding: 0,
      minZoom: 0.1,
      maxZoom: 1.6,
    });

    expect(viewport?.zoom).toBeCloseTo(0.8);
    expect(viewport?.x).toBeCloseTo(0);
    expect(viewport?.y).toBeCloseTo(30);
  });

  it("turns objective inline projection into render snapshots", () => {
    const model = defineSoftwareModel({
      people: {
        reviewer: { label: "Reviewer" },
      },
      systems: {
        progressiveReview: {
          label: "Progressive Review",
          containers: {
            reviewApp: {
              label: "Review App",
              components: {
                softwareMap: {
                  label: "SoftwareMap",
                  codeElements: {
                    renderer: {
                      sourceRanges: [
                        {
                          file: "packages/progressive-review/app/src/software-map/SoftwareMap.tsx",
                          fromLine: 1,
                          toLine: 1,
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
      relationships: [
        {
          kind: "semantic",
          from: "reviewer",
          to: "progressiveReview.reviewApp.softwareMap.renderer",
          label: "reviews",
        },
      ],
    });

    const snapshot = softwareMapSnapshotFromInlineC4Projection({
      projection: projectInlineC4({
        model,
        expandedNodeIds: new Set(["progressiveReview"]),
        selectedNodeId: "progressiveReview",
      }),
    });

    expect(snapshot.viewType).toBe("inlineC4");
    expect(snapshot.selectedNodeId).toBe("progressiveReview");
    expect(snapshot.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "progressiveReview",
          label: "Progressive Review",
          expanded: true,
          expandable: true,
          childCount: 1,
        }),
        expect.objectContaining({
          id: "progressiveReview.reviewApp",
          label: "Review App",
          type: "container",
        }),
      ]),
    );
    expect(snapshot.relationships).toEqual([
      expect.objectContaining({
        from: "reviewer",
        to: "progressiveReview.reviewApp",
        kind: "semantic",
      }),
    ]);
  });

  it("uses coverage counts for C4 node badges instead of child code counts", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveReview: {
          containers: {
            reviewApp: {
              components: {
                softwareMap: {
                  coverage: {
                    files: ["src/software-map.tsx"],
                  },
                  changeStatus: "removed",
                  codeElements: {
                    render: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                    },
                    layout: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                      changeStatus: "added",
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const changeSummaries = buildSoftwareMapChangeSummaries(
      model,
      new Map([
        [
          "progressiveReview.reviewApp.softwareMap.render",
          { additions: 4, deletions: 2 },
        ],
      ]),
      new Map([
        [
          "progressiveReview.reviewApp.softwareMap",
          { additions: 7, deletions: 1, files: [] },
        ],
      ]),
    );
    const snapshot = softwareMapSnapshotFromInlineC4Projection({
      projection: projectInlineC4({
        model,
        expandedNodeIds: new Set([
          "progressiveReview",
          "progressiveReview.reviewApp",
        ]),
        selectedNodeId: "progressiveReview.reviewApp.softwareMap",
      }),
      changeSummaries,
    });

    expect(snapshot.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "progressiveReview.reviewApp.softwareMap",
          changeStatus: "removed",
          authoredChangeStatus: "removed",
          additions: 7,
          deletions: 1,
        }),
      ]),
    );
    expect(snapshot.unmappedDiff).toMatchObject({
      additions: 7,
      deletions: 1,
    });
  });

  it("keeps code counts on code nodes while C4 counts come from coverage", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveReview: {
          containers: {
            reviewApp: {
              components: {
                coveredComponent: {
                  coverage: {
                    files: ["src/covered.ts"],
                  },
                  changeStatus: "unchanged",
                  codeElements: {
                    createdSymbol: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                      changeStatus: "modified",
                    },
                  },
                },
                uncoveredComponent: {
                  codeElements: {
                    changedSymbol: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                    },
                  },
                },
                topologicallyAdded: {
                  codeElements: {
                    addedSymbol: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                      changeStatus: "added",
                    },
                  },
                },
                topologicallyRemoved: {
                  codeElements: {
                    removedSymbol: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                      changeStatus: "removed",
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const changeSummaries = buildSoftwareMapChangeSummaries(
      model,
      new Map([
        [
          "progressiveReview.reviewApp.coveredComponent.createdSymbol",
          { additions: 21, deletions: 0 },
        ],
        [
          "progressiveReview.reviewApp.uncoveredComponent.changedSymbol",
          { additions: 4, deletions: 2 },
        ],
      ]),
      new Map([
        [
          "progressiveReview.reviewApp.coveredComponent",
          { additions: 8, deletions: 1, files: [] },
        ],
      ]),
    );

    expect(
      changeSummaries.get(
        "progressiveReview.reviewApp.coveredComponent.createdSymbol",
      ),
    ).toMatchObject({ changeStatus: "modified", additions: 21, deletions: 0 });
    expect(
      changeSummaries.get("progressiveReview.reviewApp.coveredComponent"),
    ).toMatchObject({ changeStatus: "modified", additions: 8, deletions: 1 });
    expect(
      changeSummaries.get(
        "progressiveReview.reviewApp.uncoveredComponent.changedSymbol",
      ),
    ).toMatchObject({ changeStatus: "modified", additions: 4, deletions: 2 });
    expect(
      changeSummaries.get("progressiveReview.reviewApp.uncoveredComponent"),
    ).toMatchObject({ changeStatus: "modified", additions: 0, deletions: 0 });
    expect(
      changeSummaries.get(
        "progressiveReview.reviewApp.topologicallyAdded.addedSymbol",
      ),
    ).toMatchObject({ changeStatus: "added", additions: 0, deletions: 0 });
    expect(
      changeSummaries.get(
        "progressiveReview.reviewApp.topologicallyRemoved.removedSymbol",
      ),
    ).toMatchObject({ changeStatus: "removed", additions: 0, deletions: 0 });
    expect(changeSummaries.get("progressiveReview.reviewApp")).toMatchObject({
      changeStatus: "modified",
      additions: 8,
      deletions: 1,
    });
  });

  it("can hide removed topology while preserving live changed nodes", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveReview: {
          containers: {
            reviewApp: {
              components: {
                liveComponent: {
                  codeElements: {
                    liveSymbol: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                      changeStatus: "modified",
                    },
                  },
                },
                removedComponent: {
                  changeStatus: "removed",
                  codeElements: {
                    removedSymbol: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                      changeStatus: "removed",
                    },
                  },
                },
              },
            },
          },
        },
      },
      relationships: [
        {
          kind: "semantic",
          from: "progressiveReview.reviewApp.liveComponent.liveSymbol",
          to: "progressiveReview.reviewApp.removedComponent.removedSymbol",
          label: "called old code",
        },
      ],
    });

    const projection = projectInlineC4({
      model,
      expandedNodeIds: new Set([
        "progressiveReview",
        "progressiveReview.reviewApp",
        "progressiveReview.reviewApp.liveComponent",
        "progressiveReview.reviewApp.removedComponent",
      ]),
      showRemovedNodes: false,
    });

    expect(projection.nodes.map((node) => node.id)).toContain(
      "progressiveReview.reviewApp.liveComponent.liveSymbol",
    );
    expect(projection.nodes.map((node) => node.id)).not.toContain(
      "progressiveReview.reviewApp.removedComponent",
    );
    expect(projection.nodes.map((node) => node.id)).not.toContain(
      "progressiveReview.reviewApp.removedComponent.removedSymbol",
    );
    expect(projection.relationships).toHaveLength(0);
  });

  it("rolls topology-only child modifications up to C4 parents", () => {
    const model = defineSoftwareModel({
      systems: {
        devFast: {
          containers: {
            cli: {
              label: "dev CLI",
              components: {
                commandRouter: {
                  label: "Command router",
                  changeStatus: "modified",
                },
              },
            },
          },
        },
      },
    });

    const changeSummaries = buildSoftwareMapChangeSummaries(model);

    expect(changeSummaries.get("devFast.cli.commandRouter")).toMatchObject({
      changeStatus: "modified",
      additions: 0,
      deletions: 0,
    });
    expect(changeSummaries.get("devFast.cli")).toMatchObject({
      changeStatus: "modified",
      additions: 0,
      deletions: 0,
    });
    expect(changeSummaries.get("devFast")).toMatchObject({
      changeStatus: "modified",
      additions: 0,
      deletions: 0,
    });
  });

  it("turns visible C4 relationships into canvas edges", async () => {
    const model = defineSoftwareModel({
      systems: {
        devFastCi: {
          label: "dev.fast CI",
          containers: {
            webWorker: {
              label: "Web Worker",
              components: {
                queue: {
                  label: "Queue adapter",
                  codeElements: {
                    httpHandler: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                    },
                    jobWriter: {
                      sourceRanges: [
                        { file: "src/example.ts", fromLine: 1, toLine: 1 },
                      ],
                    },
                  },
                },
              },
            },
            ciWorker: { label: "CI Worker" },
            ciState: { label: "CI State" },
          },
        },
      },
      relationships: [
        {
          kind: "semantic",
          from: "devFastCi.webWorker",
          to: "devFastCi.ciWorker",
          label: "Dispatches queued runs",
        },
        {
          kind: "semantic",
          from: "devFastCi.ciWorker",
          to: "devFastCi.ciState",
          label: "Persists run state",
        },
        {
          kind: "call",
          from: "devFastCi.webWorker",
          to: "devFastCi.ciState",
          label: "reads status",
        },
        {
          kind: "semantic",
          from: "devFastCi.webWorker.queue.httpHandler",
          to: "devFastCi.webWorker.queue.jobWriter",
          label: "prepares queue write",
        },
      ],
    });
    const snapshot = softwareMapSnapshotFromInlineC4Projection({
      projection: projectInlineC4({
        model,
        expandedNodeIds: new Set(["devFastCi"]),
      }),
    });

    const flow = await createC4MapFlow(snapshot);
    const groupNode = flow.nodes.find((node) => node.id === "devFastCi");

    expect(groupNode).toMatchObject({
      type: "softwareMapC4Group",
      zIndex: 0,
    });
    expect(flow.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "devFastCi.webWorker",
        "devFastCi.ciWorker",
        "devFastCi.ciState",
      ]),
    );
    expect(
      flow.nodes.find((node) => node.id === "devFastCi.webWorker"),
    ).toMatchObject({
      type: "softwareMapC4",
      zIndex: 2,
    });
    expect(flow.edges).toEqual([
      expect.objectContaining({
        source: "devFastCi.webWorker",
        target: "devFastCi.ciWorker",
        label: "Dispatches queued runs",
        type: "softwareMapC4Edge",
        zIndex: 1,
        className: expect.stringContaining("software-map-c4-edge--semantic"),
        style: expect.objectContaining({
          stroke: "var(--map-edge)",
          strokeDasharray: undefined,
          strokeLinecap: undefined,
        }),
      }),
      expect.objectContaining({
        source: "devFastCi.ciWorker",
        target: "devFastCi.ciState",
        label: "Persists run state",
        type: "softwareMapC4Edge",
        zIndex: 1,
        className: expect.stringContaining("software-map-c4-edge--semantic"),
        style: expect.objectContaining({
          stroke: "var(--map-edge)",
          strokeDasharray: undefined,
          strokeLinecap: undefined,
        }),
      }),
      expect.objectContaining({
        source: "devFastCi.webWorker",
        target: "devFastCi.ciState",
        label: "reads status",
        type: "softwareMapC4Edge",
        zIndex: 1,
        className: expect.stringContaining("software-map-c4-edge--call"),
        style: expect.objectContaining({
          stroke: "var(--map-edge)",
          strokeDasharray: undefined,
        }),
      }),
    ]);
    expect(
      flow.edges.every((edge) =>
        String(edge.className ?? "").includes(
          "software-map-c4-edge--selected-node",
        ),
      ),
    ).toBe(false);

    const codeLevelSnapshot = softwareMapSnapshotFromInlineC4Projection({
      projection: projectInlineC4({
        model,
        expandedNodeIds: new Set([
          "devFastCi",
          "devFastCi.webWorker",
          "devFastCi.webWorker.queue",
        ]),
      }),
    });
    const codeLevelFlow = await createC4MapFlow(codeLevelSnapshot);
    expect(
      codeLevelFlow.edges.find(
        (edge) =>
          edge.source === "devFastCi.webWorker.queue.httpHandler" &&
          edge.target === "devFastCi.webWorker.queue.jobWriter",
      ),
    ).toMatchObject({
      source: "devFastCi.webWorker.queue.httpHandler",
      target: "devFastCi.webWorker.queue.jobWriter",
      label: "prepares queue write",
      className: expect.stringContaining("software-map-c4-edge--semantic"),
      style: expect.objectContaining({
        stroke: "var(--map-edge)",
        strokeDasharray: "1 5",
        strokeLinecap: "round",
      }),
    });

    const selectedSnapshot = {
      ...snapshot,
      selectedNodeId: "devFastCi.ciWorker",
    };
    const selectedFlow = await createC4MapFlow(selectedSnapshot);
    expect(
      selectedFlow.edges.filter((edge) =>
        String(edge.className ?? "").includes(
          "software-map-c4-edge--selected-node",
        ),
      ),
    ).toEqual([
      expect.objectContaining({
        source: "devFastCi.webWorker",
        target: "devFastCi.ciWorker",
        zIndex: 3,
        style: expect.objectContaining({ stroke: "var(--accent)" }),
        markerEnd: expect.objectContaining({ color: "var(--accent)" }),
      }),
      expect.objectContaining({
        source: "devFastCi.ciWorker",
        target: "devFastCi.ciState",
        zIndex: 3,
        style: expect.objectContaining({ stroke: "var(--accent)" }),
        markerEnd: expect.objectContaining({ color: "var(--accent)" }),
      }),
    ]);

    const activeRelationshipFlow = await createC4MapFlow(snapshot, {
      relationshipStateById: new Map([
        [
          "projected:devFastCi.webWorker->devFastCi.ciWorker:semantic",
          "active",
        ],
      ]),
    });
    expect(
      activeRelationshipFlow.edges.find(
        (edge) =>
          edge.source === "devFastCi.webWorker" &&
          edge.target === "devFastCi.ciWorker",
      ),
    ).toMatchObject({
      className: expect.stringContaining(
        "software-map-c4-edge--operation-active",
      ),
      zIndex: 4,
      style: expect.objectContaining({
        stroke: "var(--selection)",
        strokeWidth: 3,
      }),
      markerEnd: expect.objectContaining({ color: "var(--selection)" }),
      data: expect.objectContaining({ operationState: "active" }),
    });

    const routedEdge = flow.edges.find(
      (edge) => edge.label === "Persists run state",
    );
    const routedPoints = c4EdgePointsForTest(routedEdge?.data);

    expect(routedPoints.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < routedPoints.length; index += 1) {
      const previous = routedPoints[index - 1]!;
      const next = routedPoints[index]!;
      expect(previous.x === next.x || previous.y === next.y).toBe(true);
    }
  });

  it("uses routed C4 edge sections without schema endpoint rewrites", () => {
    const points = c4EdgePointsFromSections([
      {
        startPoint: { x: 100, y: 100 },
        bendPoints: [
          { x: 160, y: 100 },
          { x: 160, y: 220 },
        ],
        endPoint: { x: 260, y: 220 },
      },
    ]);

    expect(points).toEqual([
      { x: 100, y: 100 },
      { x: 160, y: 100 },
      { x: 160, y: 220 },
      { x: 260, y: 220 },
    ]);
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1]!;
      const next = points[index]!;
      expect(previous.x === next.x || previous.y === next.y).toBe(true);
    }
  });

  it("spreads multiple schema edges across table header lanes", async () => {
    const snapshot = {
      viewType: "inlineC4" as const,
      nodes: [
        {
          id: "edges",
          type: "dataStoreCollection" as const,
          label: "edges",
          dataStoreSchemaSections: [
            {
              id: "table:edges",
              kind: "table" as const,
              label: "edges",
              rows: [
                { id: "edges:from_id", label: "from_id", foreignKey: true },
                { id: "edges:to_id", label: "to_id", foreignKey: true },
              ],
            },
          ],
        },
        {
          id: "nodes",
          type: "dataStoreCollection" as const,
          label: "nodes",
          dataStoreSchemaSections: [
            {
              id: "table:nodes",
              kind: "table" as const,
              label: "nodes",
              rows: [{ id: "nodes:id", label: "id", primaryKey: true }],
            },
          ],
        },
      ],
      relationships: [
        {
          id: "schema-fk:edges.from_id->nodes.id",
          from: "edges",
          to: "nodes",
          kind: "semantic" as const,
          semanticKind: "foreign key",
          hideLabel: true,
          fromSchemaFieldPath: ["from_id"],
          fromSchemaEndpointKind: "field" as const,
          toSchemaEndpointKind: "header" as const,
        },
        {
          id: "schema-fk:edges.to_id->nodes.id",
          from: "edges",
          to: "nodes",
          kind: "semantic" as const,
          semanticKind: "foreign key",
          hideLabel: true,
          fromSchemaFieldPath: ["to_id"],
          fromSchemaEndpointKind: "field" as const,
          toSchemaEndpointKind: "header" as const,
        },
      ],
    };

    const flow = await createC4MapFlow(snapshot);
    const routedPoints = flow.edges.map((edge) =>
      c4EdgePointsForTest(edge.data),
    );

    expect(flow.edges.map((edge) => edge.label)).toEqual([
      undefined,
      undefined,
    ]);
    for (const points of routedPoints) {
      expect(points.length).toBeGreaterThanOrEqual(2);
      for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1]!;
        const next = points[index]!;
        expect(previous.x === next.x || previous.y === next.y).toBe(true);
      }
    }
    expect(
      flow.edges.map((edge) =>
        Object.prototype.hasOwnProperty.call(
          edge.data ?? {},
          "endpointOverrides",
        ),
      ),
    ).toEqual([false, false]);
  });

  it("keeps positioned C4 edge labels on their edges while avoiding overlaps", () => {
    const edgeSections = new Map([
      [
        "edge-a",
        [
          {
            startPoint: { x: 0, y: 0 },
            endPoint: { x: 420, y: 0 },
          },
        ],
      ],
      [
        "edge-b",
        [
          {
            startPoint: { x: 0, y: 0 },
            endPoint: { x: 420, y: 0 },
          },
        ],
      ],
    ]);
    const edgeLabels = new Map([
      ["edge-a", { x: 180, y: -12, width: 96, height: 24 }],
      ["edge-b", { x: 180, y: -12, width: 96, height: 24 }],
    ]);
    const nodeObstacles = [{ x: 150, y: -44, width: 120, height: 88 }];

    const positioned = positionC4EdgeLabels(
      edgeSections,
      edgeLabels,
      nodeObstacles,
    );
    const first = positioned.get("edge-a");
    const second = positioned.get("edge-b");

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first!.y + first!.height / 2).toBe(0);
    expect(second!.y + second!.height / 2).toBe(0);
    expect(labelBoxesOverlapForTest(first!, nodeObstacles[0]!)).toBe(false);
    expect(labelBoxesOverlapForTest(second!, nodeObstacles[0]!)).toBe(false);
    expect(labelBoxesOverlapForTest(first!, second!)).toBe(false);
  });

  it("builds stable SoftwareMap label paths", () => {
    const parent = {
      id: "system",
      path: "system",
      label: "System",
      type: "softwareSystem",
    } satisfies SoftwareMapNodeSnapshot;
    const child = {
      id: "worker",
      path: "system.worker",
      label: "Worker",
      type: "container",
      parentId: parent.id,
    } satisfies SoftwareMapNodeSnapshot;
    const nodes = new Map<string, SoftwareMapNodeSnapshot>([
      [parent.id, parent],
      [child.id, child],
    ]);
    expect(softwareMapNodeLabelPath(child, nodes)).toEqual([
      "System",
      "Worker",
    ]);
    expect(
      softwareMapRelationshipLabelPath(
        { id: "edge", from: parent.id, to: child.id, label: "Runs" },
        [{ id: "edge", from: parent.id, to: child.id, label: "Runs" }],
        nodes,
      ),
    ).toEqual(["System→Worker"]);
  });

  it("keeps SoftwareMap node fingerprints independent of expansion state", () => {
    const node = {
      id: "worker",
      path: "system.worker",
      label: "Worker",
      type: "container" as const,
      expanded: false,
      expandable: true,
      childCount: 2,
    };
    expect(softwareMapNodeTargetPayload(node)).toEqual(
      softwareMapNodeTargetPayload({ ...node, expanded: true }),
    );
  });

  it("rejects ambiguous parallel SoftwareMap edge paths", () => {
    expect(() =>
      softwareMapLiveDiagram("Map", "inline-c4", {
        title: "Map",
        view: "inline-c4",
        viewType: "inlineC4",
        nodes: [
          { id: "browser", path: "browser", label: "Browser", type: "person" },
          { id: "worker", path: "worker", label: "Worker", type: "container" },
        ],
        relationships: [
          { id: "first", from: "browser", to: "worker" },
          { id: "second", from: "browser", to: "worker" },
        ],
      }),
    ).toThrow(
      "Label must be unique among parallel Browser→Worker relationships",
    );
  });

  it("allows unlabelled edges between distinct same-labelled endpoint pairs", () => {
    const diagram = softwareMapLiveDiagram("Map", "inline-c4", {
      title: "Map",
      view: "inline-c4",
      viewType: "inlineC4",
      nodes: [
        {
          id: "nodeHost",
          path: "nodeHost",
          label: "Node host",
          type: "container",
        },
        {
          id: "workerRuntime",
          path: "workerRuntime",
          label: "Worker runtime",
          type: "container",
        },
        {
          id: "nodeHost.expand",
          path: "nodeHost.expand",
          label: "expandSetupKeyFiles",
          type: "component",
          parentId: "nodeHost",
        },
        {
          id: "nodeHost.glob",
          path: "nodeHost.glob",
          label: "hasGlobPattern",
          type: "component",
          parentId: "nodeHost",
        },
        {
          id: "workerRuntime.expand",
          path: "workerRuntime.expand",
          label: "expandSetupKeyFiles",
          type: "component",
          parentId: "workerRuntime",
        },
        {
          id: "workerRuntime.glob",
          path: "workerRuntime.glob",
          label: "hasGlobPattern",
          type: "component",
          parentId: "workerRuntime",
        },
      ],
      relationships: [
        { id: "first", from: "nodeHost.expand", to: "nodeHost.glob" },
        {
          id: "second",
          from: "workerRuntime.expand",
          to: "workerRuntime.glob",
        },
      ],
    });

    const edgePaths = diagram.elements
      .filter((element) => element.element.type === "edge")
      .map((element) => element.element.path);
    expect(edgePaths).toEqual([
      ["Node host.expandSetupKeyFiles→Node host.hasGlobPattern"],
      ["Worker runtime.expandSetupKeyFiles→Worker runtime.hasGlobPattern"],
    ]);
  });

  it("allows unlabelled parallel edges of different kinds between one pair", () => {
    const diagram = softwareMapLiveDiagram("Map", "inline-c4", {
      title: "Map",
      view: "inline-c4",
      viewType: "inlineC4",
      nodes: [
        {
          id: "effect",
          path: "effect",
          label: "useEffect() callback",
          type: "component",
        },
        { id: "update", path: "update", label: "update", type: "component" },
      ],
      relationships: [
        { id: "aggregated-calls", from: "effect", to: "update", kind: "call" },
        {
          id: "aggregated-semantics",
          from: "effect",
          to: "update",
          kind: "semantic",
        },
        {
          id: "schema-link",
          from: "effect",
          to: "update",
          kind: "semantic",
          semanticKind: "foreign key",
        },
      ],
    });

    const edgePaths = diagram.elements
      .filter((element) => element.element.type === "edge")
      .map((element) => element.element.path);
    expect(edgePaths).toEqual([
      ["useEffect() callback→update", "(call)"],
      ["useEffect() callback→update", "(semantic)"],
      ["useEffect() callback→update", "(semantic: foreign key)"],
    ]);
  });

  it("still rejects unlabelled parallel edges of the same kind", () => {
    expect(() =>
      softwareMapLiveDiagram("Map", "inline-c4", {
        title: "Map",
        view: "inline-c4",
        viewType: "inlineC4",
        nodes: [
          { id: "browser", path: "browser", label: "Browser", type: "person" },
          {
            id: "worker",
            path: "worker",
            label: "Worker",
            type: "container",
          },
        ],
        relationships: [
          { id: "first", from: "browser", to: "worker", kind: "call" },
          { id: "second", from: "browser", to: "worker", kind: "call" },
        ],
      }),
    ).toThrow(
      "Label must be unique among parallel Browser→Worker relationships",
    );
  });

  it("still rejects duplicate labels among truly parallel edges", () => {
    expect(() =>
      softwareMapLiveDiagram("Map", "inline-c4", {
        title: "Map",
        view: "inline-c4",
        viewType: "inlineC4",
        nodes: [
          { id: "browser", path: "browser", label: "Browser", type: "person" },
          {
            id: "worker",
            path: "worker",
            label: "Worker",
            type: "container",
          },
        ],
        relationships: [
          { id: "first", from: "browser", to: "worker", label: "sends" },
          { id: "second", from: "browser", to: "worker", label: "sends" },
        ],
      }),
    ).toThrow(
      "Label must be unique among parallel Browser→Worker relationships",
    );
  });

  it("keeps node comment buttons beside world-space nodes", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), {
      encoding: "utf8",
    });

    expect(styles).toMatch(
      /\.software-map-c4-node-shell::after,\s*\.software-map-c4-group-shell::after\s*{[^}]*top:\s*50%;[^}]*right:\s*-34px;[^}]*width:\s*38px;[^}]*height:\s*48px;[^}]*transform:\s*translateY\(-50%\);/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-node-shell > \.comment-hover-button,\s*\.software-map-c4-group-shell > \.comment-hover-button\s*{[^}]*top:\s*50%;[^}]*right:\s*auto;[^}]*left:\s*calc\(100% \+ 5px\);[^}]*z-index:\s*41;[^}]*width:\s*auto;[^}]*min-width:\s*30px;[^}]*height:\s*30px;[^}]*transform:\s*translateY\(-50%\);/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-edge-comment-target\s*{[^}]*z-index:\s*40;/s,
    );
    expect(styles).toMatch(
      /\.software-map-c4-edge-comment-target > \.comment-hover-button\s*{[^}]*z-index:\s*41;/s,
    );
    expect(styles).not.toContain("software-map-c4-compact-screen-scale");
    expect(styles).toMatch(
      /\.software-map-c4-node-shell:hover > \.comment-hover-button,\s*\.software-map-c4-group-shell:hover > \.comment-hover-button,/s,
    );
  });

  it("uses spatial scoring for visible mixed-depth node selection", () => {
    const positions = [
      { id: "current", x: 100, y: 100 },
      { id: "right", x: 200, y: 100 },
      { id: "down", x: 100, y: 200 },
      { id: "left", x: 0, y: 100 },
      { id: "up", x: 100, y: 0 },
    ];

    expect(findSpatialC4Node("current", positions, "right")).toBe("right");
    expect(findSpatialC4Node("current", positions, "down")).toBe("down");
    expect(findSpatialC4Node("current", positions, "left")).toBe("left");
    expect(findSpatialC4Node("current", positions, "up")).toBe("up");
    expect(findSpatialC4Node(null, positions, "right")).toBe("up");
  });

  it("maps hjkl and arrow keys to C4 navigation directions", () => {
    expect(c4SpatialDirectionForKey("h")).toBe("left");
    expect(c4SpatialDirectionForKey("ArrowLeft")).toBe("left");
    expect(c4SpatialDirectionForKey("j")).toBe("down");
    expect(c4SpatialDirectionForKey("ArrowDown")).toBe("down");
    expect(c4SpatialDirectionForKey("k")).toBe("up");
    expect(c4SpatialDirectionForKey("ArrowUp")).toBe("up");
    expect(c4SpatialDirectionForKey("l")).toBe("right");
    expect(c4SpatialDirectionForKey("ArrowRight")).toBe("right");
    expect(c4SpatialDirectionForKey("x")).toBe(null);
  });

  it("keeps keyboard navigation within the selected C4 hierarchy level", () => {
    const positions = [
      { id: "parent", parentId: null, x: 0, y: 0 },
      { id: "current", parentId: "parent", x: 100, y: 100 },
      { id: "sibling", parentId: "parent", x: 200, y: 100 },
      { id: "other-parent-child", parentId: "other", x: 140, y: 100 },
      { id: "nested-child", parentId: "current", x: 150, y: 100 },
      { id: "root-neighbor", parentId: null, x: 160, y: 100 },
    ];

    expect(findSpatialC4Node("current", positions, "right")).toBe("sibling");
  });

  it("enters visible children when selected C4 group has no same-level target", () => {
    const positions = [
      {
        id: "current",
        parentId: "parent",
        x: 100,
        y: 100,
        width: 400,
        height: 240,
      },
      {
        id: "child-left",
        parentId: "current",
        x: 140,
        y: 140,
        width: 100,
        height: 80,
      },
      {
        id: "child-down",
        parentId: "current",
        x: 260,
        y: 250,
        width: 100,
        height: 80,
      },
      {
        id: "other-parent-child",
        parentId: "other",
        x: 260,
        y: 260,
        width: 100,
        height: 80,
      },
    ];

    expect(findSpatialC4Node("current", positions, "down")).toBe("child-down");
  });
});

describe("runInlineC4Layout stability", () => {
  // A mutually-connected pair so cycle breaking (not just topology) decides
  // which node ELK places on the left.
  const relationships: SoftwareMapRelationshipSnapshot[] = [
    { from: "server", to: "canvas", label: "serves" },
    { from: "canvas", to: "server", label: "queries" },
  ];
  // Labels sort "alpha canvas" before "zeta server", so model order alone
  // would put the canvas first; the previous layout says the opposite.
  const previousLayout: InlineC4LayoutResult = {
    nodeBboxes: new Map([
      ["server", { x: 0, y: 0, width: 280, height: 112 }],
      ["canvas", { x: 600, y: 0, width: 280, height: 112 }],
    ]),
    groupBboxes: new Map(),
    childLayoutKeys: new Map(),
  };

  it("alternates system, container, and component layout axes", async () => {
    const nodes: SoftwareMapNodeSnapshot[] = [
      {
        id: "system",
        label: "System",
        type: "softwareSystem",
        expanded: true,
      },
      {
        id: "external",
        label: "External",
        type: "softwareSystem",
      },
      {
        id: "server",
        label: "Server",
        type: "container",
        parentId: "system",
        expanded: true,
      },
      {
        id: "canvas",
        label: "Canvas",
        type: "container",
        parentId: "system",
      },
      {
        id: "api",
        label: "API",
        type: "component",
        parentId: "server",
      },
      {
        id: "store",
        label: "Store",
        type: "component",
        parentId: "server",
      },
    ];
    const layoutRelationships: SoftwareMapRelationshipSnapshot[] = [
      { from: "api", to: "store" },
      { from: "api", to: "canvas" },
      { from: "canvas", to: "external" },
    ];
    const { layout } = await runInlineC4Layout(nodes, layoutRelationships);
    const centers = c4CentersById(layout.nodes);
    const system = centers.get("system")!;
    const external = centers.get("external")!;
    const server = centers.get("server")!;
    const canvas = centers.get("canvas")!;
    const api = centers.get("api")!;
    const store = centers.get("store")!;

    expect(system.x).toBeLessThan(external.x);
    expect(Math.abs(canvas.y - server.y)).toBeGreaterThan(
      Math.abs(canvas.x - server.x),
    );
    expect(api.x).toBeLessThan(store.x);

    const flow = createC4MapFlowFromLayout(
      {
        viewType: "inlineC4",
        nodes,
        relationships: layoutRelationships,
      },
      layout,
    );
    const componentEdge = flow.edges.find(
      (edge) => edge.source === "api" && edge.target === "store",
    );
    expect(componentEdge).toMatchObject({
      sourceHandle: "source-right",
      targetHandle: "target-left",
    });
    const componentPoints = c4EdgePointsForTest(componentEdge?.data);
    const apiEntry = layout.nodes.find((entry) => entry.node.id === "api")!;
    const storeEntry = layout.nodes.find((entry) => entry.node.id === "store")!;
    expect(componentPoints[0]?.x).toBeCloseTo(apiEntry.x + apiEntry.width, 4);
    expect(componentPoints.at(-1)?.x).toBeCloseTo(storeEntry.x, 4);
    expect(
      c4EdgeEndpointBubbles(componentPoints, { from: "api" })[0],
    ).toMatchObject({
      x: componentPoints[0]?.x,
      y: componentPoints[0]?.y,
    });

    const crossContainerEdge = flow.edges.find(
      (edge) => edge.source === "api" && edge.target === "canvas",
    );
    const crossContainerPoints = c4EdgePointsForTest(crossContainerEdge?.data);
    const systemEntry = layout.nodes.find(
      (entry) => entry.node.id === "system",
    )!;
    expect(crossContainerPoints.length).toBeGreaterThanOrEqual(2);
    expect(
      crossContainerPoints.every(
        (point) =>
          point.x >= systemEntry.x &&
          point.x <= systemEntry.x + systemEntry.width &&
          point.y >= systemEntry.y &&
          point.y <= systemEntry.y + systemEntry.height,
      ),
    ).toBe(true);
  });

  it("keeps the previous left-to-right order when a node expands", async () => {
    // Mirrors the real expansion scenario: the parent-level edges retarget to
    // the newly revealed children (which have no previous positions), forming
    // cross-hierarchy cycles that cycle breaking must resolve from the
    // previous on-screen arrangement.
    const nodes: SoftwareMapNodeSnapshot[] = [
      {
        id: "server",
        label: "zeta server",
        type: "container",
        expanded: true,
        expandable: true,
      },
      {
        id: "server.plugin",
        label: "plugin",
        type: "component",
        parentId: "server",
      },
      {
        id: "server.watcher",
        label: "watcher",
        type: "component",
        parentId: "server",
      },
      { id: "canvas", label: "alpha canvas", type: "container" },
      { id: "runtime", label: "review runtime", type: "container" },
    ];
    const expandedRelationships: SoftwareMapRelationshipSnapshot[] = [
      { from: "server.plugin", to: "canvas", label: "serves" },
      { from: "canvas", to: "server.watcher", label: "queries" },
      { from: "server.plugin", to: "server.watcher", label: "notifies" },
      { from: "runtime", to: "server.plugin", label: "starts" },
      { from: "runtime", to: "canvas", label: "writes session" },
    ];
    const expandedPreviousLayout: InlineC4LayoutResult = {
      nodeBboxes: new Map([
        ["server", { x: 300, y: 200, width: 280, height: 112 }],
        ["canvas", { x: 900, y: 180, width: 280, height: 160 }],
        ["runtime", { x: 0, y: 0, width: 280, height: 112 }],
      ]),
      groupBboxes: new Map(),
      childLayoutKeys: new Map(),
    };

    const { layout } = await runInlineC4Layout(
      nodes,
      expandedRelationships,
      undefined,
      expandedPreviousLayout,
    );

    const server = layout.nodes.find((entry) => entry.node.id === "server");
    const canvas = layout.nodes.find((entry) => entry.node.id === "canvas");
    expect(server).toBeDefined();
    expect(canvas).toBeDefined();
    expect(server!.x + server!.width / 2).toBeLessThan(
      canvas!.x + canvas!.width / 2,
    );
  });

  it("keeps the previous left-to-right order for collapsed nodes", async () => {
    const nodes: SoftwareMapNodeSnapshot[] = [
      { id: "server", label: "zeta server", type: "container" },
      { id: "canvas", label: "alpha canvas", type: "container" },
    ];

    const { layout } = await runInlineC4Layout(
      nodes,
      relationships,
      undefined,
      previousLayout,
    );

    const server = layout.nodes.find((entry) => entry.node.id === "server");
    const canvas = layout.nodes.find((entry) => entry.node.id === "canvas");
    expect(server!.x + server!.width / 2).toBeLessThan(
      canvas!.x + canvas!.width / 2,
    );
  });

  it("keeps order when expanding a node inside an expanded parent group", async () => {
    // Mirrors the real flip: inside an expanded system, the canvas has three
    // edges into the expanding server's children and only one edge back, so
    // greedy cycle breaking would reverse the single back-edge and pull the
    // canvas to the left of the server it used to sit right of.
    const nodes: SoftwareMapNodeSnapshot[] = [
      {
        id: "system",
        label: "system",
        type: "softwareSystem",
        expanded: true,
        expandable: true,
      },
      {
        id: "system.runtime",
        label: "runtime",
        type: "container",
        parentId: "system",
      },
      {
        id: "system.server",
        label: "server",
        type: "container",
        parentId: "system",
        expanded: true,
        expandable: true,
      },
      {
        id: "system.server.plugin",
        label: "plugin",
        type: "component",
        parentId: "system.server",
      },
      {
        id: "system.server.resolver",
        label: "resolver",
        type: "component",
        parentId: "system.server",
      },
      {
        id: "system.server.patch",
        label: "patch",
        type: "component",
        parentId: "system.server",
      },
      {
        id: "system.canvas",
        label: "canvas",
        type: "container",
        parentId: "system",
      },
      {
        id: "system.artifacts",
        label: "artifacts",
        type: "container",
        parentId: "system",
      },
    ];
    const nestedRelationships: SoftwareMapRelationshipSnapshot[] = [
      { from: "system.runtime", to: "system.server.plugin", label: "starts" },
      {
        from: "system.server.plugin",
        to: "system.canvas",
        label: "validates",
      },
      { from: "system.canvas", to: "system.server.resolver", label: "asks" },
      { from: "system.canvas", to: "system.server.plugin", label: "requests" },
      { from: "system.canvas", to: "system.server.patch", label: "writes" },
      {
        from: "system.server.plugin",
        to: "system.server.resolver",
        label: "routes",
      },
      {
        from: "system.server.plugin",
        to: "system.server.patch",
        label: "routes",
      },
      { from: "system.runtime", to: "system.artifacts", label: "writes" },
    ];
    const nestedPreviousLayout: InlineC4LayoutResult = {
      nodeBboxes: new Map([
        ["system.runtime", { x: 100, y: 300, width: 280, height: 112 }],
        ["system.server", { x: 700, y: 300, width: 280, height: 112 }],
        ["system.canvas", { x: 1300, y: 280, width: 280, height: 160 }],
        ["system.artifacts", { x: 1300, y: 600, width: 280, height: 112 }],
      ]),
      groupBboxes: new Map([
        ["system", { x: 0, y: 180, width: 1700, height: 700 }],
      ]),
      childLayoutKeys: new Map(),
    };

    const { layout } = await runInlineC4Layout(
      nodes,
      nestedRelationships,
      undefined,
      nestedPreviousLayout,
    );

    const server = layout.nodes.find(
      (entry) => entry.node.id === "system.server" && entry.expandedGroup,
    );
    const canvas = layout.nodes.find(
      (entry) => entry.node.id === "system.canvas",
    );
    expect(server).toBeDefined();
    expect(canvas).toBeDefined();
    expect(server!.x + server!.width / 2).toBeLessThan(
      canvas!.x + canvas!.width / 2,
    );
  });

  it("keeps vertical sibling order from the previous layout", async () => {
    // Crossing edges tempt ELK to swap top and bottom rows; the previous
    // layout must win so rows do not reshuffle on expand/collapse.
    const nodes: SoftwareMapNodeSnapshot[] = [
      { id: "sourceTop", label: "source top", type: "container" },
      { id: "sourceBottom", label: "source bottom", type: "container" },
      { id: "targetTop", label: "target top", type: "container" },
      { id: "targetBottom", label: "target bottom", type: "container" },
    ];
    // Edges cross given the previous arrangement: top source feeds the
    // bottom target and vice versa. Unconstrained crossing minimization
    // removes the crossing by swapping one of the pairs.
    const crossingRelationships: SoftwareMapRelationshipSnapshot[] = [
      { from: "sourceTop", to: "targetBottom", label: "feeds" },
      { from: "sourceBottom", to: "targetTop", label: "feeds" },
    ];
    const verticalPreviousLayout: InlineC4LayoutResult = {
      nodeBboxes: new Map([
        ["sourceTop", { x: 0, y: 0, width: 280, height: 112 }],
        ["sourceBottom", { x: 0, y: 300, width: 280, height: 112 }],
        ["targetTop", { x: 600, y: 0, width: 280, height: 112 }],
        ["targetBottom", { x: 600, y: 300, width: 280, height: 112 }],
      ]),
      groupBboxes: new Map(),
      childLayoutKeys: new Map(),
    };

    const { layout } = await runInlineC4Layout(
      nodes,
      crossingRelationships,
      undefined,
      verticalPreviousLayout,
    );

    const centerY = (id: string) => {
      const entry = layout.nodes.find((candidate) => candidate.node.id === id);
      expect(entry).toBeDefined();
      return entry!.y + entry!.height / 2;
    };
    expect(centerY("sourceTop")).toBeLessThan(centerY("sourceBottom"));
    expect(centerY("targetTop")).toBeLessThan(centerY("targetBottom"));
  });

  it("locally inflates expanded siblings without flipping their order", async () => {
    const collapsedNodes: SoftwareMapNodeSnapshot[] = [
      { id: "left", label: "left", type: "container" },
      {
        id: "middle",
        label: "middle",
        type: "container",
        expandable: true,
      },
      { id: "right", label: "right", type: "container" },
    ];
    const expandedNodes: SoftwareMapNodeSnapshot[] = [
      collapsedNodes[0]!,
      { ...collapsedNodes[1]!, expanded: true },
      {
        id: "middle.a",
        label: "middle child a",
        type: "component",
        parentId: "middle",
      },
      {
        id: "middle.b",
        label: "middle child b",
        type: "component",
        parentId: "middle",
      },
      collapsedNodes[2]!,
    ];
    const collapsedPreviousLayout: InlineC4LayoutResult = {
      nodeBboxes: new Map([
        ["left", { x: 0, y: 0, width: 280, height: 112 }],
        ["middle", { x: 420, y: 0, width: 280, height: 112 }],
        ["right", { x: 840, y: 0, width: 280, height: 112 }],
      ]),
      groupBboxes: new Map(),
      childLayoutKeys: new Map(),
    };
    const localRelationships: SoftwareMapRelationshipSnapshot[] = [
      {
        id: "left-to-right",
        from: "left",
        to: "right",
        label: "calls",
      },
      {
        id: "middle-left-to-right",
        from: "middle.a",
        to: "middle.b",
      },
    ];

    const expanded = await runInlineC4Layout(
      expandedNodes,
      localRelationships,
      undefined,
      collapsedPreviousLayout,
    );
    const expandedCenters = c4CentersById(expanded.layout.nodes);

    expect(expandedCenters.get("middle")!.x).toBeCloseTo(560, 4);
    expect(expandedCenters.get("left")!.x).toBeLessThan(
      expandedCenters.get("middle")!.x,
    );
    expect(expandedCenters.get("middle")!.x).toBeLessThan(
      expandedCenters.get("right")!.x,
    );
    expect(expandedCenters.get("middle.a")!.x).toBeLessThan(
      expandedCenters.get("middle.b")!.x,
    );
    expect(
      expanded.layout.nodes.find((entry) => entry.node.id === "middle"),
    ).toEqual(expect.objectContaining({ expandedGroup: true }));
    expect(
      isOrthogonalPolylineForTest(
        c4SectionPointsForTest(
          expanded.layout.edgeSections.get("left-to-right"),
        ),
      ),
    ).toBe(true);

    const contracted = await runInlineC4Layout(
      collapsedNodes,
      localRelationships,
      undefined,
      expanded.inlineLayout,
    );
    const contractedCenters = c4CentersById(contracted.layout.nodes);

    expect(contractedCenters.get("middle")!.x).toBeCloseTo(
      expandedCenters.get("middle")!.x,
      4,
    );
    expect(contractedCenters.get("left")!.x).toBeLessThan(
      contractedCenters.get("middle")!.x,
    );
    expect(contractedCenters.get("middle")!.x).toBeLessThan(
      contractedCenters.get("right")!.x,
    );
    expect(c4LayoutWidth(contracted.layout.nodes)).toBeLessThan(
      c4LayoutWidth(expanded.layout.nodes),
    );
  });

  it("does not accumulate extra gap across repeated expand collapse cycles", async () => {
    const collapsedNodes: SoftwareMapNodeSnapshot[] = [
      { id: "left", label: "left", type: "container" },
      {
        id: "middle",
        label: "middle",
        type: "container",
        expandable: true,
      },
      { id: "right", label: "right", type: "container" },
    ];
    const expandedNodes: SoftwareMapNodeSnapshot[] = [
      collapsedNodes[0]!,
      { ...collapsedNodes[1]!, expanded: true },
      {
        id: "middle.a",
        label: "middle child a",
        type: "component",
        parentId: "middle",
      },
      {
        id: "middle.b",
        label: "middle child b",
        type: "component",
        parentId: "middle",
      },
      {
        id: "middle.c",
        label: "middle child c",
        type: "component",
        parentId: "middle",
      },
      collapsedNodes[2]!,
    ];
    const localRelationships: SoftwareMapRelationshipSnapshot[] = [];
    let previousLayout: InlineC4LayoutResult = {
      nodeBboxes: new Map([
        ["left", { x: 0, y: 0, width: 280, height: 112 }],
        ["middle", { x: 520, y: 0, width: 280, height: 112 }],
        ["right", { x: 1120, y: 0, width: 280, height: 112 }],
      ]),
      groupBboxes: new Map(),
      childLayoutKeys: new Map(),
    };
    let firstContractedGaps:
      | { leftGap: number; rightGap: number; width: number }
      | undefined;

    for (let cycle = 0; cycle < 5; cycle += 1) {
      const expanded = await runInlineC4Layout(
        expandedNodes,
        localRelationships,
        undefined,
        previousLayout,
      );
      expect(c4CentersById(expanded.layout.nodes).get("middle")!.x).toBeCloseTo(
        660,
        4,
      );
      const contracted = await runInlineC4Layout(
        collapsedNodes,
        localRelationships,
        undefined,
        expanded.inlineLayout,
      );
      const gaps = c4SiblingGaps(contracted.layout.nodes, [
        "left",
        "middle",
        "right",
      ]);

      firstContractedGaps ??= gaps;
      expect(gaps.leftGap).toBeCloseTo(firstContractedGaps.leftGap, 4);
      expect(gaps.rightGap).toBeCloseTo(firstContractedGaps.rightGap, 4);
      expect(gaps.width).toBeCloseTo(firstContractedGaps.width, 4);

      previousLayout = contracted.inlineLayout;
    }
  });

  it("preserves visual rows after expanding and collapsing a middle node", async () => {
    const collapsedNodes: SoftwareMapNodeSnapshot[] = [
      { id: "githubUser", label: "GitHub user", type: "person" },
      { id: "github", label: "GitHub", type: "softwareSystem" },
      { id: "agent", label: "Agent", type: "person" },
      { id: "reviewer", label: "Reviewer", type: "person" },
      { id: "developer", label: "Developer", type: "person" },
      {
        id: "devFast",
        label: "dev.fast",
        type: "softwareSystem",
        expandable: true,
      },
      { id: "cloudflare", label: "Cloudflare", type: "softwareSystem" },
      {
        id: "localMachine",
        label: "Local developer machine",
        type: "softwareSystem",
      },
      { id: "e2b", label: "E2B", type: "softwareSystem" },
    ];
    const expandedNodes: SoftwareMapNodeSnapshot[] = [
      ...collapsedNodes.map((node) =>
        node.id === "devFast" ? { ...node, expanded: true } : node,
      ),
      {
        id: "devFast.web",
        label: "Web app",
        type: "container",
        parentId: "devFast",
      },
      {
        id: "devFast.ci",
        label: "CI worker",
        type: "container",
        parentId: "devFast",
      },
      {
        id: "devFast.review",
        label: "Review surface",
        type: "container",
        parentId: "devFast",
      },
      {
        id: "devFast.db",
        label: "Database",
        type: "container",
        parentId: "devFast",
      },
    ];
    const collapsedPreviousLayout: InlineC4LayoutResult = {
      nodeBboxes: new Map([
        ["githubUser", { x: 0, y: 180, width: 280, height: 112 }],
        ["github", { x: 360, y: 180, width: 280, height: 112 }],
        ["agent", { x: 520, y: 0, width: 280, height: 112 }],
        ["reviewer", { x: 760, y: 180, width: 280, height: 112 }],
        ["developer", { x: 1060, y: 0, width: 280, height: 112 }],
        ["devFast", { x: 1380, y: 180, width: 280, height: 112 }],
        ["cloudflare", { x: 1560, y: 0, width: 280, height: 112 }],
        ["localMachine", { x: 1880, y: 180, width: 360, height: 112 }],
        ["e2b", { x: 2280, y: 0, width: 280, height: 112 }],
      ]),
      groupBboxes: new Map(),
      childLayoutKeys: new Map(),
    };

    const expanded = await runInlineC4Layout(
      expandedNodes,
      [],
      undefined,
      collapsedPreviousLayout,
    );
    const contracted = await runInlineC4Layout(
      collapsedNodes,
      [],
      undefined,
      expanded.inlineLayout,
    );
    const contractedCenters = c4CentersById(contracted.layout.nodes);

    expect(contractedCenters.get("developer")!.y).toBeLessThan(
      contractedCenters.get("devFast")!.y - 100,
    );
    expect(contractedCenters.get("cloudflare")!.y).toBeLessThan(
      contractedCenters.get("devFast")!.y - 100,
    );
    expect(contractedCenters.get("agent")!.y).toBeLessThan(
      contractedCenters.get("github")!.y - 100,
    );
  });

  it("does not amplify repeated measured-size updates after contraction", async () => {
    const nodes: SoftwareMapNodeSnapshot[] = [
      { id: "left", label: "left", type: "container" },
      {
        id: "middle",
        label: "middle",
        type: "container",
        expandable: true,
      },
      { id: "right", label: "right", type: "container" },
    ];
    let previousLayout: InlineC4LayoutResult = {
      nodeBboxes: new Map([
        ["left", { x: 0, y: 0, width: 280, height: 112 }],
        ["middle", { x: 520, y: 0, width: 760, height: 260 }],
        ["right", { x: 1520, y: 0, width: 280, height: 112 }],
      ]),
      groupBboxes: new Map([
        ["middle", { x: 520, y: 0, width: 760, height: 260 }],
      ]),
      childLayoutKeys: new Map(),
    };
    const dimensions = [
      new Map<string, { width: number; height: number }>([
        ["left", { width: 280, height: 112 }],
        ["middle", { width: 280, height: 112 }],
        ["right", { width: 280, height: 112 }],
      ]),
      new Map<string, { width: number; height: number }>([
        ["left", { width: 281, height: 112 }],
        ["middle", { width: 280, height: 113 }],
        ["right", { width: 280, height: 112 }],
      ]),
    ];
    let firstWidth: number | undefined;

    for (let index = 0; index < 8; index += 1) {
      const next = await runInlineC4Layout(
        nodes,
        [],
        dimensions[index % dimensions.length],
        previousLayout,
      );
      const width = c4LayoutWidth(next.layout.nodes);

      firstWidth ??= width;
      expect(width).toBeLessThanOrEqual(firstWidth + 2);

      previousLayout = next.inlineLayout;
    }
  });

  it("keeps same-row neighbors on their row when collapsing a tall expanded group", async () => {
    const nodes: SoftwareMapNodeSnapshot[] = [
      { id: "left", label: "left", type: "container" },
      {
        id: "middle",
        label: "middle",
        type: "container",
        expandable: true,
      },
      { id: "right", label: "right", type: "container" },
    ];
    const previousLayout: InlineC4LayoutResult = {
      nodeBboxes: new Map([
        ["left", { x: 0, y: 200, width: 280, height: 112 }],
        ["right", { x: 1320, y: 200, width: 280, height: 112 }],
      ]),
      groupBboxes: new Map([
        ["middle", { x: 400, y: -400, width: 800, height: 1000 }],
      ]),
      childLayoutKeys: new Map(),
    };

    const { layout } = await runInlineC4Layout(
      nodes,
      [],
      undefined,
      previousLayout,
    );
    const centers = c4CentersById(layout.nodes);

    expect(centers.get("left")!.y).toBeCloseTo(256, 4);
    expect(centers.get("right")!.y).toBeCloseTo(256, 4);
  });

  it("routes dense nested expansion without a single huge router transaction", async () => {
    const childCount = 23;
    const nodes: SoftwareMapNodeSnapshot[] = [
      {
        id: "system",
        label: "system",
        type: "softwareSystem",
        expanded: true,
        expandable: true,
      },
      {
        id: "system.progressive",
        label: "Progressive review",
        type: "container",
        parentId: "system",
        expanded: true,
        expandable: true,
      },
      {
        id: "system.web",
        label: "Web app",
        type: "container",
        parentId: "system",
      },
      ...Array.from({ length: childCount }, (_, index) => ({
        id: `system.progressive.c${index}`,
        label: `Component ${index}`,
        type: "component" as const,
        parentId: "system.progressive",
      })),
    ];
    const denseRelationships: SoftwareMapRelationshipSnapshot[] = [];
    for (let index = 0; index < 65; index += 1) {
      denseRelationships.push({
        id: `dense-${index}`,
        from: `system.progressive.c${index % childCount}`,
        to: `system.progressive.c${(index * 7 + 3) % childCount}`,
        label: `edge ${index}`,
      });
    }
    const previousLayout: InlineC4LayoutResult = {
      nodeBboxes: new Map([
        ["system.progressive", { x: 300, y: 200, width: 280, height: 112 }],
        ["system.web", { x: 900, y: 200, width: 280, height: 112 }],
      ]),
      groupBboxes: new Map([
        ["system", { x: 0, y: 100, width: 1300, height: 500 }],
      ]),
      childLayoutKeys: new Map(),
    };

    const { layout } = await runInlineC4Layout(
      nodes,
      denseRelationships,
      undefined,
      previousLayout,
    );

    expect(layout.nodes).toHaveLength(nodes.length);
    expect(layout.edgeSections).toHaveLength(denseRelationships.length);
  });

  it("does not flatten an expanded parent's sibling layout when expanding a child", async () => {
    const childIds = [
      "cli",
      "traceViewer",
      "codeGraph",
      "otel",
      "ciWorker",
      "ciLibraries",
      "githubDevRouter",
      "softwareMapStore",
      "progressiveReview",
      "localServicesPlugin",
      "web",
      "repoAutomation",
    ];
    const previousBoxes = new Map<string, C4LayoutBoxForTest>(
      [
        ["cli", 0, 0],
        ["traceViewer", 400, 34],
        ["codeGraph", 800, 49],
        ["otel", 1200, 65],
        ["ciWorker", 1600, 74],
        ["ciLibraries", 2000, 74],
        ["githubDevRouter", 200, 182],
        ["softwareMapStore", 1000, 213],
        ["progressiveReview", 700, 263],
        ["localServicesPlugin", 500, 346],
        ["web", 1400, 401],
        ["repoAutomation", 1200, 474],
      ].map(([id, x, y]) => [
        id as string,
        { x: x as number, y: y as number, width: 280, height: 112 },
      ]),
    );
    const nodes: SoftwareMapNodeSnapshot[] = [
      {
        id: "system",
        label: "dev.fast",
        type: "softwareSystem",
        expanded: true,
        expandable: true,
      },
      ...childIds.map((id) => ({
        id,
        label: id,
        type: "container" as const,
        parentId: "system",
        expanded: id === "progressiveReview",
        expandable: id === "progressiveReview",
      })),
      ...Array.from({ length: 23 }, (_, index) => ({
        id: `progressiveReview.c${index}`,
        label: `Component ${index}`,
        type: "component" as const,
        parentId: "progressiveReview",
      })),
    ];
    const relationships: SoftwareMapRelationshipSnapshot[] = Array.from(
      { length: 32 },
      (_, index) => ({
        id: `progressive-${index}`,
        from: `progressiveReview.c${index % 23}`,
        to: `progressiveReview.c${(index * 5 + 2) % 23}`,
        label: `edge ${index}`,
      }),
    );
    const previousLayout: InlineC4LayoutResult = {
      nodeBboxes: previousBoxes,
      groupBboxes: new Map([
        ["system", { x: -40, y: -70, width: 2400, height: 720 }],
      ]),
      childLayoutKeys: new Map(),
    };

    const expanded = await runInlineC4Layout(
      nodes,
      relationships,
      undefined,
      previousLayout,
    );
    const directChildren = expanded.layout.nodes.filter((entry) =>
      childIds.includes(entry.node.id),
    );
    const previousRowCount = new Set(
      childIds.map((id) => Math.round(previousBoxes.get(id)!.y / 24)),
    ).size;
    const nextRowCount = new Set(
      directChildren.map((entry) => Math.round(entry.y / 24)),
    ).size;

    expect(nextRowCount).toBeGreaterThanOrEqual(previousRowCount - 1);

    const collapsedNodes = nodes
      .filter((node) => !node.id.startsWith("progressiveReview.c"))
      .map((node) =>
        node.id === "progressiveReview" ? { ...node, expanded: false } : node,
      );
    const collapsed = await runInlineC4Layout(
      collapsedNodes,
      [],
      undefined,
      expanded.inlineLayout,
    );
    const previousChildrenBbox = c4EntriesBboxForTest(
      childIds.map((id) => ({
        node: { id },
        ...previousBoxes.get(id)!,
      })),
    );
    const collapsedChildrenBbox = c4EntriesBboxForTest(
      collapsed.layout.nodes.filter((entry) =>
        childIds.includes(entry.node.id),
      ),
    );

    expect(collapsedChildrenBbox.height).toBeLessThanOrEqual(
      previousChildrenBbox.height + 80,
    );
  });

  it("deflates the outer layout after nested expansion is collapsed", async () => {
    const topLevelNodes: SoftwareMapNodeSnapshot[] = [
      { id: "githubUser", label: "GitHub user", type: "person" },
      { id: "github", label: "GitHub", type: "softwareSystem" },
      { id: "agent", label: "Agent", type: "person" },
      { id: "reviewer", label: "Reviewer", type: "person" },
      { id: "developer", label: "Developer", type: "person" },
      {
        id: "devFast",
        label: "dev.fast",
        type: "softwareSystem",
        expandable: true,
      },
      { id: "cloudflare", label: "Cloudflare", type: "softwareSystem" },
      {
        id: "localMachine",
        label: "Local developer machine",
        type: "softwareSystem",
      },
      { id: "e2b", label: "E2B", type: "softwareSystem" },
    ];
    const childIds = [
      "cli",
      "traceViewer",
      "codeGraph",
      "otel",
      "ciWorker",
      "ciLibraries",
      "githubDevRouter",
      "softwareMapStore",
      "progressiveReview",
      "localServicesPlugin",
      "web",
      "repoAutomation",
    ];
    const devFastChildren: SoftwareMapNodeSnapshot[] = childIds.map((id) => ({
      id: `devFast.${id}`,
      label: id,
      type: "container",
      parentId: "devFast",
      expandable: id === "progressiveReview",
    }));
    const progressiveChildren: SoftwareMapNodeSnapshot[] = Array.from(
      { length: 23 },
      (_, index) => ({
        id: `devFast.progressiveReview.c${index}`,
        label: `Component ${index}`,
        type: "component",
        parentId: "devFast.progressiveReview",
      }),
    );
    const collapsedPreviousLayout: InlineC4LayoutResult = {
      nodeBboxes: new Map([
        ["githubUser", { x: 0, y: 180, width: 280, height: 112 }],
        ["github", { x: 360, y: 180, width: 280, height: 112 }],
        ["agent", { x: 520, y: 0, width: 280, height: 112 }],
        ["reviewer", { x: 760, y: 180, width: 280, height: 112 }],
        ["developer", { x: 1060, y: 0, width: 280, height: 112 }],
        ["devFast", { x: 1380, y: 180, width: 280, height: 112 }],
        ["cloudflare", { x: 1560, y: 0, width: 280, height: 112 }],
        ["localMachine", { x: 1880, y: 180, width: 360, height: 112 }],
        ["e2b", { x: 2280, y: 0, width: 280, height: 112 }],
      ]),
      groupBboxes: new Map(),
      childLayoutKeys: new Map(),
    };
    const initialBbox = c4EntriesBboxForTest(
      [...collapsedPreviousLayout.nodeBboxes.entries()].map(([id, box]) => ({
        node: { id },
        ...box,
      })),
    );

    const expandedDevFast = await runInlineC4Layout(
      [
        ...topLevelNodes.map((node) =>
          node.id === "devFast" ? { ...node, expanded: true } : node,
        ),
        ...devFastChildren,
      ],
      [],
      undefined,
      collapsedPreviousLayout,
    );
    const expandedProgressiveReview = await runInlineC4Layout(
      [
        ...topLevelNodes.map((node) =>
          node.id === "devFast" ? { ...node, expanded: true } : node,
        ),
        ...devFastChildren.map((node) =>
          node.id === "devFast.progressiveReview"
            ? { ...node, expanded: true }
            : node,
        ),
        ...progressiveChildren,
      ],
      [],
      undefined,
      expandedDevFast.inlineLayout,
    );
    const collapsedProgressiveReview = await runInlineC4Layout(
      [
        ...topLevelNodes.map((node) =>
          node.id === "devFast" ? { ...node, expanded: true } : node,
        ),
        ...devFastChildren,
      ],
      [],
      undefined,
      expandedProgressiveReview.inlineLayout,
    );
    const collapsedDevFast = await runInlineC4Layout(
      topLevelNodes,
      [],
      undefined,
      collapsedProgressiveReview.inlineLayout,
    );
    const finalCenters = c4CentersById(collapsedDevFast.layout.nodes);
    const initialCenters = c4CentersById(
      [...collapsedPreviousLayout.nodeBboxes.entries()].map(([id, box]) => ({
        node: { id },
        ...box,
      })),
    );
    const finalBbox = c4EntriesBboxForTest(collapsedDevFast.layout.nodes);

    expect(finalBbox.width).toBeLessThanOrEqual(initialBbox.width + 120);
    expect(finalBbox.height).toBeLessThanOrEqual(initialBbox.height + 120);
    for (const node of topLevelNodes) {
      expect(finalCenters.get(node.id)!.x).toBeCloseTo(
        initialCenters.get(node.id)!.x,
        -2,
      );
      expect(finalCenters.get(node.id)!.y).toBeCloseTo(
        initialCenters.get(node.id)!.y,
        -2,
      );
    }
  });

  it("keeps the layout signature stable across re-rendered snapshots", () => {
    const nodes: SoftwareMapNodeSnapshot[] = [
      { id: "server", label: "zeta server", type: "container" },
      { id: "canvas", label: "alpha canvas", type: "container" },
    ];
    const rebuiltNodes = [...nodes.map((node) => ({ ...node }))].reverse();

    expect(c4LayoutSignature(nodes, relationships)).toBe(
      c4LayoutSignature(rebuiltNodes, [...relationships].reverse()),
    );
  });

  it("does not relayout when database lens row highlight state changes", () => {
    const baseNode: SoftwareMapNodeSnapshot = {
      id: "graphDb.tables.nodes",
      label: "nodes",
      type: "dataStoreCollection",
      dataStoreSchemaSections: [
        {
          id: "table:nodes",
          label: "nodes",
          kind: "table",
          rows: [
            {
              id: "nodes:id",
              label: "id",
              type: "text",
              primaryKey: true,
              state: "active",
            },
            {
              id: "nodes:source_file",
              label: "source_file",
              type: "text",
              foreignKey: true,
              state: "inactive",
            },
          ],
        },
      ],
    };
    const highlightedNode: SoftwareMapNodeSnapshot = {
      ...baseNode,
      dataStoreSchemaSections: [
        {
          ...baseNode.dataStoreSchemaSections![0]!,
          rows: baseNode.dataStoreSchemaSections![0]!.rows.map((row) => ({
            ...row,
            state: row.state === "active" ? "inactive" : "active",
          })),
        },
      ],
    };

    expect(c4LayoutSignature([baseNode], [])).toBe(
      c4LayoutSignature([highlightedNode], []),
    );
  });

  it("repaints schema row highlight state while reusing cached layout geometry", async () => {
    const baseNode: SoftwareMapNodeSnapshot = {
      id: "graphDb.tables.nodes",
      label: "nodes",
      type: "dataStoreCollection",
      dataStoreSchemaSections: [
        {
          id: "table:nodes",
          label: "nodes",
          kind: "table",
          rows: [
            {
              id: "nodes:id",
              label: "id",
              type: "text",
              primaryKey: true,
              state: "active",
            },
            {
              id: "nodes:props_json",
              label: "props_json",
              type: "json",
              state: "inactive",
            },
          ],
        },
      ],
    };
    const movedHighlightNode: SoftwareMapNodeSnapshot = {
      ...baseNode,
      dataStoreSchemaSections: [
        {
          ...baseNode.dataStoreSchemaSections![0]!,
          rows: [
            {
              ...baseNode.dataStoreSchemaSections![0]!.rows[0]!,
              state: "inactive",
            },
            {
              ...baseNode.dataStoreSchemaSections![0]!.rows[1]!,
              state: "active",
            },
          ],
        },
      ],
    };
    const { layout } = await runInlineC4Layout([baseNode], []);
    const flow = createC4MapFlowFromLayout(
      {
        view: "database:test",
        viewType: "inlineC4",
        nodes: [movedHighlightNode],
        relationships: [],
      },
      layout,
    );
    const renderedNode = flow.nodes[0]?.data.node as SoftwareMapNodeSnapshot;
    const activeRows = renderedNode.dataStoreSchemaSections
      ?.flatMap((section) => section.rows)
      .filter((row) => row.state === "active")
      .map((row) => row.id);

    expect(activeRows).toEqual(["nodes:props_json"]);
  });

  it("changes the layout signature when expansion or dimensions change", () => {
    const nodes: SoftwareMapNodeSnapshot[] = [
      { id: "server", label: "zeta server", type: "container" },
      { id: "canvas", label: "alpha canvas", type: "container" },
    ];
    const expandedNodes = nodes.map((node) =>
      node.id === "server" ? { ...node, expanded: true } : node,
    );
    const dimensions = new Map([["server", { width: 320, height: 140 }]]);

    expect(c4LayoutSignature(nodes, relationships)).not.toBe(
      c4LayoutSignature(expandedNodes, relationships),
    );
    expect(c4LayoutSignature(nodes, relationships)).not.toBe(
      c4LayoutSignature(nodes, relationships, dimensions),
    );
  });

  it("falls back when an initial node measurement has zero dimensions", async () => {
    const nodes: SoftwareMapNodeSnapshot[] = [
      { id: "developer", label: "Developer", type: "person" },
    ];
    const initialDimensions = new Map([["developer", { width: 0, height: 0 }]]);

    const { layout } = await runInlineC4Layout(nodes, [], initialDimensions);

    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]!.width).toBeGreaterThan(0);
    expect(layout.nodes[0]!.height).toBeGreaterThan(0);
  });
});

function c4CentersById(
  entries: Array<{
    node: { id: string };
    x: number;
    y: number;
    width: number;
    height: number;
  }>,
) {
  return new Map(
    entries.map((entry) => [
      entry.node.id,
      {
        x: entry.x + entry.width / 2,
        y: entry.y + entry.height / 2,
      },
    ]),
  );
}

function c4LayoutWidth(entries: Array<{ x: number; width: number }>): number {
  const minX = Math.min(...entries.map((entry) => entry.x));
  const maxX = Math.max(...entries.map((entry) => entry.x + entry.width));
  return maxX - minX;
}

function c4EntriesBboxForTest(
  entries: Array<{
    node: { id: string };
    x: number;
    y: number;
    width: number;
    height: number;
  }>,
) {
  const minX = Math.min(...entries.map((entry) => entry.x));
  const minY = Math.min(...entries.map((entry) => entry.y));
  const maxX = Math.max(...entries.map((entry) => entry.x + entry.width));
  const maxY = Math.max(...entries.map((entry) => entry.y + entry.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function c4SiblingGaps(
  entries: Array<{ node: { id: string }; x: number; width: number }>,
  ids: [string, string, string],
) {
  const boxes = new Map(entries.map((entry) => [entry.node.id, entry]));
  const left = boxes.get(ids[0]);
  const middle = boxes.get(ids[1]);
  const right = boxes.get(ids[2]);
  expect(left).toBeDefined();
  expect(middle).toBeDefined();
  expect(right).toBeDefined();
  return {
    leftGap: middle!.x - (left!.x + left!.width),
    rightGap: right!.x - (middle!.x + middle!.width),
    width: c4LayoutWidth([left!, middle!, right!]),
  };
}

function c4EdgePointsForTest(
  data: ReactFlowEdge["data"],
): Array<{ x: number; y: number }> {
  const sections = (
    data as
      | {
          sections?: Array<{
            startPoint: { x: number; y: number };
            bendPoints?: Array<{ x: number; y: number }>;
            endPoint: { x: number; y: number };
          }>;
        }
      | undefined
  )?.sections;
  return (
    sections?.flatMap((section) => [
      section.startPoint,
      ...(section.bendPoints ?? []),
      section.endPoint,
    ]) ?? []
  );
}

function c4SectionPointsForTest(
  sections:
    | Array<{
        startPoint: { x: number; y: number };
        bendPoints?: Array<{ x: number; y: number }>;
        endPoint: { x: number; y: number };
      }>
    | undefined,
): Array<{ x: number; y: number }> {
  return (
    sections?.flatMap((section) => [
      section.startPoint,
      ...(section.bendPoints ?? []),
      section.endPoint,
    ]) ?? []
  );
}

function isOrthogonalPolylineForTest(points: Array<{ x: number; y: number }>) {
  if (points.length < 2) return false;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const next = points[index]!;
    if (
      Math.abs(previous.x - next.x) > 0.001 &&
      Math.abs(previous.y - next.y) > 0.001
    ) {
      return false;
    }
  }
  return true;
}

function labelBoxesOverlapForTest(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
) {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}
