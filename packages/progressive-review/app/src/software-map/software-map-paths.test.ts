import { describe, expect, it } from "vitest";

import {
  softwareMapLiveDiagram,
  softwareMapNodeLabelPath,
  softwareMapNodeTargetPayload,
  softwareMapRelationshipLabelPath,
} from "./software-map-paths";
import type { SoftwareMapNodeSnapshot } from "./software-map-snapshot";

describe("SoftwareMap thread-target paths", () => {
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
});
