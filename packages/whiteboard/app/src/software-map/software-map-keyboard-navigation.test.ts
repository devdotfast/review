import { describe, expect, it } from "vitest";

import { collapseInlineC4Node, projectInlineC4 } from "./c4-projection";
import { defineSoftwareModel } from "./model";
import {
  c4MapReactFlowInteractionProps,
  c4SpatialDirectionForKey,
  findSpatialC4Node,
  firstSoftwareMapChildNodeId,
  parentSoftwareMapNodeId,
  selectedSoftwareMapNodeIdForNodes,
  shouldAutoFocusC4MapKeyboardTarget,
  shouldShowSoftwareMapFloatingActions,
  softwareMapChildNodeIdForDrill,
  softwareMapNodeForKeyboardExpansion,
  softwareMapNodeIdForDrill,
  softwareMapOverlayClassName,
  softwareMapViewportFocusNodeId,
  softwareMapViewportFocusTargetReady,
  toggledSoftwareMapExpandedNodeIds,
  toggledSoftwareMapViewportFocusRequest,
} from "./software-map-keyboard-navigation";
import { softwareMapSnapshotFromInlineC4Projection } from "./software-map-snapshot";

describe("SoftwareMap keyboard navigation", () => {
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

  it("keeps expanded map portals inside the active review theme scope", () => {
    const classNames = softwareMapOverlayClassName({
      theme: "light",
      nodeTint: "slate",
    }).split(" ");

    expect(classNames).toEqual([
      "software-map-overlay",
      "whiteboard-canvas-root",
      "whiteboard-app",
      "whiteboard-app--theme-light",
      "whiteboard-app--tint-slate",
    ]);
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

  it("selects the first immediate child after expanding an inline C4 node", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveWhiteboard: {
          label: "Progressive Review",
          containers: {
            runtime: { label: "Runtime" },
            whiteboardApp: {
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
        "progressiveWhiteboard",
        "progressiveWhiteboard.whiteboardApp",
      ]),
      selectedNodeId: "progressiveWhiteboard",
    });

    const nodes =
      softwareMapSnapshotFromInlineC4Projection({
        projection,
      }).nodes ?? [];

    expect(
      firstSoftwareMapChildNodeId({
        nodes,
        parentId: "progressiveWhiteboard",
      }),
    ).toBe("progressiveWhiteboard.runtime");
    expect(
      firstSoftwareMapChildNodeId({
        nodes,
        parentId: "progressiveWhiteboard.whiteboardApp",
      }),
    ).toBe("progressiveWhiteboard.whiteboardApp.softwareMap");
  });

  it("prefers the remembered immediate child when drilling into an inline C4 level", () => {
    const nodes = [
      { id: "progressiveWhiteboard", parentId: null },
      {
        id: "progressiveWhiteboard.runtime",
        parentId: "progressiveWhiteboard",
      },
      {
        id: "progressiveWhiteboard.whiteboardApp",
        parentId: "progressiveWhiteboard",
      },
      {
        id: "progressiveWhiteboard.whiteboardApp.softwareMap",
        parentId: "progressiveWhiteboard.whiteboardApp",
      },
    ];

    expect(
      softwareMapChildNodeIdForDrill({
        nodes,
        parentId: "progressiveWhiteboard",
        rememberedChildNodeId: "progressiveWhiteboard.whiteboardApp",
      }),
    ).toBe("progressiveWhiteboard.whiteboardApp");
    expect(
      softwareMapChildNodeIdForDrill({
        nodes,
        parentId: "progressiveWhiteboard",
        rememberedChildNodeId:
          "progressiveWhiteboard.whiteboardApp.softwareMap",
      }),
    ).toBe("progressiveWhiteboard.runtime");
    expect(
      softwareMapChildNodeIdForDrill({
        nodes,
        parentId: "progressiveWhiteboard",
        rememberedChildNodeId: null,
      }),
    ).toBe("progressiveWhiteboard.runtime");
    expect(
      softwareMapNodeIdForDrill({
        node: { id: "progressiveWhiteboard", expanded: false },
        nodes,
        preferredChildNodeId: "progressiveWhiteboard.whiteboardApp",
      }),
    ).toBe("progressiveWhiteboard");
    expect(
      softwareMapNodeIdForDrill({
        node: { id: "progressiveWhiteboard", expanded: true },
        nodes,
        preferredChildNodeId: "progressiveWhiteboard.whiteboardApp",
      }),
    ).toBe("progressiveWhiteboard.whiteboardApp");
  });

  it("selects the visible parent when escaping an inline C4 level", () => {
    const nodes = [
      { id: "progressiveWhiteboard", parentId: null },
      {
        id: "progressiveWhiteboard.whiteboardApp",
        parentId: "progressiveWhiteboard",
      },
      {
        id: "progressiveWhiteboard.whiteboardApp.softwareMap",
        parentId: "progressiveWhiteboard.whiteboardApp",
      },
    ];

    expect(
      parentSoftwareMapNodeId({
        nodes,
        nodeId: "progressiveWhiteboard.whiteboardApp.softwareMap",
      }),
    ).toBe("progressiveWhiteboard.whiteboardApp");
    expect(
      parentSoftwareMapNodeId({
        nodes,
        nodeId: "progressiveWhiteboard",
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
          expandedNodeIds: new Set(["progressiveWhiteboard"]),
          node: {
            path: "progressiveWhiteboard.whiteboardApp",
            expandable: true,
            expanded: false,
          },
        }),
      ].sort(),
    ).toEqual(["progressiveWhiteboard", "progressiveWhiteboard.whiteboardApp"]);

    expect([
      ...toggledSoftwareMapExpandedNodeIds({
        expandedNodeIds: new Set([
          "progressiveWhiteboard",
          "progressiveWhiteboard.whiteboardApp",
          "progressiveWhiteboard.whiteboardApp.softwareMap",
        ]),
        node: {
          path: "progressiveWhiteboard.whiteboardApp",
          expandable: true,
          expanded: true,
        },
      }),
    ]).toEqual(["progressiveWhiteboard"]);

    expect([
      ...toggledSoftwareMapExpandedNodeIds({
        expandedNodeIds: new Set(["progressiveWhiteboard"]),
        node: {
          path: "progressiveWhiteboard.whiteboardApp.softwareMap.render",
          expandable: false,
          expanded: false,
        },
      }),
    ]).toEqual(["progressiveWhiteboard"]);

    const collapseFocus = toggledSoftwareMapViewportFocusRequest({
      id: "progressiveWhiteboard.whiteboardApp",
      expanded: true,
    });

    expect(collapseFocus).toEqual({
      nodeId: "progressiveWhiteboard.whiteboardApp",
      requireExpanded: false,
    });
    expect(
      softwareMapViewportFocusTargetReady({
        node: { id: "progressiveWhiteboard.whiteboardApp", expanded: false },
        viewportFocusNodeId: collapseFocus.nodeId,
        requireExpanded: collapseFocus.requireExpanded,
      }),
    ).toBe(true);
  });

  it("repairs child selection to the collapsed parent and requests parent focus", () => {
    const model = defineSoftwareModel({
      systems: {
        progressiveWhiteboard: {
          label: "Progressive Review",
          containers: {
            whiteboardApp: {
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
      "progressiveWhiteboard",
      "progressiveWhiteboard.whiteboardApp",
    ]);

    const expandedSnapshot = softwareMapSnapshotFromInlineC4Projection({
      projection: projectInlineC4({
        model,
        expandedNodeIds,
        selectedNodeId: "progressiveWhiteboard.whiteboardApp.softwareMap",
      }),
    });

    const parent = expandedSnapshot.nodes?.find(
      (node) => node.id === "progressiveWhiteboard.whiteboardApp",
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

    expect([...collapsedExpandedNodeIds]).toEqual(["progressiveWhiteboard"]);
    expect(selectedNodeId).toBe("progressiveWhiteboard.whiteboardApp");
    expect(viewportFocusRequest).toEqual({
      nodeId: "progressiveWhiteboard.whiteboardApp",
      requireExpanded: false,
    });
    expect(
      collapsedSnapshot.nodes?.some(
        (node) => node.id === "progressiveWhiteboard.whiteboardApp.softwareMap",
      ),
    ).toBe(false);
    expect(
      selectedSoftwareMapNodeIdForNodes({
        nodes: collapsedSnapshot.nodes ?? [],
        selectedNodeId,
      }),
    ).toBe("progressiveWhiteboard.whiteboardApp");
    expect(
      softwareMapViewportFocusTargetReady({
        node: { id: "progressiveWhiteboard.whiteboardApp", expanded: false },
        viewportFocusNodeId: viewportFocusRequest.nodeId,
        requireExpanded: viewportFocusRequest.requireExpanded,
      }),
    ).toBe(true);
  });

  it("resolves the selected C4 node for first-keypress tab expansion", () => {
    const nodes = [
      {
        id: "progressiveWhiteboard",
        expandable: true,
        expanded: false,
        path: "progressiveWhiteboard",
      },
      {
        id: "progressiveWhiteboard.whiteboardApp",
        expandable: true,
        expanded: false,
        path: "progressiveWhiteboard.whiteboardApp",
      },
    ];

    const selected = softwareMapNodeForKeyboardExpansion({
      nodes,
      selectedNodeId: "progressiveWhiteboard.whiteboardApp",
    });

    expect(selected?.id).toBe("progressiveWhiteboard.whiteboardApp");
    expect([
      ...toggledSoftwareMapExpandedNodeIds({
        expandedNodeIds: new Set(["progressiveWhiteboard"]),
        node: selected!,
      }),
    ]).toEqual([
      "progressiveWhiteboard",
      "progressiveWhiteboard.whiteboardApp",
    ]);
  });

  it("falls back to the focused React Flow node when selection has not flushed before Tab", () => {
    const nodes = [
      {
        id: "progressiveWhiteboard",
        expandable: true,
        expanded: true,
        path: "progressiveWhiteboard",
      },
    ];

    const selected = softwareMapNodeForKeyboardExpansion({
      nodes,
      selectedNodeId: null,
      focusedNodeId: "progressiveWhiteboard",
    });

    expect(selected?.id).toBe("progressiveWhiteboard");
    expect([
      ...toggledSoftwareMapExpandedNodeIds({
        expandedNodeIds: new Set(["progressiveWhiteboard"]),
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
      { id: "progressiveWhiteboard" },
      { id: "progressiveWhiteboard.runtime" },
    ];

    expect(
      softwareMapViewportFocusNodeId({
        nodes,
        viewportFocusNodeId: "progressiveWhiteboard",
      }),
    ).toBe("progressiveWhiteboard");
    expect(
      softwareMapViewportFocusNodeId({
        nodes,
        viewportFocusNodeId: null,
      }),
    ).toBe(null);
    expect(
      softwareMapViewportFocusTargetReady({
        node: { id: "progressiveWhiteboard", expanded: false },
        viewportFocusNodeId: "progressiveWhiteboard",
      }),
    ).toBe(false);
    expect(
      softwareMapViewportFocusTargetReady({
        node: { id: "progressiveWhiteboard", expanded: false },
        viewportFocusNodeId: "progressiveWhiteboard",
        requireExpanded: false,
      }),
    ).toBe(true);
    expect(
      softwareMapViewportFocusTargetReady({
        node: { id: "progressiveWhiteboard", expanded: true },
        viewportFocusNodeId: "progressiveWhiteboard",
      }),
    ).toBe(true);
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
