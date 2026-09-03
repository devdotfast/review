import { describe, expect, it } from "vitest";

import { collapseInlineC4Node, projectInlineC4 } from "./c4-projection";
import { defineSoftwareModel } from "./model";
import {
  C4_MAP_HOTKEY_GROUPS,
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
      "review-canvas-root",
      "review-app",
      "review-app--theme-light",
      "review-app--tint-slate",
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
