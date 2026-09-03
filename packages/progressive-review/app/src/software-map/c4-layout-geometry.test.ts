import { readFileSync } from "node:fs";

import type { Edge as ReactFlowEdge } from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";

import {
  C4LayoutQueue,
  c4EdgeEndpointBubbles,
  c4LayoutSignature,
  c4PreviousInlineLayoutForRelationships,
  c4ViewportForNodeReveal,
  createC4MapFlow,
  createC4MapFlowFromLayout,
  fitC4MapView,
  focusC4MapNode,
  focusC4MapNodeAndKeyboard,
  runInlineC4Layout,
  runSerializedC4Layout,
} from "./c4-layout-geometry";
import type { InlineC4LayoutResult } from "./c4-map-flow-types";
import { projectInlineC4 } from "./c4-projection";
import { defineSoftwareModel } from "./model";
import {
  initialSoftwareMapExpandedNodeIds,
  seedSoftwareMapDefaultExpandedNodeIds,
} from "./software-map-navigation-state";
import {
  type SoftwareMapNodeSnapshot,
  type SoftwareMapRelationshipSnapshot,
  softwareMapSnapshotFromInlineC4Projection,
} from "./software-map-snapshot";

type C4LayoutBoxForTest = {
  x: number;
  y: number;
  width: number;
  height: number;
};

describe("SoftwareMap C4 layout geometry", () => {
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
      new URL("./c4-layout-geometry.ts", import.meta.url),
      "utf8",
    );
    const softwareMapSource = readFileSync(
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
    expect(softwareMapSource).not.toContain("GhostWaypointBeads");
    expect(styles).not.toContain("software-map-c4-ghost-beads");
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
