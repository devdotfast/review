import { describe, expect, it } from "vitest";

import { bundleReviewSoftwareMap } from "../../src/software-map-bundle";
import {
  type SoftwareModelData,
  hydrateSoftwareModel,
} from "../../src/software-map-model";
import { hydratePublishedSoftwareMap } from "./hydrate-published-software-map";

describe("hydratePublishedSoftwareMap", () => {
  it("rebuilds the head and base elementsByPath indexes", () => {
    const headElement: SoftwareModelData["elements"][number] = {
      type: "softwareSystem",
      id: "orders",
      path: "orders",
      label: "Orders",
      children: [],
    };
    const baseElement: SoftwareModelData["elements"][number] = {
      type: "container",
      id: "api",
      path: "orders.api",
      parentPath: "orders",
      label: "API",
      children: [],
    };
    const bundle = bundleReviewSoftwareMap({
      head: hydrateSoftwareModel({
        elements: [headElement],
        relationships: [],
      }),
      base: hydrateSoftwareModel({
        elements: [baseElement],
        relationships: [],
      }),
      headCommit: "a".repeat(40),
      baseCommit: "b".repeat(40),
    });
    const maps = hydratePublishedSoftwareMap({
      head: JSON.parse(bundle.headJson),
      base: JSON.parse(bundle.baseJson),
    });

    expect(maps.head.elementsByPath).toBeInstanceOf(Map);
    expect(maps.base.elementsByPath).toBeInstanceOf(Map);
    expect(maps.head.elementsByPath.get("orders")).toEqual(headElement);
    expect(maps.base.elementsByPath.get("orders.api")).toEqual(baseElement);
  });
});
